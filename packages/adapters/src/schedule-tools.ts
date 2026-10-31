import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import type { Actor, UpdateRoutineInput } from "@rakazo/contracts";
import { ScheduleUpdateToolInputSchema } from "@rakazo/contracts";
import {
  cronFromPreset,
  hasMixedOneShotSchedule,
  isOneShotRoutineCron,
  isOneShotRoutineCrons,
  MIN_ROUTINE_INTERVAL_MINUTES,
  nextCronDate,
  nextCronDateAcrossStrict,
  nextRoutineWakeAt,
  ONCE_ROUTINE_CRON,
  routineConditionError,
  routineIntervalError,
} from "@rakazo/core";
import type { PrismaClient, Routine, ThreadEvents } from "@rakazo/db";
import { IsolationError, Prisma, scoped } from "@rakazo/db";

export { isOneShotRoutineCron, ONCE_ROUTINE_CRON };

export const SCHEDULE_TOOL_NAMES = new Set([
  "schedule_create",
  "schedule_list",
  "schedule_update",
  "schedule_cancel",
]);

export function filterBuiltinToolsForRun<T extends { name: string }>(
  tools: T[],
  runTrigger: string,
): T[] {
  return runTrigger === "routine" ? tools.filter((tool) => tool.name !== "schedule_create") : tools;
}

/** Keep cross-bot messaging thread-specific while exposing schedules in DMs and groups. */
export function filterBuiltinToolsForThread<T extends { name: string }>(
  tools: T[],
  groupId: string | null | undefined,
): T[] {
  return tools.filter(
    (tool) =>
      (groupId || tool.name !== "handoff_to_bot") &&
      // In a group the room is the shared surface: hand the stage to a member
      // rather than starting a private thread off to one side.
      (!groupId || tool.name !== "message_bot") &&
      // Only the account-wide conversation sits above the role teams.
      (tool.name !== "delegate_to_role" || Boolean(groupId?.startsWith("recruiting-global-"))),
  );
}

type ScheduleUnit = "minutes" | "hours" | "days" | "seconds";

export type ResolvedSchedule =
  | { ok: true; cron: string; nextRunAt: Date; oneShot: boolean }
  | { ok: false; error: string };

/**
 * Providers sometimes serialize omitted optional tool fields as null or an empty
 * string. Treat those values as absent, while preserving numeric zero so the
 * normal validation can reject an invalid zero interval/delay with a useful
 * error instead of reporting two schedule modes at once.
 */
export function isScheduleValueProvided(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

export function compactScheduleInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => isScheduleValueProvided(value)),
  );
}

export function resolveScheduleTiming(
  input: {
    cron?: unknown;
    every?: unknown;
    unit?: unknown;
    runAt?: unknown;
    delayMinutes?: unknown;
    delaySeconds?: unknown;
  },
  timezone = "UTC",
): ResolvedSchedule {
  const hasRepeat =
    isScheduleValueProvided(input.cron) ||
    isScheduleValueProvided(input.every) ||
    isScheduleValueProvided(input.unit);
  const hasOneShot =
    isScheduleValueProvided(input.runAt) ||
    isScheduleValueProvided(input.delayMinutes) ||
    isScheduleValueProvided(input.delaySeconds);
  if (hasRepeat && hasOneShot) {
    return {
      ok: false,
      error: "Provide either a repeating schedule or a one-shot time, not both.",
    };
  }
  if (!hasRepeat && !hasOneShot) {
    return {
      ok: false,
      error:
        "Provide cron, every/unit for repeating schedules, or runAt/delayMinutes/delaySeconds for one-shot.",
    };
  }
  const hasCron = isScheduleValueProvided(input.cron);
  const hasInterval = isScheduleValueProvided(input.every) || isScheduleValueProvided(input.unit);
  if (hasCron && hasInterval) {
    return {
      ok: false,
      error: "Provide exactly one timing method: cron, or every and unit, not both.",
    };
  }

  if (hasOneShot) {
    const oneShotFields = [input.runAt, input.delayMinutes, input.delaySeconds].filter(
      isScheduleValueProvided,
    );
    if (oneShotFields.length !== 1) {
      return {
        ok: false,
        error:
          "Provide exactly one of runAt, delayMinutes, or delaySeconds for a one-shot schedule.",
      };
    }
    let nextRunAt: Date;
    if (isScheduleValueProvided(input.delaySeconds)) {
      const delaySeconds = Number(input.delaySeconds);
      if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
        return { ok: false, error: "delaySeconds must be a non-negative number." };
      }
      nextRunAt = new Date(Date.now() + delaySeconds * 1_000);
    } else if (isScheduleValueProvided(input.delayMinutes)) {
      const delayMinutes = Number(input.delayMinutes);
      if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
        return { ok: false, error: "delayMinutes must be a non-negative number." };
      }
      nextRunAt = new Date(Date.now() + delayMinutes * 60_000);
    } else {
      const parsed = new Date(String(input.runAt ?? ""));
      if (!Number.isFinite(parsed.getTime())) {
        return { ok: false, error: "runAt must be a valid ISO datetime." };
      }
      nextRunAt = parsed;
    }
    if (nextRunAt.getTime() <= Date.now()) {
      return { ok: false, error: "One-shot schedules must run in the future." };
    }
    return { ok: true, cron: ONCE_ROUTINE_CRON, nextRunAt, oneShot: true };
  }

  if (hasCron) {
    const cron = String(input.cron).trim();
    if (!cron) return { ok: false, error: "cron must be a non-empty 5-field cron expression." };
    if (isOneShotRoutineCron(cron)) {
      return {
        ok: false,
        error: "Use runAt, delayMinutes, or delaySeconds for one-shot schedules.",
      };
    }
    const intervalError = validateRepeatingCron(cron, timezone);
    if (intervalError) return { ok: false, error: intervalError };
    try {
      const nextRunAt = nextCronDate(cron, new Date(), timezone);
      return { ok: true, cron, nextRunAt, oneShot: false };
    } catch {
      return { ok: false, error: "cron must be a valid 5-field cron expression." };
    }
  }

  const every = Number(input.every);
  const unit = String(input.unit ?? "") as ScheduleUnit;
  if (!Number.isFinite(every) || every <= 0 || !Number.isInteger(every)) {
    return { ok: false, error: "every must be a positive whole number." };
  }
  if (unit === "seconds") {
    return { ok: false, error: `minimum interval is ${MIN_ROUTINE_INTERVAL_MINUTES} minutes` };
  }
  if (!["minutes", "hours", "days"].includes(unit)) {
    return { ok: false, error: 'unit must be "minutes", "hours", or "days".' };
  }
  if (unit === "minutes" && every < MIN_ROUTINE_INTERVAL_MINUTES) {
    return { ok: false, error: `minimum interval is ${MIN_ROUTINE_INTERVAL_MINUTES} minutes` };
  }
  const cron = cronFromPreset({ freq: "Interval", n: every, unit });
  const intervalError = validateRepeatingCron(cron, timezone);
  if (intervalError) return { ok: false, error: intervalError };
  try {
    const nextRunAt = nextCronDate(cron, new Date(), timezone);
    return { ok: true, cron, nextRunAt, oneShot: false };
  } catch {
    return { ok: false, error: "every/unit produced an invalid cron expression." };
  }
}

function validateRepeatingCron(cron: string, timezone?: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "cron must be a 5-field cron expression.";
  try {
    return routineIntervalError([cron], timezone);
  } catch {
    return "cron must be a valid 5-field cron expression.";
  }
}

export interface ScheduleToolDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
}

/** Persist and enqueue a bot routine that wakes in the originating thread. */
export async function createScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    name: string;
    prompt: string;
    timezone?: string;
    schedule: Record<string, unknown>;
  },
) {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name) return { error: "name is required." };
  if (!prompt) return { error: "prompt is required." };

  const timezone = String(input.timezone ?? "UTC");
  const resolved = resolveScheduleTiming(input.schedule, timezone);
  if (!resolved.ok) return { error: resolved.error };

  const row = await deps.prisma.routine.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      threadId: input.threadId,
      name,
      prompt,
      crons: [resolved.cron],
      timezone,
      notify: true,
      active: true,
      nextRunAt: resolved.nextRunAt,
    },
  });

  try {
    await deps.jobs.enqueue(routineWakeupJob(row.id, resolved.nextRunAt));
  } catch {
    try {
      await deps.prisma.routine.delete({ where: { id: row.id } });
    } catch {
      // Do not soft-return while the row may still be active.
      await deps.prisma.routine.update({
        where: { id: row.id },
        data: { active: false, nextRunAt: null },
      });
    }
    return { error: "Could not schedule the reminder. Try again." };
  }

  try {
    await deps.events.append({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "routine.created",
      payload: { name: row.name },
    });
  } catch {
    // Match routines.create: the reminder is live even if the thread signal fails.
  }

  return {
    ok: true as const,
    routineId: row.id,
    name: row.name,
    cron: row.crons[0],
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    oneShot: resolved.oneShot,
  };
}

/** List bot routines, optionally restricted to the current group thread. */
export async function listSchedulesFromTool(
  deps: Pick<ScheduleToolDeps, "prisma">,
  input: { spaceId: string; botId: string; userId: string; threadId?: string },
) {
  const rows = await deps.prisma.routine.findMany({
    where: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  return {
    routines: rows.map((row) => ({
      routineId: row.id,
      name: row.name,
      prompt: row.prompt,
      crons: row.crons,
      active: row.active,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      oneShot: isOneShotRoutineCrons(row.crons),
    })),
  };
}

/** Cancel a bot routine, optionally restricted to the current group thread. */
export async function cancelScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId?: string;
    routineId?: string;
    name?: string;
  },
) {
  const routineId = input.routineId?.trim();
  const name = input.name?.trim();
  if (!routineId && !name) {
    return { error: "Provide routineId or the exact schedule name to cancel." };
  }

  const existing = await deps.prisma.routine.findFirst({
    where: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(routineId ? { id: routineId } : { name: name! }),
    },
  });
  if (!existing) return { error: "Schedule not found." };

  await deps.prisma.routine.delete({ where: { id: existing.id } });
  await deps.jobs.cancel(routineJobKey(existing.id));
  return { ok: true as const, routineId: existing.id, name: existing.name };
}

export class RoutineUpdateError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT",
    options?: { message: string },
  ) {
    super(options?.message);
  }
}

type NativeScheduleContext = {
  actor: Actor;
  botId: string;
  threadId: string;
  groupId: string | null;
  runId: string;
  leaseOwner: string;
  leaseFence: number;
};

async function assertScheduleRun(client: Prisma.TransactionClient, native: NativeScheduleContext) {
  const run = scoped(
    native.actor,
    await client.run.findFirst({
      where: { id: native.runId, spaceId: native.actor.spaceId, userId: native.actor.userId },
      include: { thread: true },
    }),
  );
  scoped(native.actor, run.thread);
  if (
    run.botId !== native.botId ||
    run.threadId !== native.threadId ||
    run.status !== "running" ||
    run.leaseOwner !== native.leaseOwner ||
    run.leaseFence !== native.leaseFence ||
    !run.leaseExpiresAt ||
    run.leaseExpiresAt.getTime() <= Date.now() ||
    run.thread.groupId !== native.groupId ||
    (run.thread.botId && run.thread.botId !== native.botId)
  )
    throw new IsolationError();
  if (
    native.groupId &&
    !(await client.chatGroupMember.findFirst({
      where: { groupId: native.groupId, botId: native.botId, group: { archivedAt: null } },
    }))
  )
    throw new IsolationError();
}

async function readScopedRoutine(
  client: Prisma.TransactionClient,
  actor: Actor,
  routineId: string,
  native?: NativeScheduleContext,
) {
  // Archived bots keep their routines paused, so resolve an active parent before any write.
  const existing = await client.routine.findFirst({
    where: {
      id: routineId,
      ...(native
        ? { botId: native.botId, ...(native.groupId ? { threadId: native.threadId } : {}) }
        : {}),
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
    },
  });
  if (!existing) throw new RoutineUpdateError("NOT_FOUND");
  return existing;
}

export async function prepareScheduleUpdateFromTool(
  deps: Pick<ScheduleToolDeps, "prisma">,
  native: NativeScheduleContext,
  raw: unknown,
) {
  const { routineId, ...changes } = ScheduleUpdateToolInputSchema.parse(raw);
  await assertScheduleRun(deps.prisma, native);
  const existing = await readScopedRoutine(deps.prisma, native.actor, routineId, native);
  if (!existing.name?.trim())
    throw new RoutineUpdateError("BAD_REQUEST", { message: "Routine name is unavailable." });
  return { routineName: existing.name, ...changes };
}

export async function updateRoutine(
  deps: ScheduleToolDeps,
  actor: Actor,
  input: UpdateRoutineInput,
  options: {
    native?: NativeScheduleContext;
    assertModel?: (model: {
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
    }) => Promise<void>;
  } = {},
) {
  const native = options.native;
  const executeUpdate = async (client: Prisma.TransactionClient) => {
    const existing = await readScopedRoutine(client, actor, input.routineId, native);
    const bot = await client.bot.findFirst({
      where: { id: existing.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      include: { thread: true },
    });
    if (!bot) throw new RoutineUpdateError("NOT_FOUND");
    const active = input.active ?? existing.active;
    const crons = input.crons ?? existing.crons;
    const timezone = input.timezone ?? existing.timezone;
    const webhookEnabled = input.webhookEnabled ?? existing.webhookEnabled;
    const githubEnabled = input.githubEnabled ?? existing.githubEnabled;
    const messageProvider =
      input.messageProvider === undefined ? existing.messageProvider : input.messageProvider;
    const modelProvider =
      input.modelProvider === undefined ? existing.modelProvider : input.modelProvider;
    const modelId = input.modelId === undefined ? existing.modelId : input.modelId;
    const hasModel = Boolean(modelProvider && modelId);
    const modelChanged = modelProvider !== existing.modelProvider || modelId !== existing.modelId;
    const touchesModel =
      input.modelProvider !== undefined ||
      input.modelId !== undefined ||
      input.thinkingLevel !== undefined;
    if (Boolean(modelProvider) !== Boolean(modelId)) {
      throw new RoutineUpdateError("BAD_REQUEST", {
        message: "Model provider and model id must both be set or both cleared",
      });
    }
    if (input.thinkingLevel && !hasModel) {
      throw new RoutineUpdateError("BAD_REQUEST", {
        message: "Pick a model for this routine first",
      });
    }
    // A thinking level belongs to a model, so changing the model resets it.
    const thinkingLevel = !hasModel
      ? null
      : input.thinkingLevel === undefined
        ? modelChanged
          ? null
          : existing.thinkingLevel
        : input.thinkingLevel;
    if (modelChanged || input.thinkingLevel) {
      if (!options.assertModel)
        throw new RoutineUpdateError("BAD_REQUEST", {
          message: "Model edits require model validation.",
        });
      await options.assertModel({ modelProvider, modelId, thinkingLevel });
    }
    const recordTrigger =
      input.recordTrigger === undefined ? existing.recordTrigger : input.recordTrigger;
    if (
      crons.length === 0 &&
      !webhookEnabled &&
      !githubEnabled &&
      !messageProvider &&
      !recordTrigger
    ) {
      throw new RoutineUpdateError("BAD_REQUEST", {
        message: "Add a schedule, webhook, GitHub, message or record trigger",
      });
    }
    const optionError = routineOptionError({ ...input, crons, recordTrigger });
    if (optionError) throw new RoutineUpdateError("BAD_REQUEST", { message: optionError });
    if (input.shared !== undefined && existing.sharedFromId)
      throw new RoutineUpdateError("BAD_REQUEST", {
        message: "A copy of a shared routine can't be shared again.",
      });
    const intervalError =
      input.crons !== undefined
        ? routineIntervalError(crons, input.timezone ?? existing.timezone)
        : null;
    if (intervalError) throw new RoutineUpdateError("BAD_REQUEST", { message: intervalError });
    if (hasMixedOneShotSchedule(crons)) {
      throw new RoutineUpdateError("BAD_REQUEST", {
        message: "A one-time schedule can't be combined with other schedules.",
      });
    }
    if (active && isOneShotRoutineCrons(crons)) {
      if (!isOneShotRoutineCrons(existing.crons)) {
        throw new RoutineUpdateError("BAD_REQUEST", {
          message: "One-shot schedules must be created from chat.",
        });
      }
      if (existing.lastRunAt) {
        throw new RoutineUpdateError("BAD_REQUEST", {
          message: "This one-shot already ran.",
        });
      }
    }
    const activeChanged = active !== existing.active;
    const cronsChanged =
      input.crons !== undefined && JSON.stringify(input.crons) !== JSON.stringify(existing.crons);
    const timezoneChanged = input.timezone !== undefined && input.timezone !== existing.timezone;
    const scheduleChanged = (!existing.active && active) || cronsChanged || timezoneChanged;
    const recalculatedNextRunAt =
      crons.length > 0 &&
      !isOneShotRoutineCrons(crons) &&
      (scheduleChanged || (active && !existing.nextRunAt))
        ? nextRoutineDate(crons, timezone)
        : null;
    let armedOneShotAt: Date | null = null;
    if (active && isOneShotRoutineCrons(crons) && !existing.nextRunAt && !existing.lastRunAt) {
      if (!input.runAt) {
        throw new RoutineUpdateError("BAD_REQUEST", {
          message: "Add a run time for this one-shot.",
        });
      }
      const parsed = new Date(input.runAt);
      if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        throw new RoutineUpdateError("BAD_REQUEST", {
          message: "Run time must be in the future.",
        });
      }
      armedOneShotAt = parsed;
    } else if (input.runAt !== undefined) {
      throw new RoutineUpdateError("BAD_REQUEST", {
        message: "A run time is only for one-shots that have not run yet.",
      });
    }
    const recordTriggerChanged = recordTrigger !== existing.recordTrigger;
    const nextRunAt = !active
      ? null
      : recordTrigger
        ? recordTriggerChanged || !existing.nextRunAt
          ? nextRoutineWakeAt({ crons, timezone, recordTrigger }, new Date())
          : existing.nextRunAt
        : crons.length === 0
          ? null
          : isOneShotRoutineCrons(crons)
            ? (armedOneShotAt ?? existing.nextRunAt)
            : (recalculatedNextRunAt ?? existing.nextRunAt);
    const changesSchedule =
      activeChanged || scheduleChanged || armedOneShotAt !== null || recordTriggerChanged;
    // Re-check the parent in the write itself so an archive that lands after the read wins.
    // Model patches must also match the snapshot used to resolve omitted model fields.
    const row = await client.routine
      .update({
        where: {
          id: existing.id,
          ...(native
            ? {
                spaceId: actor.spaceId,
                userId: actor.userId,
                botId: native.botId,
                ...(native.groupId ? { threadId: native.threadId } : {}),
              }
            : {}),
          bot: { archivedAt: null },
          ...(changesSchedule
            ? {
                active: existing.active,
                crons: { equals: existing.crons },
                timezone: existing.timezone,
                nextRunAt: existing.nextRunAt,
                lastRunAt: existing.lastRunAt,
              }
            : {}),
          ...(touchesModel
            ? {
                modelProvider: existing.modelProvider,
                modelId: existing.modelId,
                thinkingLevel: existing.thinkingLevel,
              }
            : {}),
        },
        data: {
          name: input.name,
          prompt: input.prompt,
          ...(cronsChanged ? { crons } : {}),
          ...(timezoneChanged ? { timezone } : {}),
          ...(activeChanged ? { active } : {}),
          notify: input.notify,
          webhookEnabled: input.webhookEnabled,
          githubEnabled: input.githubEnabled,
          messageProvider: input.messageProvider,
          sessionMode: input.sessionMode,
          condition: input.condition === undefined ? undefined : input.condition || null,
          probeCommand: input.probeCommand === undefined ? undefined : input.probeCommand || null,
          recordTrigger: input.recordTrigger,
          shared: input.shared,
          ...(touchesModel ? { modelProvider, modelId, thinkingLevel } : {}),
          ...(changesSchedule ? { nextRunAt } : {}),
        },
      })
      .catch(async (error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
          if (
            (touchesModel || changesSchedule) &&
            (await client.routine.findFirst({
              where: {
                id: existing.id,
                spaceId: actor.spaceId,
                userId: actor.userId,
                bot: { archivedAt: null },
              },
              select: { id: true },
            }))
          ) {
            throw new RoutineUpdateError("CONFLICT", { message: "Routine changed; retry." });
          }
          throw new RoutineUpdateError("NOT_FOUND");
        }
        throw error;
      });

    if (native) await assertScheduleRun(client, native);
    return { row, existing, bot, scheduleChanged };
  };
  const updated = native
    ? await deps.prisma.$transaction(async (tx) => {
        // Wake inserts tasks/runs with thread FKs; keep their KEY SHARE locks compatible.
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "threads" WHERE "id" = ${native.threadId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR NO KEY UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "runs" WHERE "id" = ${native.runId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "routines" WHERE "id" = ${input.routineId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} AND "botId" = ${native.botId} FOR UPDATE`,
        );
        await assertScheduleRun(tx, native);
        return executeUpdate(tx);
      })
    : await executeUpdate(deps.prisma);
  const { row, existing, bot, scheduleChanged } = updated;
  const signalThreadId = native?.threadId ?? bot.thread?.id;
  if (signalThreadId) {
    await deps.events.append({
      spaceId: actor.spaceId,
      threadId: signalThreadId,
      botId: bot.id,
      type: "routine.updated",
      payload: { routineId: row.id, active: row.active },
    });
  }
  const scheduleNeedsSync =
    existing.active !== row.active || scheduleChanged || (!existing.nextRunAt && !!row.nextRunAt);
  if (scheduleNeedsSync) {
    if (row.active && row.nextRunAt) {
      await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
    } else {
      await deps.jobs.cancel(routineJobKey(row.id));
    }
  }

  if (row.shared) await syncSharedRoutineCopies(deps, row);
  return row;
}

/** Checks for the optional routine settings shared by create and update. */
export function routineOptionError(input: {
  condition?: string | null;
  crons?: string[];
  recordTrigger?: string | null;
}): string | undefined {
  if (input.recordTrigger && input.crons?.length)
    return "A record trigger can't be combined with a schedule.";
  if (input.condition) {
    const error = routineConditionError(input.condition);
    if (error) return `Condition: ${error}`;
  }
  return undefined;
}

/**
 * A shared routine's copies follow its instructions, schedule and options; each copy keeps its
 * own owner, bot, thread, model, notify and active state, and runs as that member.
 */
export async function syncSharedRoutineCopies(
  deps: Pick<ScheduleToolDeps, "prisma" | "jobs">,
  original: Routine,
) {
  const copies = await deps.prisma.routine.findMany({
    where: { sharedFromId: original.id, spaceId: original.spaceId },
  });
  for (const copy of copies) {
    const scheduleChanged =
      JSON.stringify(copy.crons) !== JSON.stringify(original.crons) ||
      copy.timezone !== original.timezone;
    const nextRunAt =
      copy.active && original.crons.length > 0 && !isOneShotRoutineCrons(original.crons)
        ? scheduleChanged || !copy.nextRunAt
          ? nextRoutineDate(original.crons, original.timezone)
          : copy.nextRunAt
        : null;
    const updated = await deps.prisma.routine.update({
      where: { id: copy.id },
      data: {
        name: original.name,
        prompt: original.prompt,
        crons: original.crons,
        timezone: original.timezone,
        sessionMode: original.sessionMode,
        condition: original.condition,
        probeCommand: original.probeCommand,
        recordTrigger: original.recordTrigger,
        nextRunAt,
      },
    });
    if (updated.active && updated.nextRunAt)
      await deps.jobs.enqueue(routineWakeupJob(updated.id, updated.nextRunAt));
    else await deps.jobs.cancel(routineJobKey(updated.id));
  }
}

export async function updateScheduleFromTool(
  deps: ScheduleToolDeps,
  native: NativeScheduleContext,
  raw: unknown,
) {
  const parsed = ScheduleUpdateToolInputSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };
  try {
    const row = await updateRoutine(deps, native.actor, parsed.data, { native });
    return {
      ok: true as const,
      routineId: row.id,
      name: row.name,
      prompt: row.prompt,
      crons: row.crons,
      timezone: row.timezone,
      active: row.active,
      notify: row.notify,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      oneShot: isOneShotRoutineCrons(row.crons),
    };
  } catch (error) {
    if (error instanceof RoutineUpdateError)
      return { error: error.message || "Schedule not found.", code: error.code };
    if (error instanceof IsolationError) return { error: "Schedule run is no longer available." };
    throw error;
  }
}

export function nextRoutineDate(crons: string[], timezone: string): Date {
  let next: Date | null;
  try {
    next = nextCronDateAcrossStrict(crons, new Date(), timezone);
  } catch {
    throw new RoutineUpdateError("BAD_REQUEST", { message: "Enter a valid cron expression." });
  }
  if (!next)
    throw new RoutineUpdateError("BAD_REQUEST", { message: "Enter a valid cron expression." });
  return next;
}
