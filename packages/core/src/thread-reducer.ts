import type { MessageBlock, ReplyPreview } from "@rakazo/contracts";
import { RUN_TRIGGERS } from "@rakazo/contracts";
import {
  appendToolCallSegment,
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
  "thread.message.reaction",
  "run.started",
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

export function reduceThreadEvent<S extends LiveThread>(prev: S, event: LiveThreadEvent): S {
  const next = reduce(prev, event);
  return next as S;
}

function reduce(prev: LiveThread, event: LiveThreadEvent): LiveThread {
  const payload = event.payload ?? {};
  const cursor = nextCursor(prev, event);
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
    return { ...prev, cursor, messages: [], olderCursor: null, run: null, activeRuns: [] };
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
      messages: prev.messages.filter((message) => message.id !== progressMessageId(event)),
      members: updateMemberStatus(prev.members, event.botId, nextMemberRun?.status ?? "idle"),
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
    const blocks = reduceLiveMessageBlocks(
      previous?.blocks ?? [],
      event.type === "thread.progress"
        ? { type: "progress", payload }
        : { type: "tool", name: String(payload.name ?? "") },
    );
    // The hidden marker keeps a current call distinct from historical developer steps.
    if (event.type === "agent.tool.called" && blocks.at(-1)?.kind === "steps")
      blocks.push({ kind: "progress", activity: true, text: "" });
    return { ...prev, cursor, messages: [...remaining, liveMessage(event, liveId, blocks)] };
  }
  if (event.type === "agent.tool.completed") {
    const liveId = progressMessageId(event);
    return {
      ...prev,
      cursor,
      messages: prev.messages.map((message) => {
        if (
          message.id !== liveId ||
          !message.blocks.some((block) => block.kind === "progress" && block.activity === true)
        )
          return message;
        let blocks: MessageBlock[] = [];
        for (const block of message.blocks) {
          if (block.kind === "progress" && block.activity === true) {
            for (const name of block.pendingToolNames ?? [])
              blocks = appendToolCallSegment(blocks, name);
          } else blocks.push(block);
        }
        return { ...message, blocks };
      }),
    };
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
    const id = String(payload.messageId ?? event.id ?? `msg:${event.seq ?? 0}`);
    const known = prev.messages.find((message) => message.id === id);
    const next = liveMessage(event, id, blocks, {
      role: (payload.role as LiveThreadMessage["role"] | undefined) ?? "bot",
      botId: event.botId ?? (typeof payload.botId === "string" ? payload.botId : undefined),
      // An update can leave the call id out (the end_call marker does), so keep the one
      // the message already carries instead of dropping it out of its call.
      callId: typeof payload.callId === "string" ? payload.callId : known?.callId,
      ...replyMetadata(payload, known),
      createdAt: known?.createdAt ?? event.createdAt,
    });
    const replacedSubagentIds = new Set(
      blocks.filter((block) => block.kind === "subagent").map((block) => block.agentId),
    );
    const { remaining } = takeLiveMessage(prev.messages, progressMessageId(event));
    const without = remaining.filter((message) => !replacedSubagent(message, replacedSubagentIds));
    return { ...prev, cursor, messages: upsertMessageById(without, next) };
  }
  return prev;
}
