import type { AgentMessage, HarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
  AgentRuntimeEvent,
  AgentToolCompletion,
  JobPublisher,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";
import { notificationRetryJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { UsageRecordedPayloadSchema } from "@rakazo/contracts";
import {
  appendTextSegment,
  appendToolCallSegment,
  callIdFromClientNonce,
  completeToolStep,
  createStreamingRedactor,
  createVendorNameStream,
  hideVendorBlocks,
  isBackgroundRunTrigger,
  redactSecrets,
  truncatedPlainText,
  workActivityForTool,
  workStepDetail,
} from "@rakazo/core";
import type { AppendEventInput, Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  appendEventsInTransaction,
  cancelRunsInTransaction,
  completedRunSummary,
  createThreadMessageInTransaction,
  recordUsage,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isToolPauseResult } from "../approval-effect.js";
import { sanitizeConnectorError } from "../connector-safety.js";
import { estimateCatalogTokenCostUsd } from "../pi-models.js";
import { normalizePiUsage } from "../pi-usage.js";
import type { TurnWork } from "../turn-report.js";

/**
 * Agent output projected into the rows the web app reads: `tasks`, `runs`, `messages`, `events`
 * and `usage_records`. The runtime-event writers the run loop in executor.ts uses live here too,
 * so both paths write the same shapes.
 */

export interface RunProjectionDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "append" | "notify" | "publishTransient">;
  jobs: Pick<JobPublisher, "enqueue">;
  notifications?: NotificationProvider;
  /** Secret values that never reach a projected row. */
  secrets?: string[];
  /** Supplier names are hidden from what the recruiter sees. */
  hideVendors?: boolean;
}

/** The (thread, agent) whose lane this projection writes for. */
export interface RunProjectionKey {
  spaceId: string;
  userId: string;
  threadId: string;
  botId: string;
}

/** The input that started a run: its trigger and the message it answers. */
export interface RunInput {
  trigger: string;
  sourceMessageId?: string | null;
  prompt?: string;
  /** The answer to the card the agent's waiting run showed: this run continues that one. */
  cardAnswer?: boolean;
}

/** `input` is required on `run_start`; other events need nothing. */
export interface RunProjectionContext {
  input?: RunInput;
}

/** A user message handed to Pi, carrying the ids of the rows it came from. */
export type RakazoUserMessage = UserMessage & { rakazoInputId?: string; rakazoMessageId?: string };

interface RunTarget {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
}

/** A tool step as the reply's steps block and the `agent.tool.called` row record it. */
export interface ToolStepStart {
  name: string;
  executionId: string;
  args: Record<string, unknown>;
  startedAt: string;
  activity: string;
  detail?: string;
}

/** The topic a step may show beside its label, as a payload field. */
export function stepDetail(name: string, args: unknown): { detail?: string } {
  const detail = workStepDetail(name, args);
  return detail ? { detail } : {};
}

function isAuditableToolResult(value: unknown): value is {
  kind: "agent_tool_result";
  content: unknown[];
  details: unknown;
} {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "agent_tool_result" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function isFailedToolResult(value: unknown): value is { error: unknown } {
  if (!value || typeof value !== "object" || !("error" in value)) return false;
  const error = (value as { error?: unknown }).error;
  return error !== undefined && error !== null;
}

/**
 * Tools can return an `error` or MCP `isError: true` instead of throwing. Pi keeps that
 * result in `details` without populating `completion.error`. Read the failure for auditing
 * without changing the result that reaches the model and lets it react to the failure.
 */
export function toolResultError(result: unknown): unknown {
  const payload = (result as { details?: unknown } | null)?.details ?? result;
  if (isFailedToolResult(payload)) {
    const message = (payload.error as { message?: unknown })?.message;
    return typeof message === "string" ? message : payload.error;
  }
  if (!payload || typeof payload !== "object") return undefined;
  if ((payload as { isError?: unknown }).isError !== true) return undefined;
  const content = (payload as { content?: unknown }).content;
  const text = Array.isArray(content)
    ? content
        .map((part) => (part as { text?: unknown } | null)?.text)
        .filter((value): value is string => typeof value === "string")
        .join("\n")
        .trim()
    : "";
  return text || "tool reported an error result";
}

export function toolCompletionFromResult(
  base: Pick<AgentToolCompletion, "name" | "executionId" | "durationMs">,
  result: unknown,
): AgentToolCompletion {
  const paused = isToolPauseResult(result);
  if (isFailedToolResult(result)) return { ...base, error: result.error, paused };
  return { ...base, result, paused };
}

/** A contact lookup's counts only (no people), so its cost is auditable. */
function contactLookupCounts(result: unknown) {
  const object = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const summary = [result, object(result)?.details, object(result)?.result]
    .map((value) => object(object(value)?.structuredContent))
    .find((value) => value?.source === "local_contact_lookup")?.summary;
  const counts = Object.entries(object(summary) ?? {}).filter(
    ([, value]) => typeof value === "number",
  );
  return counts.length ? Object.fromEntries(counts) : undefined;
}

export function toolCompletionAuditPayload(
  completion: AgentToolCompletion,
  secrets: string[] = [],
): Record<string, unknown> {
  const durationMs = Number.isFinite(completion.durationMs)
    ? Math.max(0, Math.round(completion.durationMs))
    : 0;
  const error =
    completion.error === undefined ? toolResultError(completion.result) : completion.error;
  const payload: Record<string, unknown> = {
    name: redactSecrets(completion.name, secrets),
    executionId: redactSecrets(completion.executionId, secrets),
    durationMs,
    outcome: completion.paused ? "paused" : error === undefined ? "succeeded" : "error",
  };
  if (error !== undefined) {
    payload.error = sanitizeConnectorError(error, secrets);
  }
  const lookup = contactLookupCounts(completion.result);
  if (lookup) payload.lookup = lookup;
  if (!isAuditableToolResult(completion.result)) return payload;

  payload.contentTypes = completion.result.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const type = (part as { type?: unknown }).type;
    return type === "text" || type === "image" ? [type] : [];
  });
  const details = completion.result.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return payload;
  }
  const record = details as Record<string, unknown>;
  if (typeof record.frameId === "string") {
    payload.frameId = redactSecrets(record.frameId, secrets);
  }
  if (typeof record.capturedAt === "string") {
    payload.capturedAt = record.capturedAt;
  }
  if (typeof record.width === "number" && Number.isFinite(record.width)) {
    payload.width = record.width;
  }
  if (typeof record.height === "number" && Number.isFinite(record.height)) {
    payload.height = record.height;
  }
  return payload;
}

/** Timing shares the existing audit log; a missing diagnostic must never fail paid work. */
export async function appendUsageTimingAudit(
  deps: { events: Pick<ThreadEvents, "append"> },
  target: { spaceId: string; threadId: string; botId: string; runId: string },
  event: Extract<AgentRuntimeEvent, { type: "usage" }>,
): Promise<void> {
  const payload = UsageRecordedPayloadSchema.safeParse({
    callId: event.callId,
    ...event.timing,
  });
  if (!payload.success) return;
  try {
    await deps.events.append({
      ...target,
      type: "usage.recorded",
      payload: payload.data,
      allowCancelledRun: true,
    });
  } catch {
    getLogger().warn("model timing audit append failed");
  }
}

export async function appendToolCompletionAudit(
  deps: { events: Pick<ThreadEvents, "append"> },
  target: { spaceId: string; threadId: string; botId: string; runId: string },
  completion: AgentToolCompletion & { work?: TurnWork | undefined },
  secrets: string[] = [],
  onPayload?: (payload: Record<string, unknown>) => void,
): Promise<void> {
  try {
    const payload = toolCompletionAuditPayload(completion, secrets);
    // The durable receipt later turns and the router read as working state.
    if (completion.work && payload.outcome === "succeeded") payload.work = completion.work;
    onPayload?.(payload);
    await deps.events.append({
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      runId: target.runId,
      type: "agent.tool.completed",
      payload: {
        ...payload,
        // Lets open workbenches refresh after a connector write instead of at run end.
        ...(completion.readOnly === false && payload.outcome === "succeeded"
          ? { wrote: true }
          : {}),
      },
    });
  } catch (error) {
    // Audit persistence must not change the tool result or strand the run.
    getLogger().warn("agent tool completion audit append failed", {
      detail: sanitizeConnectorError(error, secrets),
      tool: redactSecrets(completion.name, secrets),
      executionId: redactSecrets(completion.executionId, secrets),
    });
  }
}

export async function runNotificationsEnabled(
  prisma: PrismaClient,
  run: { spaceId: string; userId: string; botId: string; threadId: string },
): Promise<boolean> {
  return (await runNotice(prisma, run)).enabled;
}

async function runNotice(
  prisma: PrismaClient,
  run: { spaceId: string; userId: string; botId: string; threadId: string },
): Promise<{ enabled: boolean; groupId: string | null }> {
  const source = await prisma.run.findFirst({
    where: {
      botId: run.botId,
      threadId: run.threadId,
      spaceId: run.spaceId,
      userId: run.userId,
    },
    select: {
      bot: { select: { notifyOnFinish: true } },
      thread: { select: { groupId: true } },
    },
  });
  if (!source) return { enabled: false, groupId: null };
  return {
    enabled: Boolean(source.thread.groupId || source.bot.notifyOnFinish),
    groupId: source.thread.groupId,
  };
}

/** A routine announces that it finished only when its own notify setting is on. */
export async function routineNotifies(prisma: PrismaClient, runId: string): Promise<boolean> {
  const run = await prisma.run
    .findUnique({
      where: { id: runId },
      select: { routine: { select: { notify: true } } },
    })
    .catch((error) => {
      getLogger().error("routine notification lookup", error);
      return null;
    });
  return run?.routine?.notify ?? true;
}

export async function notifyRun(
  deps: Pick<RunProjectionDeps, "prisma" | "notifications" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    trigger: string;
  },
  message: NotificationMessage,
) {
  if (
    !deps.notifications ||
    (isBackgroundRunTrigger(run.trigger) && message.kind !== "help" && message.kind !== "takeover")
  )
    return;
  const notice = await runNotice(deps.prisma, run).catch((error) => {
    getLogger().error("notification preference lookup", error);
    return null;
  });
  if (!notice?.enabled) return;
  if (
    message.kind === "completion" &&
    run.trigger === "routine" &&
    !(await routineNotifies(deps.prisma, run.id))
  )
    return;
  const routed = notice.groupId ? { ...message, groupId: notice.groupId } : message;
  await sendRunNotification(deps.notifications, run, routed).catch(async (error) => {
    getLogger().error("run notification", error);
    // A failed push is retried by the job queue instead of being lost.
    await deps.jobs
      .enqueue(
        notificationRetryJob(
          { runId: run.id, message: routed },
          new Date(Date.now() + NOTIFICATION_RETRY_DELAY_MS),
        ),
      )
      .catch((enqueueError) => getLogger().error("run notification retry", enqueueError));
  });
}

const NOTIFICATION_RETRY_DELAY_MS = 30_000;

export function sendRunNotification(
  notifications: NotificationProvider,
  run: { id: string; spaceId: string; userId: string; botId: string },
  message: NotificationMessage,
): Promise<void> {
  return notifications.send(message, {
    operationId: "notify",
    traceId: run.botId,
    runId: run.id,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    signal: AbortSignal.timeout(30_000),
  });
}

const ARGS_SUMMARY_SECRET_KEY = /secret|token|password|credential|authorization|api[_-]?key/i;

/** One bounded line of top-level scalar arguments for audit; secret-like keys and payloads stay out. */
export function toolArgsSummary(args: unknown, secrets: string[] = []): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (ARGS_SUMMARY_SECRET_KEY.test(key)) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      continue;
    const text = String(value).replace(/\s+/g, " ").trim();
    parts.push(`${key}=${text.length > 40 ? `${text.slice(0, 40)}…` : text}`);
  }
  const line = redactSecrets(parts.join(", "), secrets);
  if (!line) return undefined;
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

export function runSendsFinishNotification(trigger: string, continuationPending = false): boolean {
  return !continuationPending && trigger !== "created" && !isBackgroundRunTrigger(trigger);
}

const COMPLETION_NOTIFICATION_MAX_CHARS = 180;

/** Push body: Markdown stripped, then truncated so a cut cannot land inside a marker. */
export function completionNotificationPreview(text: string): string {
  return truncatedPlainText(text, COMPLETION_NOTIFICATION_MAX_CHARS);
}

export function redactBlocks(
  blocks: MessageBlock[],
  secrets: string[],
  hideVendors = false,
): MessageBlock[] {
  const redacted = blocks.map((block) => {
    if (block.kind === "text") {
      return {
        kind: "text" as const,
        text: redactSecrets(block.text, secrets),
      };
    }
    if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
      return { ...block, text: redactSecrets(block.text, secrets) };
    }
    return block;
  });
  return hideVendors ? hideVendorBlocks(redacted) : redacted;
}

export async function publishMessage(
  deps: Pick<RunProjectionDeps, "prisma" | "events">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    trigger: string;
  },
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
  markUnread: boolean | undefined = run.trigger === "bot_message" ? false : undefined,
  clientNonce?: string,
) {
  if (isBackgroundRunTrigger(run.trigger)) {
    blocks = blocks.filter((block) => block.kind === "ask" || block.kind === "computer");
    if (blocks.length === 0) return null;
  }
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction((tx) =>
      persistMessageInTransaction(tx, run, role, blocks, markUnread, clientNonce),
    ),
  );
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("thread message realtime notification", error);
  });
  return committed.message;
}

export async function persistMessageInTransaction(
  tx: Prisma.TransactionClient,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
  markUnread?: boolean,
  clientNonce?: string,
) {
  const message = await createThreadMessageInTransaction(tx, {
    threadId: run.threadId,
    role,
    blocks,
    botId: run.botId,
    runId: run.id,
    markUnread,
    clientNonce,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.message.created",
    runId: run.id,
    payload: {
      messageId: message.id,
      role,
      blocks,
      callId: callIdFromClientNonce(clientNonce),
    },
  });
  return { message, eventSeq: event.seq };
}

/** The `agent.tool.called` row a step and the activity feed are drawn from. */
export async function appendToolCalledEvent(
  deps: { events: Pick<ThreadEvents, "append"> },
  target: RunTarget,
  step: ToolStepStart,
  secrets: string[] = [],
): Promise<void> {
  await deps.events.append({
    ...target,
    type: "agent.tool.called",
    payload: {
      name: step.name,
      executionId: step.executionId,
      startedAt: step.startedAt,
      category: step.activity,
      ...(step.detail ? { detail: step.detail } : {}),
      ...(typeof step.args.roleId === "string" ? { roleId: step.args.roleId } : {}),
      argsSummary: toolArgsSummary(step.args, secrets),
    },
  });
}

/** One model call's usage row, then its timing audit. A failure is logged and never thrown. */
export async function recordRunUsage(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "append"> },
  target: RunTarget & { userId: string },
  event: Extract<AgentRuntimeEvent, { type: "usage" }>,
): Promise<void> {
  await recordUsage(
    deps.prisma,
    event,
    {
      spaceId: target.spaceId,
      botId: target.botId,
      userId: target.userId,
      runId: target.runId,
      parentRunId: target.runId,
      operationId: target.runId,
    },
    estimateCatalogTokenCostUsd,
  )
    .then(() =>
      appendUsageTimingAudit(
        deps,
        {
          spaceId: target.spaceId,
          threadId: target.threadId,
          botId: target.botId,
          runId: target.runId,
        },
        event,
      ),
    )
    .catch((error) =>
      getLogger().warn("usage record failed", {
        runId: target.runId,
        error: String(error),
      }),
    );
}

/** Streamed text with secrets, and for recruiters supplier names, held back until safe. */
export function createProgressRedactor(secrets: string[], hideVendors: boolean) {
  const redactor = createStreamingRedactor(secrets);
  if (!hideVendors) return redactor;
  const vendors = createVendorNameStream();
  return {
    push: (chunk: string) => vendors.push(redactor.push(chunk)),
    finish: () => vendors.push(redactor.finish()) + vendors.finish(),
  };
}

/** Pi rates are not carried on events; a null cost is priced from the catalog when recorded. */
const UNPRICED = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

/**
 * A harness event as the runtime events the run loop consumes. `model` names the call a
 * `usage` event belongs to; Pi's usage row does not carry it.
 */
export function harnessEventToRuntimeEvents(
  event: HarnessEvent,
  model?: { provider: string; model: string },
): AgentRuntimeEvent[] {
  switch (event.type) {
    case "message_update":
      return event.event.type === "text_delta" ? [{ type: "text", text: event.event.delta }] : [];
    case "tool_start":
      return [
        {
          type: "tool",
          name: event.toolName,
          args:
            event.args && typeof event.args === "object" && !Array.isArray(event.args)
              ? (event.args as Record<string, unknown>)
              : {},
          executionId: event.toolCallId,
        },
      ];
    case "retry_scheduled":
      return [{ type: "progress", text: "", activity: true, phase: "retrying" }];
    case "compaction_start":
      return [{ type: "progress", text: "", activity: true, phase: "compacting" }];
    case "usage":
      return model
        ? [
            {
              type: "usage",
              provider: model.provider,
              model: model.model,
              callId: event.row.id,
              ...normalizePiUsage(event.row.usage, UNPRICED),
            },
          ]
        : [];
    case "run_end":
      return [event.status === "failed" ? { type: "done", failed: true } : { type: "done" }];
    default:
      return [];
  }
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

export function rakazoMessageId(message: AgentMessage): string | undefined {
  const id = (message as { role?: unknown; rakazoMessageId?: unknown }).rakazoMessageId;
  return (message as { role?: unknown }).role === "user" && typeof id === "string" ? id : undefined;
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  return Array.isArray(content)
    ? content
        .flatMap((part) =>
          part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
        )
        .join("\n")
    : "";
}

interface LiveRun {
  id: string;
  trigger: string;
  startedAt: Date;
  /** Steps since the last reply, posted with the next one. */
  steps: MessageBlock[];
  /** Everything this run posted, for its completion summary. */
  posted: MessageBlock[];
  lastText: string;
  toolStartedAt: Map<string, number>;
  progress: ReturnType<typeof createProgressRedactor>;
  pendingProgress: string;
  streamed: boolean;
}

const PROGRESS_FLUSH_MS = 250;

/**
 * Pi harness events for one (thread, agent) lane, written as the rows the web app already
 * reads. `runs.id` is Pi's operation id. Events are expected in the order Pi emits them.
 */
export function createRunProjection(deps: RunProjectionDeps, key: RunProjectionKey) {
  const secrets = deps.secrets ?? [];
  const hideVendors = deps.hideVendors ?? false;
  const runs = new Map<string, LiveRun>();
  /** The run the lane is in, for events Pi emits without a run id (usage). */
  let current: LiveRun | undefined;
  /** The model that wrote each assistant entry, for its usage row. */
  const entryModels = new Map<string, { provider: string; model: string }>();
  let lastModel: { provider: string; model: string } | undefined;
  let lastProgressAt = 0;

  const target = (run: LiveRun): RunTarget => ({
    spaceId: key.spaceId,
    threadId: key.threadId,
    botId: key.botId,
    runId: run.id,
  });
  const messageRun = (run: LiveRun) => ({ ...target(run), id: run.id, trigger: run.trigger });

  const flushProgress = async (run: LiveRun, force = false) => {
    if (!run.pendingProgress || isBackgroundRunTrigger(run.trigger)) return;
    if (!force && Date.now() - lastProgressAt < PROGRESS_FLUSH_MS) return;
    await deps.events.publishTransient({
      ...target(run),
      type: "thread.progress",
      payload: run.streamed
        ? { delta: run.pendingProgress, streaming: true }
        : { text: run.pendingProgress, streaming: true },
    });
    run.streamed = true;
    run.pendingProgress = "";
    lastProgressAt = Date.now();
  };

  const startRun = async (runId: string, startedAt: number, input: RunInput | undefined) => {
    if (!input) throw new Error("run_start needs the input that started the run");
    const run: LiveRun = {
      id: runId,
      trigger: input.trigger,
      startedAt: new Date(startedAt),
      steps: [],
      posted: [],
      lastText: "",
      toolStartedAt: new Map(),
      progress: createProgressRedactor(secrets, hideVendors),
      pendingProgress: "",
      streamed: false,
    };
    runs.set(runId, run);
    current = run;
    const committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        // A recovered lane can replay its start: the row is already there.
        if (await tx.run.findUnique({ where: { id: runId }, select: { id: true } })) return null;
        // The lane runs one operation at a time, and the one-live-run index needs the agent's
        // other live row closed first. A run waiting on its card completes: its answer, or the
        // recruiter's next words, is this run's input. Any other live row has ended without its
        // end projected.
        const endedAt = new Date(startedAt);
        const waited = await tx.run.updateManyAndReturn({
          where: { threadId: key.threadId, botId: key.botId, status: "waiting_input" },
          data: { status: "completed", completedAt: endedAt },
          select: { id: true, taskId: true, startedAt: true, sourceMessageId: true },
        });
        // An answer given on the card names no message of its own: the run continues the card's
        // run, acting for the message that run acted for (and returning where it returned).
        const sourceMessageId =
          input.sourceMessageId ??
          (input.cardAnswer ? (waited[0]?.sourceMessageId ?? undefined) : undefined);
        if (waited.length > 0) {
          await tx.task.updateMany({
            where: { id: { in: waited.map((row) => row.taskId) } },
            data: { status: "completed" },
          });
          await appendEventsInTransaction(
            tx,
            waited.map((row) => ({
              spaceId: key.spaceId,
              threadId: key.threadId,
              botId: key.botId,
              type: "run.completed",
              runId: row.id,
              payload: completedRunSummary([], row.startedAt, endedAt),
            })),
          );
        }
        const orphans = await tx.run.updateManyAndReturn({
          where: {
            threadId: key.threadId,
            botId: key.botId,
            status: { in: ["queued", "leased", "running", "waiting_takeover"] },
          },
          data: { status: "cancelled", completedAt: endedAt },
          select: { id: true, taskId: true },
        });
        await cancelRunsInTransaction(tx, orphans, endedAt);
        const task = await tx.task.create({
          data: {
            spaceId: key.spaceId,
            botId: key.botId,
            threadId: key.threadId,
            userId: key.userId,
            prompt: input.prompt ?? "",
            status: "running",
          },
        });
        await tx.run.create({
          data: {
            id: runId,
            spaceId: key.spaceId,
            botId: key.botId,
            threadId: key.threadId,
            taskId: task.id,
            userId: key.userId,
            status: "running",
            trigger: input.trigger,
            sourceMessageId: sourceMessageId ?? undefined,
            startedAt: run.startedAt,
          },
        });
        return appendEventInTransaction(tx, {
          ...target(run),
          type: "run.started",
          payload: { trigger: input.trigger },
        });
      }),
    );
    if (committed) await notify(committed.seq);
  };

  const notify = (seq: number) =>
    deps.events.notify(key.threadId, seq).catch((error) => {
      getLogger().error("run projection realtime notification", error);
    });

  /** A person's message consumed by the run (its prompt or a steer) belongs to it. */
  const linkInput = async (runId: string, message: AgentMessage) => {
    const messageId = rakazoMessageId(message);
    if (!messageId) return;
    await deps.prisma.message.updateMany({
      where: { id: messageId, threadId: key.threadId },
      data: { runId },
    });
  };

  /** Each assistant message with text is one reply, carrying the steps taken before it. */
  const postReply = async (run: LiveRun, message: AssistantMessage) => {
    const text = assistantText(message);
    if (!text) return;
    // The durable reply replaces the streamed preview.
    run.progress = createProgressRedactor(secrets, hideVendors);
    run.pendingProgress = "";
    run.streamed = false;
    const blocks = redactBlocks(appendTextSegment(run.steps, text), secrets, hideVendors);
    run.steps = [];
    run.posted.push(...blocks);
    run.lastText = blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("");
    await publishMessage(deps, messageRun(run), "bot", blocks);
  };

  const startTool = async (run: LiveRun, event: Extract<AgentRuntimeEvent, { type: "tool" }>) => {
    await flushProgress(run, true);
    run.toolStartedAt.set(event.executionId, Date.now());
    const step: ToolStepStart = {
      name: event.name,
      executionId: event.executionId,
      args: event.args,
      startedAt: new Date().toISOString(),
      activity: workActivityForTool(event.name, event.args),
      ...stepDetail(event.name, event.args),
    };
    await appendToolCalledEvent(deps, target(run), step, secrets);
    const { args: _args, ...timing } = step;
    run.steps = appendToolCallSegment(run.steps, step.name, timing);
  };

  const endTool = async (
    run: LiveRun,
    event: Extract<HarnessEvent, { type: "tool_end" }>,
  ): Promise<void> => {
    const startedAt = run.toolStartedAt.get(event.toolCallId) ?? Date.now();
    run.toolStartedAt.delete(event.toolCallId);
    const base = {
      name: event.toolName,
      executionId: event.toolCallId,
      durationMs: Date.now() - startedAt,
    };
    const completion = event.isError
      ? { ...base, error: resultText(event.result) || "tool reported an error result" }
      : toolCompletionFromResult(base, event.result);
    await appendToolCompletionAudit(deps, target(run), completion, secrets, (payload) => {
      run.steps = completeToolStep(run.steps, payload);
    });
  };

  const endRun = async (event: Extract<HarnessEvent, { type: "run_end" }>) => {
    const run = runs.get(event.runId);
    runs.delete(event.runId);
    if (current?.id === event.runId) current = undefined;
    const status =
      event.status === "completed"
        ? "completed"
        : event.status === "failed"
          ? "failed"
          : "cancelled";
    const error = event.status === "failed" ? event.error.message : null;
    const leftover = run ? redactBlocks(run.steps, secrets, hideVendors) : [];
    const committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        // Thread row first, then the run row: the order clearThread and finalizeRun lock in.
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${key.threadId} FOR UPDATE`;
        const row = await tx.run.findUnique({
          where: { id: event.runId },
          select: { status: true, startedAt: true, taskId: true, trigger: true },
        });
        if (!row || !["running", "queued", "leased", "waiting_input"].includes(row.status))
          return null;
        const now = new Date();
        // An operation that ended on its card leaves the row waiting for the answer; the next
        // run of this agent completes it.
        const waits = row.status === "waiting_input" && status === "completed";
        const events: AppendEventInput[] = [];
        if (leftover.length > 0 && !isBackgroundRunTrigger(row.trigger)) {
          const message = await createThreadMessageInTransaction(tx, {
            threadId: key.threadId,
            role: "bot",
            blocks: leftover,
            botId: key.botId,
            runId: event.runId,
          });
          events.push({
            spaceId: key.spaceId,
            threadId: key.threadId,
            botId: key.botId,
            type: "thread.message.created",
            runId: event.runId,
            payload: { messageId: message.id, role: "bot", blocks: leftover },
          });
        }
        if (!waits) {
          await tx.run.update({
            where: { id: event.runId },
            data: { status, error, completedAt: now },
          });
          await tx.task.update({ where: { id: row.taskId }, data: { status } });
          events.push({
            spaceId: key.spaceId,
            threadId: key.threadId,
            botId: key.botId,
            type:
              status === "completed"
                ? "run.completed"
                : status === "failed"
                  ? "run.failed"
                  : "run.cancelled",
            runId: event.runId,
            payload:
              status === "completed"
                ? completedRunSummary([...(run?.posted ?? []), ...leftover], row.startedAt, now)
                : status === "failed"
                  ? { error }
                  : {},
          });
        }
        const last = (await appendEventsInTransaction(tx, events)).at(-1);
        await tx.event.deleteMany({ where: { runId: event.runId, type: "thread.progress" } });
        await tx.bot.update({ where: { id: key.botId }, data: { updatedAt: now } });
        return { seq: last?.seq, trigger: row.trigger, waits };
      }),
    );
    if (!committed) return;
    if (committed.seq !== undefined) await notify(committed.seq);
    const body = completionNotificationPreview(run?.lastText ?? "");
    if (
      status === "completed" &&
      !committed.waits &&
      runSendsFinishNotification(committed.trigger) &&
      body
    ) {
      const bot = await deps.prisma.bot.findUnique({
        where: { id: key.botId },
        select: { name: true },
      });
      await notifyRun(
        deps,
        { ...key, id: event.runId, trigger: committed.trigger },
        {
          kind: "completion",
          title: `${bot?.name ?? "Agent"} finished`,
          body,
          botId: key.botId,
          threadId: key.threadId,
        },
      );
    }
  };

  return {
    async onEvent(event: HarnessEvent, ctx: RunProjectionContext = {}): Promise<void> {
      if (event.type === "run_start") return startRun(event.runId, event.startedAt, ctx.input);
      if (event.type === "run_end") return endRun(event);
      if (event.type === "entry_added") {
        const entry = event.entry;
        if (entry.type === "message" && entry.message.role === "assistant") {
          lastModel = { provider: entry.message.provider, model: entry.message.model };
          entryModels.set(entry.id, lastModel);
        }
        return;
      }
      if (event.type === "usage") {
        const run = current;
        const model = (event.row.entryId && entryModels.get(event.row.entryId)) || lastModel;
        if (event.row.entryId) entryModels.delete(event.row.entryId);
        const [usage] = harnessEventToRuntimeEvents(event, model);
        if (!run || usage?.type !== "usage") {
          getLogger().warn("run projection usage not recorded", {
            threadId: key.threadId,
            usageId: event.row.id,
            reason: run ? "model unknown" : "no live run",
          });
          return;
        }
        return recordRunUsage(deps, { ...target(run), userId: key.userId }, usage);
      }
      const runId = "runId" in event ? event.runId : undefined;
      const run = runId ? runs.get(runId) : undefined;
      if (!run) return;
      if (event.type === "message_end") {
        if (event.message.role === "user") return linkInput(run.id, event.message);
        if (event.message.role === "assistant") return postReply(run, event.message);
        return;
      }
      if (event.type === "tool_end") return endTool(run, event);
      for (const runtimeEvent of harnessEventToRuntimeEvents(event)) {
        if (runtimeEvent.type === "text") {
          run.pendingProgress += run.progress.push(runtimeEvent.text);
          await flushProgress(run);
        } else if (runtimeEvent.type === "tool") {
          await startTool(run, runtimeEvent);
        }
      }
    },
  };
}
