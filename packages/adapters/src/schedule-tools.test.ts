import { DisabledBuiltinToolsSchema, ScheduleUpdateToolInputSchema } from "@rakazo/contracts";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import * as scheduleTools from "./schedule-tools.js";
import {
  cancelScheduleFromTool,
  compactScheduleInput,
  createScheduleFromTool,
  filterBuiltinToolsForRun,
  filterBuiltinToolsForThread,
  isOneShotRoutineCron,
  listSchedulesFromTool,
  resolveScheduleTiming,
  SCHEDULE_TOOL_NAMES,
} from "./schedule-tools.js";

describe("native routine updates", () => {
  it("registers an independently disableable update without model, trigger or runtime arguments", () => {
    expect(SCHEDULE_TOOL_NAMES.has("schedule_update")).toBe(true);
    expect(DisabledBuiltinToolsSchema.parse(["schedule_update"])).toEqual(["schedule_update"]);
    expect(builtinAgentTools.find((tool) => tool.name === "schedule_update")?.readOnly).toBe(false);
    const patch = { routineId: "routine", prompt: "Read the latest note" };
    expect(ScheduleUpdateToolInputSchema.parse(patch)).toEqual(patch);
    for (const field of [
      "botId",
      "threadId",
      "runId",
      "modelProvider",
      "webhookEnabled",
      "githubEnabled",
      "messageProvider",
    ]) {
      expect(
        ScheduleUpdateToolInputSchema.safeParse({ ...patch, [field]: "untrusted" }).success,
      ).toBe(false);
    }
  });
  it.each([
    "edit paused",
    "pause",
    "resume",
    "completed",
    "armed replacement",
    "foreign bot",
    "foreign group",
    "expired lease",
    "lease expired while waiting",
    "cancelled run",
    "wrong run bot",
    "removed group member",
    "past time",
    "schedule race",
    "job failure",
    "missing approval target",
    "blank approval name",
    "invalid approval input",
  ])("reuses the routine update boundary for %s", async (boundary) => {
    expect(scheduleTools.updateScheduleFromTool).toBeTypeOf("function");
    const actor = {
      spaceId: "space",
      userId: "owner",
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    const row = {
      id: "routine",
      ...actor,
      botId: "bot",
      threadId: "group-thread",
      name: boundary === "blank approval name" ? "  " : "Review",
      prompt: "Read saved results",
      crons: ["@once"],
      timezone: "UTC",
      active: boundary === "pause",
      notify: false,
      webhookEnabled: false,
      githubEnabled: false,
      messageProvider: null,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      nextRunAt:
        boundary === "pause" || boundary === "armed replacement"
          ? new Date(Date.now() + 60_000)
          : null,
      lastRunAt: boundary === "completed" ? new Date(1_000) : null,
    };
    const native = {
      actor,
      botId: "bot",
      threadId: "group-thread",
      groupId: "group",
      runId: "run",
      leaseOwner: "worker",
      leaseFence: 1,
    };
    const run = {
      ...actor,
      id: "run",
      botId: "bot",
      threadId: "group-thread",
      status: "running",
      leaseOwner: "worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(boundary === "expired lease" ? 0 : Date.now() + 60_000),
      thread: { ...actor, id: "group-thread", botId: null, groupId: "group" },
    };
    if (boundary === "cancelled run") run.status = "cancelled";
    if (boundary === "wrong run bot") run.botId = "other-bot";
    let transaction = false;
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      expect(transaction).toBe(true);
      if (boundary === "schedule race")
        throw Object.assign(new Error("not found"), { code: "P2025" });
      Object.assign(
        row,
        Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
      );
      return { ...row };
    });
    const tx = {
      $queryRaw: vi.fn(async (query?: unknown) => {
        if (
          boundary === "lease expired while waiting" &&
          (query as { sql: string }).sql.includes('FROM "routines"')
        )
          run.leaseExpiresAt = new Date(0);
        return [{ id: "group-thread" }];
      }),
      run: { findFirst: vi.fn(async () => run) },
      chatGroupMember: {
        findFirst: vi.fn(async () =>
          boundary === "removed group member" ? null : { botId: "bot" },
        ),
      },
      bot: {
        findFirst: vi.fn(async () => ({ ...actor, id: "bot", thread: { id: "bot-thread" } })),
      },
      routine: {
        findFirst: vi.fn(async ({ where }: { where: { botId?: string; threadId?: string } }) =>
          (boundary === "foreign bot" && where.botId) ||
          (boundary === "foreign group" && where.threadId) ||
          boundary === "missing approval target"
            ? null
            : { ...row },
        ),
        update,
      },
    };
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => {
        transaction = true;
        try {
          return await fn(tx);
        } finally {
          transaction = false;
        }
      }),
    };
    const enqueue = vi.fn(async () => {
      expect(transaction).toBe(false);
      if (boundary === "job failure") throw new Error("job unavailable");
    });
    const cancel = vi.fn(async () => {
      expect(transaction).toBe(false);
    });
    const deps = {
      prisma,
      jobs: { enqueue, cancel },
      events: { append: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof scheduleTools.updateScheduleFromTool>[0];
    const patch =
      boundary === "edit paused"
        ? { prompt: "Use the latest saved note" }
        : boundary === "pause"
          ? { active: false }
          : {
              ...(boundary === "resume"
                ? {
                    name: "Renamed review",
                    prompt: "Read the latest note\nKeep exact text",
                    crons: ["@once"],
                    timezone: "UTC",
                    notify: false,
                  }
                : {}),
              active: true,
              runAt: new Date(boundary === "past time" ? 0 : Date.now() + 120_000).toISOString(),
            };
    const approval = scheduleTools.prepareScheduleUpdateFromTool(deps, native, {
      routineId: "routine",
      ...patch,
      ...(boundary === "invalid approval input" ? { botId: "untrusted" } : {}),
    });
    if (
      [
        "foreign bot",
        "foreign group",
        "expired lease",
        "cancelled run",
        "wrong run bot",
        "removed group member",
        "missing approval target",
        "blank approval name",
        "invalid approval input",
      ].includes(boundary)
    ) {
      await expect(approval).rejects.toThrow();
    } else {
      expect(await approval).toEqual({ routineName: row.name, ...patch });
      expect(tx.routine.findFirst).toHaveBeenCalledWith({
        where: {
          id: "routine",
          botId: "bot",
          threadId: "group-thread",
          spaceId: actor.spaceId,
          userId: actor.userId,
          bot: { archivedAt: null },
        },
      });
    }
    expect(update).not.toHaveBeenCalled();
    expect(deps.events.append).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    if (
      ["missing approval target", "blank approval name", "invalid approval input"].includes(
        boundary,
      )
    )
      return;
    const call = () =>
      scheduleTools.updateScheduleFromTool(deps, native, { routineId: "routine", ...patch });
    if (boundary === "job failure") {
      await expect(call()).rejects.toThrow("job unavailable");
      expect(row.active).toBe(true);
      expect(update).toHaveBeenCalledOnce();
      return;
    }
    const result = await call();
    if (
      [
        "completed",
        "armed replacement",
        "foreign bot",
        "foreign group",
        "expired lease",
        "lease expired while waiting",
        "cancelled run",
        "wrong run bot",
        "removed group member",
        "past time",
        "schedule race",
      ].includes(boundary)
    ) {
      expect(result).toHaveProperty("error");
      expect(enqueue).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      if (boundary !== "schedule race") expect(update).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ ok: true, routineId: "routine", active: boundary === "resume" });
    expect((tx.$queryRaw.mock.calls[0]![0] as { sql: string }).sql).toContain("FOR NO KEY UPDATE");
    expect(row.threadId).toBe("group-thread");
    if (boundary === "edit paused") {
      expect(update.mock.calls[0]![0].data).not.toHaveProperty("active");
      expect(update.mock.calls[0]![0].data).not.toHaveProperty("nextRunAt");
      expect(enqueue).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    } else if (boundary === "pause") expect(cancel).toHaveBeenCalledWith("routine:routine");
    else expect(enqueue).toHaveBeenCalledOnce();
  });
});

describe("resolveScheduleTiming", () => {
  it("rejects repeating intervals under one minute", () => {
    expect(resolveScheduleTiming({ every: 2, unit: "seconds" })).toEqual({
      ok: false,
      error: "minimum interval is 1 minute",
    });
  });

  it("accepts every 1 minute", () => {
    const result = resolveScheduleTiming({ every: 1, unit: "minutes" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe("*/1 * * * *");
    expect(result.oneShot).toBe(false);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts cron every minute", () => {
    const result = resolveScheduleTiming({ cron: "*/1 * * * *" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe("*/1 * * * *");
    expect(result.oneShot).toBe(false);
  });

  it("creates one-shot schedules with @once cron", () => {
    const result = resolveScheduleTiming({ delayMinutes: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe(ONCE_ROUTINE_CRON);
    expect(result.oneShot).toBe(true);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it("allows sub-minute one-shot delays via delaySeconds", () => {
    const result = resolveScheduleTiming({ delaySeconds: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe(ONCE_ROUTINE_CRON);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it("rejects one-shot schedules in the past", () => {
    expect(resolveScheduleTiming({ runAt: new Date(Date.now() - 60_000).toISOString() })).toEqual({
      ok: false,
      error: "One-shot schedules must run in the future.",
    });
  });

  it("rejects fractional repeat intervals", () => {
    expect(resolveScheduleTiming({ every: 1.5, unit: "minutes" })).toEqual({
      ok: false,
      error: "every must be a positive whole number.",
    });
  });

  it("rejects malformed cron expressions", () => {
    expect(resolveScheduleTiming({ cron: "*/5 *" })).toEqual({
      ok: false,
      error: "cron must be a 5-field cron expression.",
    });
    expect(resolveScheduleTiming({ cron: "foo * * * *" })).toEqual({
      ok: false,
      error: "cron must be a valid 5-field cron expression.",
    });
  });

  it("rejects mixing repeat and one-shot fields", () => {
    expect(resolveScheduleTiming({ cron: "0 9 * * *", delayMinutes: 5 })).toEqual({
      ok: false,
      error: "Provide either a repeating schedule or a one-shot time, not both.",
    });
  });

  it("rejects two repeating timing methods", () => {
    expect(resolveScheduleTiming({ cron: "0 9 * * *", every: 1, unit: "hours" })).toEqual({
      ok: false,
      error: "Provide exactly one timing method: cron, or every and unit, not both.",
    });
  });

  it("ignores null and empty optional fields from model serializers", () => {
    const repeating = resolveScheduleTiming({
      cron: "0 9 * * *",
      every: null,
      unit: "",
      delayMinutes: null,
      runAt: "",
    });
    expect(repeating.ok).toBe(true);
    if (!repeating.ok) return;
    expect(repeating.oneShot).toBe(false);

    const oneShot = resolveScheduleTiming({
      cron: null,
      every: null,
      unit: "",
      delayMinutes: 10,
      delaySeconds: null,
    });
    expect(oneShot.ok).toBe(true);
    if (!oneShot.ok) return;
    expect(oneShot.oneShot).toBe(true);
  });

  it("keeps zero values for normal validation instead of treating them as absent", () => {
    expect(resolveScheduleTiming({ every: 0, unit: "minutes" })).toEqual({
      ok: false,
      error: "every must be a positive whole number.",
    });
    expect(compactScheduleInput({ every: 0, unit: "minutes", cron: null, runAt: "" })).toEqual({
      every: 0,
      unit: "minutes",
    });
  });
});

describe("filterBuiltinToolsForThread", () => {
  const tools = [
    { name: "handoff_to_bot" },
    { name: "message_bot" },
    { name: "schedule_create" },
    { name: "schedule_list" },
    { name: "schedule_cancel" },
    { name: "remember" },
  ];

  it("keeps handoff and schedule tools in groups", () => {
    expect(filterBuiltinToolsForThread(tools, "group-1").map((tool) => tool.name)).toEqual([
      "handoff_to_bot",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
    expect(filterBuiltinToolsForThread(tools, null).map((tool) => tool.name)).toEqual([
      "message_bot",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
  });

  it("hides schedule creation from routine runs without removing schedule management", () => {
    expect(filterBuiltinToolsForRun(tools, "routine").map((tool) => tool.name)).toEqual([
      "handoff_to_bot",
      "message_bot",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
    expect(filterBuiltinToolsForRun(tools, "user").map((tool) => tool.name)).toContain(
      "schedule_create",
    );
  });

  it("composes thread then run filters without dropping group schedule tools", () => {
    const groupTools = filterBuiltinToolsForRun(
      filterBuiltinToolsForThread(tools, "group-1"),
      "routine",
    ).map((tool) => tool.name);
    expect(groupTools).toEqual(["handoff_to_bot", "schedule_list", "schedule_cancel", "remember"]);
    expect(
      filterBuiltinToolsForRun(filterBuiltinToolsForThread(tools, "group-1"), "user").map(
        (tool) => tool.name,
      ),
    ).toContain("schedule_create");
  });

  it("covers every schedule tool name", () => {
    for (const name of SCHEDULE_TOOL_NAMES) {
      expect(filterBuiltinToolsForThread([{ name }, { name: "remember" }], "group-1")).toEqual([
        { name },
        { name: "remember" },
      ]);
    }
  });
});

describe("isOneShotRoutineCron", () => {
  it("detects the one-shot sentinel", () => {
    expect(isOneShotRoutineCron(ONCE_ROUTINE_CRON)).toBe(true);
    expect(isOneShotRoutineCron("0 9 * * *")).toBe(false);
  });
});

describe("schedule tool persistence", () => {
  it("creates routines with routine.created and enqueues wakeup", async () => {
    const append = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-1",
      ...args.data,
      nextRunAt: args.data.nextRunAt,
    }));
    const deps = {
      prisma: { routine: { create } },
      events: { append },
      jobs: { enqueue, cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toMatchObject({ ok: true, routineId: "routine-1", cron: "*/1 * * * *" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spaceId: "ws-1",
          userId: "user-1",
          threadId: "thread-1",
          crons: ["*/1 * * * *"],
          active: true,
        }),
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.created", payload: { name: "Morning joke" } }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("keeps the routine when event append fails after enqueue", async () => {
    const cancel = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: remove,
        },
      },
      events: {
        append: vi.fn(async () => {
          throw new Error("event failed");
        }),
      },
      jobs: { enqueue: vi.fn(async () => undefined), cancel },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toMatchObject({ ok: true, routineId: "routine-1" });
    expect(cancel).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("rolls back routine when enqueue fails", async () => {
    const remove = vi.fn(async () => undefined);
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: remove,
        },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toEqual({ error: "Could not schedule the reminder. Try again." });
    expect(remove).toHaveBeenCalledWith({ where: { id: "routine-1" } });
  });

  it("deactivates when enqueue fails and delete also fails", async () => {
    const update = vi.fn(async () => undefined);
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: vi.fn(async () => {
            throw new Error("delete failed");
          }),
          update,
        },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toEqual({ error: "Could not schedule the reminder. Try again." });
    expect(update).toHaveBeenCalledWith({
      where: { id: "routine-1" },
      data: { active: false, nextRunAt: null },
    });
  });

  it("propagates when enqueue rollback cannot deactivate", async () => {
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: vi.fn(async () => {
            throw new Error("delete failed");
          }),
          update: vi.fn(async () => {
            throw new Error("deactivate failed");
          }),
        },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    await expect(
      createScheduleFromTool(deps, {
        spaceId: "ws-1",
        botId: "bot-1",
        userId: "user-1",
        threadId: "thread-1",
        name: "Morning joke",
        prompt: "Tell a joke",
        schedule: { every: 1, unit: "minutes" },
      }),
    ).rejects.toThrow("deactivate failed");
  });

  it("scopes group list and cancel to the current thread without narrowing DMs", async () => {
    const findMany = vi.fn(async () => []);
    const findFirst = vi.fn(async () => null);
    const deps = {
      prisma: {
        routine: { findMany, findFirst, delete: vi.fn(async () => undefined) },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof cancelScheduleFromTool>[0];

    await listSchedulesFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "group-thread-1",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          threadId: "group-thread-1",
        },
      }),
    );

    const cancelled = await cancelScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "group-thread-1",
      routineId: "routine-1",
    });
    expect(cancelled).toEqual({ error: "Schedule not found." });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          threadId: "group-thread-1",
          id: "routine-1",
        },
      }),
    );

    findMany.mockClear();
    await listSchedulesFromTool(deps, { spaceId: "ws-1", botId: "bot-1", userId: "user-1" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws-1", botId: "bot-1", userId: "user-1" },
      }),
    );

    findFirst.mockClear();
    await cancelScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      routineId: "routine-1",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws-1", botId: "bot-1", userId: "user-1", id: "routine-1" },
      }),
    );
  });
});
