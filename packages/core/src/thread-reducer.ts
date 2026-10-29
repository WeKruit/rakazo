import type { MessageBlock, ReplyPreview } from "@rakazo/contracts";
import { RUN_TRIGGERS } from "@rakazo/contracts";
import {
  appendToolCallSegment,
  completeToolStep,
  isRunTerminalEvent,
  progressMessageId,
  reduceLiveMessageBlocks,
  runFailureError,
  subagentBlockFromPayload,
} from "./events.js";
import { upsertMessageById } from "./message-pages.js";
import { replyMetadata } from "./message-replies.js";
import { isBackgroundRunTrigger } from "./run-state.js";
import { takeLiveMessage, updateCloudAgentMessages } from "./thread-message-updates.js";

/**
 * One reducer over the thread event log for every client. Web and mobile keep their
 * own snapshot types; both are structurally this shape, so they share the fold.
 */
export type LiveThreadRun = {
  id: string;
  botId?: string;
  status: string;
  error?: string | null;
};

export type LiveThreadMessage = {
  id: string;
  threadId?: string;
  seq?: number;
  role: "user" | "bot" | "system";
  blocks: MessageBlock[];
  botId?: string;
  runId?: string;
  callId?: string;
  replyToMessageId?: string;
  replyQuote?: string;
  replyPreview?: ReplyPreview | null;
  createdAt?: string;
  /** Harness-authored turn (e.g. an auto-continue prompt): never shown as conversation. */
  internal?: boolean;
};

export type LiveThread = {
  threadId: string;
  cursor?: number;
  groupId?: string;
  messages: readonly LiveThreadMessage[];
  olderCursor: number | null;
  run: LiveThreadRun | null;
  activeRuns?: readonly LiveThreadRun[];
  members?: ReadonlyArray<{ botId: string; status?: string }>;
  computer?: { busyBotName: string | null } | null;
  /** Tool calls by execution id, so a start and its completion close as a pair in any order. */
  toolExecutions?: { open: string[]; done: Record<string, Record<string, unknown>> };
  /** User messages a working reply has not read yet; they stay editable until it does. */
  queuedMessageIds?: readonly string[];
};

export type LiveThreadEvent = {
  type: string;
  id?: string;
  threadId?: string;
  seq?: number;
  botId?: string;
  runId?: string | null;
  createdAt?: string;
  payload?: Record<string, unknown>;
};

const runTriggers = new Set<string>(RUN_TRIGGERS);

const SNAPSHOT_EVENT_TYPES = new Set([
  "thread.cleared",
  "thread.progress",
  "thread.subagent",
  "thread.cloud_agent",
  "agent.tool.called",
  "agent.tool.completed",
  "thread.message.created",
  "thread.message.updated",
  "thread.message.deleted",
  "thread.message.reaction",
  "run.started",
  "run.steering.claimed",
  "run.requeued",
  "run.waiting_input",
  "computer.takeover.requested",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

/** Events that feed the thread snapshot reducer (the rest drive other panels). */
export function isThreadSnapshotEvent(event: { type: string }): boolean {
  return SNAPSHOT_EVENT_TYPES.has(event.type);
}

/**
 * Event types the reducer folds completely, or that never change what threads.get
 * returns. A run boundary after only these events needs no full snapshot read:
 * the event log already produced the same state. Anything else (routines, skills,
 * reactions, choices, stuck-work notes, unknown future types) falls back to a read.
 */
const SELF_CONTAINED_EVENT_TYPES = new Set([
  ...SNAPSHOT_EVENT_TYPES,
  "heartbeat",
  "usage.recorded",
  "run.checkpointed",
  "effect.recorded",
  "effect.reconciled",
  "memory.revised",
  "computer.status",
  "computer.command",
  "computer.takeover.granted",
  "computer.takeover.released",
  "bot.updated",
  "recruiting.changed",
  "recruiting.context.adopted",
  "recruiting.action.transitioned",
  "recruiting.read",
  "recruiting.candidates.saved",
  "recruiting.material.read",
  "recruiting.assessment.saved",
  "recruiting.question.asked",
  "recruiting.searches.planned",
]);
// The reducer does not fold reactions yet; a read keeps them correct.
SELF_CONTAINED_EVENT_TYPES.delete("thread.message.reaction");

export function eventNeedsSnapshotRead(event: { type: string }): boolean {
  return !SELF_CONTAINED_EVENT_TYPES.has(event.type);
}

/** Run ends and input pauses: the points where clients used to re-read the whole thread. */
export function isRunBoundaryEvent(event: { type: string }): boolean {
  return isRunTerminalEvent(event) || event.type === "run.waiting_input";
}

/** Transient events (seq 0) never move the durable cursor. */
function nextCursor(prev: LiveThread, event: LiveThreadEvent): number | undefined {
  const seq = event.seq;
  if (typeof seq !== "number" || seq <= 0) return prev.cursor;
  return Math.max(prev.cursor ?? -1, seq);
}

function runsOf(prev: LiveThread): readonly LiveThreadRun[] {
  return prev.activeRuns ?? (prev.run ? [prev.run] : []);
}

function updateMemberStatus<Members extends LiveThread["members"]>(
  members: Members,
  botId: string | undefined,
  status: string,
): Members {
  const member = members?.find((candidate) => candidate.botId === botId);
  if (!member || member.status === status) return members;
  return members?.map((candidate) =>
    candidate.botId === botId ? { ...candidate, status } : candidate,
  ) as Members;
}

/** A full Run record; clients with a narrower run type simply ignore the extra fields. */
function newRun(
  event: LiveThreadEvent,
  status: string,
  trigger: string,
  previous?: LiveThreadRun & Record<string, unknown>,
): LiveThreadRun {
  const createdAt = event.createdAt ?? new Date().toISOString();
  const runId = event.runId ?? previous?.id ?? event.id ?? "";
  return {
    id: runId,
    botId: event.botId,
    threadId: event.threadId,
    taskId: previous?.taskId ?? runId,
    status,
    trigger,
    routineId: previous?.routineId ?? null,
    modelProvider: previous?.modelProvider ?? null,
    modelId: previous?.modelId ?? null,
    error: null,
    startedAt: previous?.startedAt ?? createdAt,
    completedAt: null,
    createdAt: previous?.createdAt ?? createdAt,
  } as LiveThreadRun;
}

function liveMessage(
  event: LiveThreadEvent,
  id: string,
  blocks: MessageBlock[],
  extra: Partial<LiveThreadMessage> = {},
): LiveThreadMessage {
  return {
    id,
    threadId: event.threadId,
    seq: event.seq,
    role: "bot",
    blocks,
    botId: event.botId,
    runId: event.runId ?? undefined,
    createdAt: event.createdAt,
    ...extra,
  };
}

function replacedSubagent(message: LiveThreadMessage, agentIds: ReadonlySet<string>) {
  if (agentIds.size === 0) return false;
  return message.blocks.some((block) => block.kind === "subagent" && agentIds.has(block.agentId));
}

function toolExecutionId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.executionId === "string" && payload.executionId
    ? payload.executionId
    : undefined;
}

/** Ends every pending call: used when completions carry no execution id. */
function closeAllToolCalls(message: LiveThreadMessage): LiveThreadMessage {
  if (!message.blocks.some((block) => block.kind === "progress" && block.activity === true))
    return message;
  let blocks: MessageBlock[] = [];
  for (const block of message.blocks) {
    if (block.kind === "progress" && block.activity === true) {
      for (const name of block.pendingToolNames ?? []) blocks = appendToolCallSegment(blocks, name);
    } else blocks.push(block);
  }
  return { ...message, blocks };
}

/** Ends one call; the activity marker stays while another call is still open. */
function closeToolExecution(
  message: LiveThreadMessage,
  executions: { open: string[]; done: Record<string, Record<string, unknown>> },
  executionId: string,
  name: string,
): {
  message: LiveThreadMessage;
  toolExecutions: { open: string[]; done: Record<string, Record<string, unknown>> };
} {
  const toolExecutions = {
    open: executions.open.filter((id) => id !== executionId),
    done: Object.fromEntries(Object.entries(executions.done).filter(([id]) => id !== executionId)),
  };
  if (!toolExecutions.open.length) return { message: closeAllToolCalls(message), toolExecutions };
  let blocks: MessageBlock[] = [];
  for (const block of message.blocks) {
    if (block.kind === "progress" && block.activity === true) {
      const pending = [...(block.pendingToolNames ?? [])];
      const index = pending.indexOf(name);
      if (index >= 0) {
        pending.splice(index, 1);
        blocks = appendToolCallSegment(blocks, name);
      }
      const { pendingToolNames: _settled, ...marker } = block;
      blocks.push(pending.length ? { ...marker, pendingToolNames: pending } : marker);
    } else blocks.push(block);
  }
  return { message: { ...message, blocks }, toolExecutions };
}

export function reduceThreadEvent<S extends LiveThread>(prev: S, event: LiveThreadEvent): S {
  const next = reduce(prev, event);
  return next as S;
}

function withoutQueued(prev: LiveThread, ids: readonly unknown[]): LiveThread {
  const queued = prev.queuedMessageIds;
  if (!queued?.some((id) => ids.includes(id))) return prev;
  return { ...prev, queuedMessageIds: queued.filter((id) => !ids.includes(id)) };
}

function reduce(prev: LiveThread, event: LiveThreadEvent): LiveThread {
  const payload = event.payload ?? {};
  const cursor = nextCursor(prev, event);
  if (event.type === "run.steering.claimed") {
    const ids = Array.isArray(payload.messageIds) ? payload.messageIds : [];
    return { ...withoutQueued(prev, ids), cursor };
  }
  if (event.type === "thread.message.deleted") {
    const id = payload.messageId;
    return {
      ...withoutQueued(prev, [id]),
      cursor,
      messages: prev.messages.filter((message) => message.id !== id),
    };
  }
  if (event.type === "run.requeued") {
    const status = payload.status;
    const run = runsOf(prev).find((candidate) => candidate.id === event.runId);
    if (
      event.threadId !== prev.threadId ||
      (event.seq ?? 0) <= (prev.cursor ?? -1) ||
      (status !== "queued" && status !== "waiting_takeover") ||
      !run ||
      run.botId !== event.botId ||
      !["queued", "leased", "running"].includes(run.status)
    )
      return prev;
    return {
      ...prev,
      cursor,
      members: updateMemberStatus(prev.members, event.botId, status),
      run: prev.run?.id === run.id ? { ...prev.run, status } : prev.run,
      activeRuns: prev.activeRuns?.map((candidate) =>
        candidate.id === run.id ? { ...candidate, status } : candidate,
      ),
      messages: prev.messages.filter((message) => message.id !== progressMessageId(event)),
    };
  }
  if (event.type === "thread.cleared") {
    return {
      ...prev,
      cursor,
      messages: [],
      olderCursor: null,
      run: null,
      activeRuns: [],
      queuedMessageIds: [],
    };
  }
  if (event.type === "run.started") {
    // A replayed start older than the snapshot must not revive a run that already ended.
    if (typeof event.seq === "number" && event.seq > 0 && event.seq < (prev.cursor ?? -1))
      return prev;
    const trigger = typeof payload.trigger === "string" ? payload.trigger : undefined;
    // Background runs (ticket work) stay invisible in the transcript; the server
    // already filters their events and snapshots, this guards a late arrival.
    if (isBackgroundRunTrigger(trigger)) return { ...prev, cursor };
    if (!event.runId) {
      const members = updateMemberStatus(prev.members, event.botId, "running");
      return members === prev.members && cursor === prev.cursor
        ? prev
        : { ...prev, cursor, members };
    }
    const previousRun = (prev.activeRuns?.find((candidate) => candidate.id === event.runId) ??
      (prev.run?.id === event.runId ? prev.run : undefined)) as
      | (LiveThreadRun & Record<string, unknown>)
      | undefined;
    const run = newRun(
      event,
      "running",
      trigger && runTriggers.has(trigger)
        ? trigger
        : typeof previousRun?.trigger === "string"
          ? previousRun.trigger
          : "user",
      previousRun,
    );
    if (typeof payload.routineId === "string")
      (run as Record<string, unknown>).routineId = payload.routineId;
    const without = runsOf(prev).filter((candidate) => candidate.id !== run.id);
    // Bot threads keep a single primary run; groups accumulate concurrent member runs.
    const activeRuns = prev.groupId ? [...without, run] : [run];
    return {
      ...prev,
      cursor,
      members: updateMemberStatus(prev.members, event.botId, "running"),
      // A group failure lives only in run; keep it until dismiss so a late member start
      // cannot wipe the banner (activeRuns still tracks the new work).
      run: prev.groupId && prev.run?.status === "failed" && prev.run.id !== run.id ? prev.run : run,
      activeRuns,
    };
  }
  if (event.type === "run.waiting_input" || event.type === "computer.takeover.requested") {
    const status = event.type === "run.waiting_input" ? "waiting_input" : "waiting_takeover";
    const runId = event.runId;
    const knownInRun = Boolean(runId && prev.run?.id === runId);
    const knownInActive = Boolean(
      runId && prev.activeRuns?.some((candidate) => candidate.id === runId),
    );
    // Peer bot_message runs are omitted from snapshots while busy; the first wait
    // event is how an open thread learns they need ask/takeover UI.
    const needsInsert = Boolean(runId) && !knownInRun && !knownInActive;
    const runChanged = Boolean(knownInRun && prev.run && prev.run.status !== status);
    const activeRunChanged = Boolean(
      knownInActive &&
        prev.activeRuns?.some((candidate) => candidate.id === runId && candidate.status !== status),
    );
    const members = updateMemberStatus(prev.members, event.botId, status);
    // Waiting pauses delete progress server-side; drop the live bubble so a missed
    // message.created cannot leave "working…" stuck next to the waiting UI.
    const liveId = progressMessageId(event);
    const messages = prev.messages.some((message) => message.id === liveId)
      ? prev.messages.filter((message) => message.id !== liveId)
      : prev.messages;
    // The bot asked for the computer, so it no longer holds it.
    const computer =
      status === "waiting_takeover" && prev.computer?.busyBotName
        ? { ...prev.computer, busyBotName: null }
        : prev.computer;
    if (
      !runChanged &&
      !activeRunChanged &&
      !needsInsert &&
      members === prev.members &&
      messages === prev.messages &&
      computer === prev.computer
    ) {
      return prev;
    }
    if (needsInsert && runId) {
      const waitingRun = newRun(event, status, "bot_message");
      const activeRuns = [
        ...runsOf(prev).filter((candidate) => candidate.id !== runId),
        waitingRun,
      ];
      const promoteWaiting =
        !prev.run ||
        (prev.run.status !== "waiting_input" && prev.run.status !== "waiting_takeover");
      return {
        ...prev,
        cursor,
        members,
        messages,
        computer,
        run: promoteWaiting ? waitingRun : prev.run,
        activeRuns,
      };
    }
    return {
      ...prev,
      cursor,
      members,
      messages,
      computer,
      run: runChanged && prev.run ? { ...prev.run, status } : prev.run,
      activeRuns: activeRunChanged
        ? prev.activeRuns?.map((candidate) =>
            candidate.id === runId ? { ...candidate, status } : candidate,
          )
        : prev.activeRuns,
    };
  }
  if (isRunTerminalEvent(event)) {
    const activeRuns = prev.activeRuns?.filter((candidate) => candidate.id !== event.runId);
    const nextMemberRun = activeRuns?.find((candidate) => candidate.botId === event.botId);
    const failure = runFailureError({ type: event.type, payload });
    const primaryEnded = prev.run?.id === event.runId ? prev.run : null;
    // In a group the failing run may be a member run rather than the displayed one, so look
    // it up in activeRuns as well or its error would be dropped with it.
    const endedRun =
      primaryEnded ?? prev.activeRuns?.find((candidate) => candidate.id === event.runId) ?? null;
    return {
      ...prev,
      cursor,
      messages: prev.messages.flatMap((message) => {
        if (message.id !== progressMessageId(event)) return [message];
        const marker = message.blocks.at(-1);
        let blocks = closeAllToolCalls(message).blocks.filter((block) => block.kind === "steps");
        if (marker?.kind === "progress" && marker.activity && !marker.phase) {
          const names = marker.pendingToolNames?.length
            ? marker.pendingToolNames
            : marker.text === "" && blocks.at(-1)?.kind === "steps"
              ? [blocks.at(-1)!.steps.at(-1)?.label ?? ""]
              : [];
          for (const name of names)
            blocks = completeToolStep(blocks, { name, outcome: "paused" }).filter(
              (block) => block.kind === "steps",
            );
        }
        return blocks.length
          ? [
              {
                ...message,
                id: `work:${event.runId ?? event.id}`,
                blocks,
                createdAt: event.createdAt ?? message.createdAt,
              },
            ]
          : [];
      }),
      members: updateMemberStatus(prev.members, event.botId, nextMemberRun?.status ?? "idle"),
      // Execution ids only pair calls within live runs.
      toolExecutions: activeRuns?.length ? prev.toolExecutions : undefined,
      // A failed run stays in run (activeRuns already excludes it) so the transcript can say
      // why it stopped, matching what threads.get returns on the next load.
      run:
        endedRun && failure
          ? { ...endedRun, status: "failed", error: failure }
          : primaryEnded
            ? (activeRuns?.[0] ?? null)
            : prev.run,
      activeRuns,
    };
  }
  if (event.type === "thread.progress" || event.type === "agent.tool.called") {
    const liveId = progressMessageId(event);
    const { previous, remaining } = takeLiveMessage(prev.messages, liveId);
    const name = String(payload.name ?? "");
    const blocks = reduceLiveMessageBlocks(
      previous?.blocks ?? [],
      event.type === "thread.progress" ? { type: "progress", payload } : { type: "tool", name },
    );
    // The hidden marker keeps a current call distinct from historical developer steps.
    if (event.type === "agent.tool.called" && blocks.at(-1)?.kind === "steps")
      blocks.push({ kind: "progress", activity: true, text: "" });
    const message = liveMessage(event, liveId, blocks);
    const executionId = toolExecutionId(payload);
    if (event.type !== "agent.tool.called" || !executionId)
      return { ...prev, cursor, messages: [...remaining, message] };
    const open = [...(prev.toolExecutions?.open ?? []), executionId];
    const done = prev.toolExecutions?.done ?? {};
    // Its completion was stored first, so the call is already over.
    const completion = Object.hasOwn(done, executionId) ? done[executionId] : undefined;
    const closed = completion
      ? closeToolExecution(message, { open, done }, executionId, name)
      : { message, toolExecutions: { open, done } };
    if (completion)
      closed.message = {
        ...closed.message,
        blocks: completeToolStep(closed.message.blocks, completion),
      };
    return {
      ...prev,
      cursor,
      messages: [...remaining, closed.message],
      toolExecutions: closed.toolExecutions,
    };
  }
  if (event.type === "agent.tool.completed") {
    const liveId = progressMessageId(event);
    const executionId = toolExecutionId(payload);
    if (executionId && !prev.toolExecutions?.open.includes(executionId)) {
      const open = prev.toolExecutions?.open ?? [];
      const found = (payload.lookup as { found?: unknown } | undefined)?.found;
      const done = {
        ...prev.toolExecutions?.done,
        [executionId]: {
          name: typeof payload.name === "string" ? payload.name : "",
          outcome: ["succeeded", "error", "paused"].includes(String(payload.outcome))
            ? payload.outcome
            : undefined,
          lookup: Number.isSafeInteger(found) && Number(found) >= 0 ? { found } : undefined,
        },
      };
      return { ...prev, cursor, toolExecutions: { open, done } };
    }
    let toolExecutions = prev.toolExecutions;
    const messages = prev.messages.map((message) => {
      if (message.id !== liveId) return message;
      if (!executionId || !prev.toolExecutions) {
        const closed = closeAllToolCalls(message);
        return { ...closed, blocks: completeToolStep(closed.blocks, payload) };
      }
      const closed = closeToolExecution(
        message,
        prev.toolExecutions,
        executionId,
        String(payload.name ?? ""),
      );
      toolExecutions = closed.toolExecutions;
      return { ...closed.message, blocks: completeToolStep(closed.message.blocks, payload) };
    });
    return { ...prev, cursor, messages, toolExecutions };
  }
  if (event.type === "thread.subagent") {
    const block = subagentBlockFromPayload(payload);
    const next = liveMessage(event, `subagent:${block.agentId}`, [block]);
    const without: LiveThreadMessage[] = [];
    const kept: LiveThreadMessage[] = [];
    for (const message of prev.messages) {
      if (message.id === next.id) continue;
      if (message.id.startsWith("progress:")) {
        if (message.runId) kept.push(message);
      } else {
        without.push(message);
      }
    }
    return { ...prev, cursor, messages: [...without, next, ...kept] };
  }
  if (event.type === "thread.cloud_agent") {
    return { ...prev, cursor, messages: updateCloudAgentMessages(prev.messages, payload) };
  }
  if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
    const blocks = (payload.blocks as MessageBlock[] | undefined) ?? [];
    const base =
      event.type === "thread.message.created" && payload.role === "user"
        ? settlePendingUserMessage(prev, blocks)
        : prev;
    const id = String(payload.messageId ?? event.id ?? `msg:${event.seq ?? 0}`);
    const known = base.messages.find((message) => message.id === id);
    const next = liveMessage(event, id, blocks, {
      role: (payload.role as LiveThreadMessage["role"] | undefined) ?? "bot",
      botId: event.botId ?? (typeof payload.botId === "string" ? payload.botId : undefined),
      // An update can leave the call id out (the end_call marker does), so keep the one
      // the message already carries instead of dropping it out of its call.
      callId: typeof payload.callId === "string" ? payload.callId : known?.callId,
      ...replyMetadata(payload, known),
      createdAt: known?.createdAt ?? event.createdAt,
      ...(payload.internal === true || known?.internal ? { internal: true } : {}),
    });
    const replacedSubagentIds = new Set(
      blocks.filter((block) => block.kind === "subagent").map((block) => block.agentId),
    );
    const { remaining } = takeLiveMessage(base.messages, progressMessageId(event));
    const without = remaining.filter((message) => !replacedSubagent(message, replacedSubagentIds));
    const queued = base.queuedMessageIds ?? [];
    // A replay older than the snapshot must not requeue a message the run already read.
    const queues =
      event.type === "thread.message.created" &&
      payload.queued === true &&
      (event.seq ?? 0) > (prev.cursor ?? -1) &&
      !queued.includes(id);
    return {
      ...base,
      cursor,
      messages: upsertMessageById(without, next),
      ...(queues ? { queuedMessageIds: [...queued, id] } : {}),
    };
  }
  return prev;
}

/**
 * Local echo of a message the user just sent, shown before the server confirms it.
 * Ids use the client nonce so a failed send can take exactly that bubble back.
 */
export const PENDING_MESSAGE_PREFIX = "pending:";

export function pendingUserMessageId(clientNonce: string): string {
  return `${PENDING_MESSAGE_PREFIX}${clientNonce}`;
}

export function isPendingUserMessage(message: { id: string }): boolean {
  return message.id.startsWith(PENDING_MESSAGE_PREFIX);
}

export function addPendingUserMessage<S extends LiveThread>(
  thread: S,
  input: {
    clientNonce: string;
    text: string;
    createdAt: string;
    replyToMessageId?: string;
    replyQuote?: string;
  },
): S {
  const id = pendingUserMessageId(input.clientNonce);
  if (!input.text.trim() || thread.messages.some((message) => message.id === id)) return thread;
  const message: LiveThreadMessage = {
    id,
    threadId: thread.threadId,
    // Sorts with the newest durable message until the server assigns the real seq.
    seq: thread.messages.at(-1)?.seq ?? 0,
    role: "user",
    blocks: [{ kind: "text", text: input.text }],
    createdAt: input.createdAt,
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    ...(input.replyQuote ? { replyQuote: input.replyQuote } : {}),
  };
  return { ...thread, messages: [...thread.messages, message] };
}

export function removePendingUserMessage<S extends LiveThread>(thread: S, clientNonce: string): S {
  const id = pendingUserMessageId(clientNonce);
  if (!thread.messages.some((message) => message.id === id)) return thread;
  return { ...thread, messages: thread.messages.filter((message) => message.id !== id) };
}

export function hasPendingUserMessage(thread: Pick<LiveThread, "messages"> | null): boolean {
  return Boolean(thread?.messages.some(isPendingUserMessage));
}

function messageText(blocks: readonly MessageBlock[]): string {
  return blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

/** The durable user message replaces its echo: same text first, else the oldest echo. */
function settlePendingUserMessage(thread: LiveThread, blocks: readonly MessageBlock[]): LiveThread {
  const pending = thread.messages.filter(isPendingUserMessage);
  if (!pending.length) return thread;
  const text = messageText(blocks);
  const settled = pending.find((message) => messageText(message.blocks) === text) ?? pending[0];
  return { ...thread, messages: thread.messages.filter((message) => message !== settled) };
}
