import { ORPCError } from "@orpc/server";
import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import {
  cancelComputerRunWork,
  screenLeaseIdForRun,
  toComputerRef,
} from "@rakazo/adapters";
import type {
  Actor,
  GroupMember,
  MessageBlock,
  MessageReaction,
  RecruitingChatContext,
  RecruitingCorrespondenceReference,
  ReplyPreview,
  RunStatus,
  ThreadBackgroundTask,
  ThreadMessagePage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  EffortModeSchema,
  GROUP_MEMBER_MIN,
  MessageBlock as MessageBlockSchema,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  AUTOMATION_RUN_TRIGGERS,
  BACKGROUND_RUN_TRIGGERS,
  callIdFromClientNonce,
  isActive,
  projectMessages,
  resolveGroupTargetBotIds,
  runFailureError,
  screenIsChinese,
  takesPersonMessages,
} from "@rakazo/core";
import { deriveMessageQuote, messageReplyPreview } from "@rakazo/core/message-quote";
import type { PrismaClient, QueuedMessageChange, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  createGroupRepos,
  createRepos,
  createThreadMessageInTransaction,
  endThreadWorkInTransaction,
  expireComputerExecutionLeases,
  IsolationError,
  listThreadBackgroundWork,
  loadQueuedMessageIds,
  lockOwnedGroup,
  Prisma,
  QueuedMessageError,
  RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX,
  STOPPED_TURN,
  seesOperatorSpend,
  submitConversationInput,
  submitStopInputsInTransaction,
  threadStopRunWhere,
  touchGroupUpdatedAt,
  updateQueuedMessage,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  buildSendPrompt,
  buildUserMessageBlocks,
  resolveGroupSendAttachments,
  resolveSendAttachments,
} from "./artifacts.js";
import { resolveBusyBotName, toComputerStatus } from "./computer-status.js";
import { withSerializableRetry } from "./serializable-retry.js";
import { includeWaitingAskMessages, loadMessagePage } from "./thread-message-pages.js";
import { loadBackgroundWorkTiming } from "./thread-work-timing.js";

export type ThreadTarget =
  | {
      kind: "bot";
      botId: string;
      threadId: string;
      bot: Awaited<ReturnType<ReturnType<typeof createRepos>["getBot"]>>;
    }
  | {
      kind: "group";
      groupId: string;
      threadId: string;
      groupName: string;
      members: GroupMember[];
      memberBotIds: string[];
    };

// threads.get returns only the newest window; older history pages via threads.messages.
export const THREAD_SNAPSHOT_PAGE_SIZE = 30;

/** Paging fields for the snapshot window, read before waiting cards are merged in. */
function windowCursor(page: ThreadMessagePage) {
  return {
    messagesCursor: page.olderCursor ?? page.messages[0]?.seq ?? null,
    hasOlder: page.olderCursor !== null,
  };
}

const STEERABLE_RUN_STATUSES = new Set(["queued", "leased", "running", "waiting_takeover"]);
/** A person's message goes into the work already running for them, not a second turn. */
function steersUserMessage(run: { status: string; trigger?: string | null }) {
  return STEERABLE_RUN_STATUSES.has(run.status) && takesPersonMessages(run.trigger);
}

type MentionTargetInput = string | { kind: "bot" | "group" | "routine" | "connector"; id: string };

function splitMentionTargets(mentions: MentionTargetInput[] | undefined) {
  const botMentionIds = new Set<string>();
  const groupMentionIds = new Set<string>();
  const routineMentionIds = new Set<string>();
  const connectorMentionIds = new Set<string>();
  for (const mention of mentions ?? []) {
    if (typeof mention === "string") {
      botMentionIds.add(mention);
      continue;
    }
    if (mention.kind === "bot") botMentionIds.add(mention.id);
    if (mention.kind === "group") groupMentionIds.add(mention.id);
    if (mention.kind === "routine") routineMentionIds.add(mention.id);
    if (mention.kind === "connector") connectorMentionIds.add(mention.id);
  }
  return {
    botMentionIds: [...botMentionIds],
    groupMentionIds: [...groupMentionIds],
    routineMentionIds: [...routineMentionIds],
    connectorMentionIds: [...connectorMentionIds],
  };
}

async function resolveOwnedConnectorDisplayNames(
  tx: Prisma.TransactionClient,
  actor: Actor,
  connectionIds: string[],
) {
  if (!connectionIds.length) return [];
  const rows = await tx.connection.findMany({
    where: {
      id: { in: connectionIds },
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: "connected",
    },
    select: { id: true, displayName: true },
  });
  if (rows.length !== connectionIds.length) throw new IsolationError();
  const byId = new Map(rows.map((row) => [row.id, row.displayName]));
  return connectionIds.map((id) => byId.get(id) ?? "connector");
}

function sendRunClientNonce(
  clientNonce: string | undefined,
  messageId: string,
  botId?: string,
): string | undefined {
  if (!clientNonce) return undefined;
  return botId ? `send:${messageId}:${botId}` : `send:${messageId}`;
}

async function findSendReceipt(prisma: PrismaClient, threadId: string, clientNonce: string) {
  return prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId, clientNonce } },
    include: { sourceRuns: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
}

async function replayExistingSend(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  threadId: string,
  clientNonce: string | undefined,
  releaseTakeover?: (runId: string) => Promise<void>,
) {
  if (!clientNonce) return null;
  const message = await findSendReceipt(deps.prisma, threadId, clientNonce);
  if (!message) return null;
  const receiptEvent = await deps.prisma.event.findFirst({
    where: {
      threadId,
      type: "thread.message.created",
      payload: { path: ["messageId"], equals: message.id },
    },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const receiptRunIds = sendEventRunIds(receiptEvent?.payload);
  const receiptRuns = receiptRunIds.length
    ? await deps.prisma.run.findMany({ where: { id: { in: receiptRunIds } } })
    : [];
  const receiptRunById = new Map(receiptRuns.map((run) => [run.id, run]));
  const orderedReceiptRuns = receiptRunIds.flatMap((id) => {
    const run = receiptRunById.get(id);
    return run ? [run] : [];
  });
  const linkedRun =
    message.sourceRuns[0] ??
    (message.runId ? await deps.prisma.run.findUnique({ where: { id: message.runId } }) : null);
  if (!linkedRun && orderedReceiptRuns.length === 0) {
    // Admitted as session input: wake those sessions again in case the first wake was lost.
    const inputs = await deps.prisma.sessionInput.findMany({
      where: { messageId: message.id },
      select: { sessionId: true },
    });
    await deps.events.wakeSessions(inputs.map((row) => row.sessionId));
    return { taskId: null, runId: null, seq: message.seq };
  }
  const runs = orderedReceiptRuns.length
    ? orderedReceiptRuns
    : message.sourceRuns.length
      ? message.sourceRuns
      : [linkedRun!];
  const latestEvent = await deps.prisma.event.findFirst({
    where: { threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (latestEvent) {
    await deps.events.notify(threadId, latestEvent.seq).catch((error) => {
      // Subscribers catch up from the durable event cursor after a missed realtime wake.
      getLogger().error("thread send realtime notification", error);
    });
  }
  return sendResult(message, runs);
}

function sendEventRunIds(payload: Prisma.JsonValue | undefined): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const runIds = (payload as { runIds?: unknown }).runIds;
  return Array.isArray(runIds) ? runIds.filter((id): id is string => typeof id === "string") : [];
}

function sendResult(message: { seq: number }, runs: Array<{ id: string; taskId: string }>) {
  const first = runs[0];
  if (!first) throw new IsolationError("Send did not create a run");
  return {
    taskId: first.taskId,
    runId: first.id,
    seq: message.seq,
    runIds: runs.map((run) => run.id),
  };
}

async function lockAndLoadGroupMembers(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: Extract<ThreadTarget, { kind: "group" }>,
) {
  await lockOwnedGroup(tx, actor, target.groupId);
  const group = await tx.chatGroup.findFirst({
    where: {
      id: target.groupId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
      thread: { id: target.threadId },
    },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: { bot: { select: { id: true, name: true, color: true } } },
        orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
      },
    },
  });
  if (!group || group.members.length < GROUP_MEMBER_MIN) throw new IsolationError();
  return group.members.map((member) => ({
    botId: member.bot.id,
    name: member.bot.name,
    color: member.bot.color,
  }));
}

export async function resolveThreadTarget(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId?: string; groupId?: string },
  options: { includeArchived?: boolean } = {},
): Promise<ThreadTarget> {
  const repos = createRepos(prisma);
  const groupRepos = createGroupRepos(prisma);
  if (input.botId) {
    const bot = await repos.getBot(actor, input.botId, options);
    if (!bot.thread) throw new IsolationError();
    return {
      kind: "bot",
      botId: bot.id,
      threadId: bot.thread.id,
      bot,
    };
  }
  if (input.groupId) {
    const group = await groupRepos.getGroupTarget(actor, input.groupId);
    if (!group.thread) throw new IsolationError();
    const members = group.members.map((member) => ({
      botId: member.bot.id,
      name: member.bot.name,
      color: member.bot.color,
      status: member.bot.runs[0]?.status ?? "idle",
    }));
    return {
      kind: "group",
      groupId: group.id,
      threadId: group.thread.id,
      groupName: group.name,
      members,
      memberBotIds: members.map((member) => member.botId),
    };
  }
  throw new IsolationError();
}

export async function threadHead(prisma: PrismaClient, target: ThreadTarget) {
  const latest = await prisma.event.findFirst({
    where: { threadId: target.threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return { threadId: target.threadId, cursor: latest?.seq ?? -1 };
}

/** The saved next-message suggestion for the newest reply, so it survives a reload. */
export async function latestReplySuggestion(
  prisma: PrismaClient,
  messages: ReadonlyArray<{ id: string; role: string; runId?: string | null; internal?: boolean }>,
): Promise<{ runId: string; text: string; card?: true } | null> {
  const last = messages.findLast(
    (message) =>
      !message.internal &&
      (message.role === "user" || message.role === "bot") &&
      !message.id.startsWith("progress:"),
  );
  if (last?.role !== "bot" || !last.runId) return null;
  const runId = last.runId;
  // Never fails the thread read: no suggestion is the fallback.
  const event = await Promise.resolve()
    .then(() =>
      prisma.event.findFirst({
        where: { runId, type: "thread.suggestion" },
        orderBy: { seq: "desc" },
        select: { payload: true },
      }),
    )
    .catch(() => null);
  const payload = event?.payload as { text?: unknown; card?: unknown } | undefined;
  const text = payload?.text;
  return typeof text === "string" && text
    ? { runId, text, ...(payload?.card === true ? { card: true as const } : {}) }
    : null;
}

export async function threadSnapshot(
  deps: { prisma: PrismaClient },
  target: ThreadTarget,
): Promise<ThreadSnapshot> {
  const [snapshot, effortMode] = await Promise.all([
    readThreadSnapshot(deps, target),
    threadEffortMode(deps.prisma, target.threadId),
  ]);
  const suggestion = await latestReplySuggestion(deps.prisma, snapshot.messages);
  return {
    ...snapshot,
    ...(suggestion ? { suggestion } : {}),
    ...(effortMode ? { effortMode } : {}),
  };
}

/** The chat's effort mode when its owner may choose one; undefined otherwise or on a read error. */
async function threadEffortMode(prisma: PrismaClient, threadId: string) {
  try {
    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { effortMode: true, userId: true },
    });
    if (!thread || !(await seesOperatorSpend(prisma, thread.userId))) return undefined;
    return EffortModeSchema.catch("fast").parse(thread.effortMode ?? "fast");
  } catch (error) {
    // The picker is optional; opening the chat must not fail on it.
    getLogger().warn("thread effort mode read failed", { threadId, error });
    return undefined;
  }
}

async function readThreadSnapshot(
  deps: { prisma: PrismaClient },
  target: ThreadTarget,
): Promise<ThreadSnapshot> {
  // Read messages, the event cursor, active runs, and live progress from one
  // snapshot. A torn Promise.all can otherwise advance the client cursor past
  // thread.message.created while the ask message page still omits it — leaving
  // waiting_input with no AskCard. A snapshot, not a row lock: a share lock made
  // every open of a busy thread wait behind its writers, and made them wait too.
  if (target.kind === "bot") {
    const [busyBotName, core] = await Promise.all([
      resolveBusyBotName(deps.prisma, {
        computerId: target.bot.computer?.id,
        botId: target.botId,
        botName: target.bot.name,
      }),
      deps.prisma.$transaction(
        async (tx) => {
          const [
            messagePage,
            last,
            waitingRun,
            busyOrFailed,
            queuedMessageIds,
            backgroundWork,
            backgroundTasks,
          ] = await Promise.all([
            loadMessagePage(tx, target.threadId, undefined, THREAD_SNAPSHOT_PAGE_SIZE),
            tx.event.findFirst({
              where: { threadId: target.threadId },
              orderBy: { seq: "desc" },
              select: { seq: true },
            }),
            // Waiting asks win over a concurrent busy run, including peer bot_message
            // and ticket runs. Busy ticket work stays off the transcript below.
            tx.run.findFirst({
              where: {
                botId: target.botId,
                threadId: target.threadId,
                status: { in: ["waiting_input", "waiting_takeover"] },
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            }),
            tx.run.findFirst({
              where: {
                botId: target.botId,
                threadId: target.threadId,
                // Hide peer bot_message and background ticket busy/failed noise; waiting is handled above.
                trigger: { notIn: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
                status: { in: [...ACTIVE_RUN_STATUSES, "failed"] },
              },
              // The id tiebreak keeps ordering deterministic under equal
              // timestamps, matching the supersession probe below.
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            }),
            loadQueuedMessageIds(tx, target.threadId),
            loadBackgroundWorkTiming(tx, target.threadId),
            listThreadBackgroundTasks(tx, target),
          ]);
          const run = waitingRun ?? busyOrFailed;
          // A failed run is only the thread's word while it is still the newest
          // terminal run; otherwise a stale failure would resurface in the
          // composer error strip on every load, forever. Instead of comparing
          // timestamps (equal createdAt values reverse under gt/gte), ask for
          // the newest terminal run under the same deterministic ordering and
          // check whether it is this failure.
          const newestTerminal =
            run?.status === "failed"
              ? await tx.run.findFirst({
                  where: {
                    botId: target.botId,
                    threadId: target.threadId,
                    // Peer bot_message and background failures must not bury a user-visible failure.
                    trigger: { notIn: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
                    status: { in: ["failed", "completed", "cancelled"] },
                  },
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                  select: { id: true },
                })
              : null;
          const currentRun = run?.status === "failed" && newestTerminal?.id !== run.id ? null : run;
          const liveEvents =
            currentRun && isActive(currentRun.status as RunStatus)
              ? await tx.event.findMany({
                  where: {
                    threadId: target.threadId,
                    runId: currentRun.id,
                    type: {
                      in: [
                        "thread.progress",
                        "thread.subagent",
                        "agent.tool.called",
                        "agent.tool.completed",
                        "run.requeued",
                      ],
                    },
                  },
                  orderBy: { seq: "asc" },
                })
              : [];
          return {
            window: windowCursor(messagePage),
            messagePage: await includeWaitingAskMessages(
              tx,
              messagePage,
              currentRun ? [currentRun] : [],
            ),
            last,
            run: currentRun,
            liveEvents,
            queuedMessageIds,
            backgroundWork,
            backgroundTasks,
          };
        },
        {
          timeout: 15_000,
          maxWait: 5_000,
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        },
      ),
    ]);
    return {
      botId: target.botId,
      threadId: target.threadId,
      cursor: core.last?.seq ?? -1,
      messages: messagesWithLiveEvents(core.messagePage.messages, core.liveEvents),
      olderCursor: core.messagePage.olderCursor,
      ...core.window,
      queuedMessageIds: core.queuedMessageIds,
      ...(core.backgroundWork.length ? { backgroundWork: core.backgroundWork } : {}),
      backgroundTasks: core.backgroundTasks,
      run: core.run ? mapRun(core.run) : null,
      computer: toComputerStatus(target.botId, target.bot.computer, busyBotName),
    };
  }

  const core = await deps.prisma.$transaction(
    async (tx) => {
      const [
        messagePage,
        last,
        activeRuns,
        recentTerminals,
        queuedMessageIds,
        backgroundWork,
        backgroundTasks,
      ] = await Promise.all([
        loadMessagePage(tx, target.threadId, undefined, THREAD_SNAPSHOT_PAGE_SIZE),
        tx.event.findFirst({
          where: { threadId: target.threadId },
          orderBy: { seq: "desc" },
          select: { seq: true },
        }),
        tx.run.findMany({
          where: {
            threadId: target.threadId,
            status: { in: [...ACTIVE_RUN_STATUSES] },
            // Waiting peer and ticket asks stay answerable. Busy ticket runs stay off
            // the transcript; only their waiting_input / waiting_takeover states surface.
            OR: [
              { trigger: { notIn: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] } },
              { status: { in: ["waiting_input", "waiting_takeover"] } },
            ],
          },
          orderBy: { createdAt: "desc" },
        }),
        // Recently updated terminals (completion bumps updatedAt). pickLatestTerminalRun then
        // ranks by completedAt ?? createdAt so null timestamps cannot revive a stale failure.
        tx.run.findMany({
          where: {
            threadId: target.threadId,
            trigger: { notIn: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
            status: { in: ["failed", "completed", "cancelled"] },
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 50,
        }),
        loadQueuedMessageIds(tx, target.threadId),
        loadBackgroundWorkTiming(tx, target.threadId),
        listThreadBackgroundTasks(tx, target),
      ]);
      const liveEvents =
        activeRuns.length > 0
          ? await tx.event.findMany({
              where: {
                threadId: target.threadId,
                runId: { in: activeRuns.map((run) => run.id) },
                type: {
                  in: [
                    "thread.progress",
                    "thread.subagent",
                    "agent.tool.called",
                    "agent.tool.completed",
                    "run.requeued",
                  ],
                },
              },
              orderBy: { seq: "asc" },
            })
          : [];
      return {
        window: windowCursor(messagePage),
        messagePage: await includeWaitingAskMessages(tx, messagePage, activeRuns),
        last,
        activeRuns,
        terminalRun: pickLatestTerminalRun(recentTerminals),
        liveEvents,
        queuedMessageIds,
        backgroundWork,
        backgroundTasks,
      };
    },
    {
      timeout: 15_000,
      maxWait: 5_000,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );
  const primaryActiveRun = pickPrimaryActiveRun(core.activeRuns);
  return {
    groupId: target.groupId,
    groupName: target.groupName,
    members: target.members,
    threadId: target.threadId,
    cursor: core.last?.seq ?? -1,
    messages: messagesWithLiveEvents(core.messagePage.messages, core.liveEvents),
    olderCursor: core.messagePage.olderCursor,
    ...core.window,
    queuedMessageIds: core.queuedMessageIds,
    ...(core.backgroundWork.length ? { backgroundWork: core.backgroundWork } : {}),
    backgroundTasks: core.backgroundTasks,
    // Match the live reducer: a failed latest terminal stays in run even while siblings are
    // still active or start late. A newer completed/cancelled terminal clears it.
    run:
      core.terminalRun?.status === "failed"
        ? mapRun(core.terminalRun)
        : primaryActiveRun
          ? mapRun(primaryActiveRun)
          : null,
    activeRuns: core.activeRuns.map(mapRun),
  };
}

/**
 * Prefer a waiting ask/takeover over a merely-busy run for the group's headline
 * `run` field, even when the busy run started more recently — createdAt-desc
 * ordering alone would let a fresh busy run for one bot bury an older waiting
 * card for another. `activeRuns` still carries every active run regardless of
 * which one is picked here, so nothing is hidden from the client, only the
 * single-run summary field.
 */
function pickPrimaryActiveRun<T extends { status: string }>(runs: readonly T[]): T | undefined {
  return (
    runs.find((run) => run.status === "waiting_input" || run.status === "waiting_takeover") ??
    runs[0]
  );
}

/** Latest terminal by end time (completedAt, else createdAt), then createdAt, then id. */
function pickLatestTerminalRun<T extends { id: string; createdAt: Date; completedAt: Date | null }>(
  runs: T[],
): T | null {
  if (runs.length === 0) return null;
  return runs.reduce((best, run) => {
    const bestEnd = (best.completedAt ?? best.createdAt).getTime();
    const runEnd = (run.completedAt ?? run.createdAt).getTime();
    if (runEnd !== bestEnd) return runEnd > bestEnd ? run : best;
    if (run.createdAt.getTime() !== best.createdAt.getTime()) {
      return run.createdAt > best.createdAt ? run : best;
    }
    return run.id > best.id ? run : best;
  });
}

function messagesWithLiveEvents(
  persisted: ThreadSnapshot["messages"],
  liveEvents: Parameters<typeof projectMessages>[0],
) {
  const live = projectMessages(liveEvents).filter((message) => {
    if (message.blocks.some((block) => block.kind === "progress" || block.kind === "steps")) {
      return true;
    }
    if (!message.id.startsWith("subagent:")) return false;
    return !persisted.some((row) =>
      row.blocks.some(
        (block) => block.kind === "subagent" && message.id === `subagent:${block.agentId}`,
      ),
    );
  });
  return [...persisted, ...live];
}

function mapRun(run: {
  id: string;
  botId: string;
  threadId: string;
  taskId: string;
  status: string;
  trigger: string;
  routineId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: run.id,
    botId: run.botId,
    threadId: run.threadId,
    taskId: run.taskId,
    status: run.status as never,
    trigger: run.trigger as never,
    routineId: run.routineId ?? null,
    modelProvider: run.modelProvider,
    modelId: run.modelId,
    // Same display clamp as live run.failed events so a huge stored error cannot bypass it.
    error:
      run.status === "failed"
        ? runFailureError({ type: "run.failed", payload: { error: run.error } })
        : run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export async function sendThreadMessage(
  deps: {
    prisma: PrismaClient;
    events: ThreadEvents;
    jobs: JobPublisher;
  },
  actor: Actor,
  target: ThreadTarget,
  input: {
    text?: string;
    correspondenceReference?: RecruitingCorrespondenceReference;
    recruitingContext?: RecruitingChatContext;
    uiLocale?: string;
    artifactIds?: string[];
    addressing?: "coordinator" | "mentions";
    queueMode?: "steer" | "follow_up";
    mentions?: MentionTargetInput[];
    connectorNames?: string[];
    replyToMessageId?: string;
    replyQuote?: string;
    clientNonce?: string;
    /** Interject: interrupt the bot's live reply with this message. */
    interrupt?: boolean;
  },
  releaseTakeover?: (runId: string) => Promise<void>,
) {
  const existing = await replayExistingSend(
    deps,
    target.threadId,
    input.clientNonce,
    releaseTakeover,
  );
  if (existing) return existing;
  // Live events carry the call id so a spoken turn joins the call card on first
  // paint; without it the bubble shows loose until a refetch reads the nonce.
  const callId = callIdFromClientNonce(input.clientNonce);
  const requestedReplyQuote = input.replyQuote?.trim() || undefined;
  if (requestedReplyQuote && !input.replyToMessageId) {
    throw new ORPCError("BAD_REQUEST", { message: "replyQuote requires replyToMessageId." });
  }

  const commit = () =>
    deps.prisma.$transaction(
      async (tx) => {
        const assertCorrespondenceScope = async () => {
          if (!input.correspondenceReference) return;
          // The native message counter already locks this thread. A role switch cannot race this check.
          const current = await tx.thread.findFirst({
            where: {
              id: target.threadId,
              spaceId: actor.spaceId,
              activeRecruitingRoleId: input.correspondenceReference.roleId,
              activeRecruitingRole: { userId: actor.userId, spaceId: actor.spaceId },
            },
            select: { id: true },
          });
          if (!current || input.correspondenceReference.threadId !== target.threadId)
            throw new ORPCError("CONFLICT", {
              message: "Open the current role's email before sending this message.",
            });
        };
        let replyToMessageId: string | undefined;
        let replyQuote: string | undefined;
        let replyPreview: ReplyPreview | null | undefined;
        if (input.replyToMessageId) {
          const reply = await tx.message.findFirst({
            where: { id: input.replyToMessageId, threadId: target.threadId },
            select: { id: true, blocks: true, role: true, botId: true },
          });
          // A missing target must not lose the send or retain an unverified id.
          // The empty server-owned quote preserves the unavailable state after reload.
          if (!reply) {
            replyQuote = "";
            replyPreview = null;
          } else {
            replyToMessageId = input.replyToMessageId;
            const parsed = MessageBlockSchema.array().safeParse(reply.blocks);
            replyPreview = null;
            if (parsed.success) {
              replyPreview = messageReplyPreview(
                parsed.data,
                reply.role as ReplyPreview["role"],
                reply.botId ?? undefined,
              );
              // Attachment labels stay in the preview; only selected text is persisted as a quote.
              if (!requestedReplyQuote && !replyPreview.attachment) {
                replyQuote = replyPreview.text || undefined;
              }
            }
            // Persist only text derived from the authoritative parent. A
            // mismatch or a derivation failure still sends a plain reply so
            // quote verification cannot lose a message.
            if (requestedReplyQuote && parsed.success) {
              try {
                replyQuote = deriveMessageQuote(
                  parsed.data,
                  requestedReplyQuote,
                  reply.role === "user" ? "plain-text" : "markdown",
                );
              } catch (error) {
                getLogger().error("thread send quote derivation", error);
                replyQuote = undefined;
              }
            }
          }
        }

        if (target.kind === "bot") {
          const mentionTargets = splitMentionTargets(input.mentions);
          const { blocks: attachmentBlocks, artifacts } = await resolveSendAttachments(
            { prisma: tx },
            actor,
            target.botId,
            input.artifactIds,
          );
          const connectorNames = await resolveOwnedConnectorDisplayNames(
            tx,
            actor,
            mentionTargets.connectorMentionIds,
          );
          const blocks = buildUserMessageBlocks(
            input.text,
            attachmentBlocks,
            input.correspondenceReference,
            input.recruitingContext,
            input.uiLocale,
          );
          const message = await createThreadMessageInTransaction(tx, {
            threadId: target.threadId,
            role: "user",
            blocks,
            replyToMessageId,
            replyQuote,
            clientNonce: input.clientNonce,
          });
          await assertCorrespondenceScope();
          // The agent's session takes the message: steered into its live run, or the start of
          // the next one. A card no longer holds a run, so text typed beside one is a message too.
          const submitted = await submitConversationInput(
            tx,
            {
              spaceId: actor.spaceId,
              userId: actor.userId,
              threadId: target.threadId,
              botId: target.botId,
            },
            {
              kind: input.queueMode === "follow_up" ? "followUp" : "message",
              trigger: "user",
              messageId: message.id,
              payload: {
                text: buildSendPrompt(
                  input.text,
                  artifacts,
                  [...connectorNames, ...(input.connectorNames ?? [])],
                  input.correspondenceReference,
                  input.recruitingContext,
                ),
              },
            },
          );
          const event = await appendEventInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: target.threadId,
            botId: target.botId,
            type: "thread.message.created",
            payload: {
              messageId: message.id,
              role: "user",
              blocks,
              callId,
              replyToMessageId,
              replyQuote,
              replyPreview,
            },
          });
          return { message, sessionIds: [submitted.sessionId], eventSeq: event.seq };
        }

        const members = await lockAndLoadGroupMembers(tx, actor, target);
        const memberBotIds = members.map((member) => member.botId);
        const mentionTargets = splitMentionTargets(input.mentions);
        // Coordinator routing does not reinterpret the recruiter's authored text as bot commands.
        const targetBotIds = resolveGroupTargetBotIds({
          text: input.addressing === "coordinator" ? "" : (input.text ?? ""),
          members: members.map((member) => ({ id: member.botId, name: member.name })),
          explicitMentions:
            input.addressing === "coordinator" ? undefined : mentionTargets.botMentionIds,
        });
        const { blocks: attachmentBlocks, artifacts } = await resolveGroupSendAttachments(
          { prisma: tx },
          actor,
          target.groupId,
          memberBotIds,
          input.artifactIds,
        );
        const connectorNames = await resolveOwnedConnectorDisplayNames(
          tx,
          actor,
          mentionTargets.connectorMentionIds,
        );
        const blocks = buildUserMessageBlocks(
          input.text,
          attachmentBlocks,
          input.correspondenceReference,
          input.recruitingContext,
          input.uiLocale,
        );
        const message = await createThreadMessageInTransaction(tx, {
          threadId: target.threadId,
          role: "user",
          blocks,
          replyToMessageId,
          replyQuote,
          clientNonce: input.clientNonce,
        });
        await assertCorrespondenceScope();
        const queueMode = input.queueMode;
        // "After you finish" sent while only a teammate is working waits for that teammate's
        // answer instead of starting a second, parallel turn.
        const targetsWorking =
          queueMode === "follow_up"
            ? await tx.run.count({
                where: {
                  threadId: target.threadId,
                  botId: { in: targetBotIds },
                  status: { in: [...STEERABLE_RUN_STATUSES] },
                },
              })
            : 0;
        const teammateRun =
          queueMode === "follow_up" && targetsWorking === 0
            ? (
                await tx.run.findMany({
                  where: {
                    threadId: target.threadId,
                    botId: { in: memberBotIds.filter((botId) => !targetBotIds.includes(botId)) },
                    status: { in: [...STEERABLE_RUN_STATUSES] },
                  },
                  orderBy: { createdAt: "desc" },
                  select: { id: true, botId: true, status: true, trigger: true },
                })
              ).find(steersUserMessage)
            : undefined;
        const prompt = buildSendPrompt(
          input.text,
          artifacts,
          [...connectorNames, ...(input.connectorNames ?? [])],
          input.correspondenceReference,
          input.recruitingContext,
        );
        const sessionIds: string[] = [];
        // Each addressed agent's session takes the message, like a one-to-one chat.
        for (const botId of teammateRun ? [teammateRun.botId] : targetBotIds) {
          const submitted = await submitConversationInput(
            tx,
            { spaceId: actor.spaceId, userId: actor.userId, threadId: target.threadId, botId },
            {
              kind: queueMode === "follow_up" ? "followUp" : "message",
              trigger: "user",
              messageId: message.id,
              payload: { text: prompt },
            },
          );
          sessionIds.push(submitted.sessionId);
        }
        const eventBotId = teammateRun?.botId ?? targetBotIds[0];
        if (!eventBotId) throw new IsolationError("Group send did not resolve a target");
        await touchGroupUpdatedAt(tx, target.groupId);
        const event = await appendEventInTransaction(tx, {
          spaceId: actor.spaceId,
          threadId: target.threadId,
          botId: eventBotId,
          type: "thread.message.created",
          payload: {
            messageId: message.id,
            role: "user",
            blocks,
            callId,
            replyToMessageId,
            replyQuote,
            replyPreview,
          },
        });
        return { message, sessionIds, eventSeq: event.seq };
      },
      { timeout: 15_000, maxWait: 5_000 },
    );

  const committed = await withSerializableRetry(commit).catch(async (error) => {
    const winner = await replayExistingSend(
      deps,
      target.threadId,
      input.clientNonce,
      releaseTakeover,
    );
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  // The input is already durable; the realtime wake and the session wake are independent.
  await Promise.all([
    deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
      // Subscribers catch up from the durable event cursor after a missed realtime wake.
      getLogger().error("thread send realtime notification", error);
    }),
    deps.events.wakeSessions(committed.sessionIds),
  ]);
  if (releaseTakeover && target.kind === "bot") {
    // The person writing takes the computer back from the live run they were watching.
    const live = await deps.prisma.run.findMany({
      where: {
        threadId: target.threadId,
        botId: target.botId,
        status: { in: [...STEERABLE_RUN_STATUSES] },
      },
      select: { id: true },
    });
    for (const run of live) await releaseTakeover(run.id);
  }
  return { taskId: null, runId: null, seq: committed.message.seq };
}

/** Edit, remove, or send now a message the working reply has not read yet. */
export async function updateQueuedThreadMessage(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  actor: Actor,
  target: ThreadTarget,
  input: { messageId: string; change: QueuedMessageChange },
) {
  const result = await updateQueuedMessage(deps.prisma, {
    spaceId: actor.spaceId,
    threadId: target.threadId,
    userId: actor.userId,
    messageId: input.messageId,
    change: input.change,
  }).catch((error: unknown) => {
    if (error instanceof QueuedMessageError) {
      throw new ORPCError(error.code === "applied" ? "CONFLICT" : "BAD_REQUEST", {
        message: error.message,
      });
    }
    throw error;
  });
  await Promise.all([
    result.eventSeq == null
      ? undefined
      : deps.events.notify(target.threadId, result.eventSeq).catch((error) => {
          // Subscribers catch up from the durable event cursor after a missed realtime wake.
          getLogger().error("queued message realtime notification", error);
        }),
  ]);
}

/**
 * Append an emoji reply to the conversation so the next AI turn sees its target.
 * Clients render it beneath that message; the reaction itself does not start an AI turn.
 */
export async function reactToThreadMessage(
  deps: { prisma: PrismaClient },
  actor: Actor,
  target: ThreadTarget,
  input: {
    messageId: string;
    reaction: MessageReaction;
    clientNonce: string;
  },
) {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const parent = await tx.message.findFirst({
      where: { id: input.messageId, threadId: target.threadId },
      select: { id: true },
    });
    if (!parent) throw new IsolationError();
    const existing = await tx.message.findUnique({
      where: {
        threadId_clientNonce: { threadId: target.threadId, clientNonce: input.clientNonce },
      },
      select: { id: true },
    });
    if (existing) return { eventSeq: null };
    const botId = target.kind === "bot" ? target.botId : target.memberBotIds[0];
    if (!botId) throw new IsolationError();
    const blocks: MessageBlock[] = [{ kind: "text", text: input.reaction }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role: "user",
      blocks,
      replyToMessageId: parent.id,
      clientNonce: input.clientNonce,
    });
    if (target.kind === "group") await touchGroupUpdatedAt(tx, target.groupId);
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "user", blocks, replyToMessageId: parent.id },
    });
    return { eventSeq: event.seq };
  });
}

function backgroundRunWhere(scope: {
  spaceId: string;
  userId: string;
  threadId: string;
}): Prisma.RunWhereInput {
  return {
    ...scope,
    status: { in: [...ACTIVE_RUN_STATUSES] },
    OR: [
      { trigger: { in: [...AUTOMATION_RUN_TRIGGERS] } },
      { sourceMessage: { is: { blocks: { array_contains: [{ kind: "handoff" }] } } } },
    ],
  };
}

/** The target is already authorized; every joined record must still share its thread owner. */
export async function listThreadBackgroundTasks(
  prisma: Pick<PrismaClient, "$queryRaw">,
  target: ThreadTarget,
): Promise<ThreadBackgroundTask[]> {
  return listThreadBackgroundWork(prisma, target.threadId);
}

export async function cancelThreadBackgroundTask(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  task: { kind: "cloud_agent" | "agent_run" | "run"; id: string },
) {
  const scope = { spaceId: actor.spaceId, userId: actor.userId, threadId: target.threadId };
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    if (task.kind === "run") {
      const owned = await tx.run.findFirst({
        where: { ...backgroundRunWhere(scope), id: task.id },
        select: { id: true },
      });
      if (!owned) throw new IsolationError();
      return [owned.id];
    }
    if (task.kind === "agent_run") {
      const owned = await tx.externalEffect.findFirst({
        where: {
          id: task.id,
          kind: "work_estimate",
          idempotencyKey: { startsWith: "work_estimate:agent_run_" },
          spaceId: actor.spaceId,
          run: scope,
        },
        select: { id: true, idempotencyKey: true },
      });
      if (!owned) throw new IsolationError();
      await tx.externalEffect.updateMany({
        where: {
          id: task.id,
          kind: "work_estimate",
          status: "running",
          idempotencyKey: { startsWith: "work_estimate:agent_run_" },
          spaceId: actor.spaceId,
          run: scope,
        },
        data: { status: "cancelled" },
      });
      const ref = owned.idempotencyKey.slice("work_estimate:".length);
      const wakes = await tx.run.findMany({
        where: {
          ...scope,
          status: { in: [...ACTIVE_RUN_STATUSES] },
          clientNonce: { startsWith: `${RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX}${ref}:` },
        },
        select: { id: true },
      });
      return wakes.map((wake) => wake.id);
    }
    const owned = await tx.cloudAgent.findFirst({
      where: { id: task.id, ...scope },
      select: { id: true },
    });
    if (!owned) throw new IsolationError();
    // Reuse the cloud-agent outbox: its reconciler asks the provider to cancel and only
    // records cancellation once the provider confirms it.
    await tx.cloudAgent.updateMany({
      where: { id: task.id, ...scope, status: "running" },
      data: { cancelRequested: true, version: { increment: 1 }, nextPollAt: new Date() },
    });
    return [];
  });
}

/** The stop line, in the language the recruiter last wrote in, like the rest of the chat. */
export function stoppedNotice(name: string | null | undefined, chinese = false): string {
  const who = name?.trim();
  if (chinese) return who ? `${who} 停下了助手` : "助手已停止";
  return who ? `${who} stopped the assistant` : "The assistant was stopped";
}

export async function stopThreadRuns(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    events: ThreadEvents;
  },
  actor: Actor,
  target: ThreadTarget,
  runId?: string,
  scope: "turn" | "all" = "turn",
  announce = false,
) {
  const stopped = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    // A started run of an agent's session is stopped by its owner: Stop is one input to that
    // session. A run not yet started, or one no session owns, is cancelled here. With nothing
    // running, Stop changes nothing.
    const live = await tx.run.findMany({
      where: threadStopRunWhere(target.threadId, runId, scope),
      select: { id: true, threadId: true, botId: true, status: true },
    });
    const started = live.filter((run) => run.status !== "queued");
    const stops = await submitStopInputsInTransaction(tx, started, "stop");
    const owned = new Set(started.map((run) => run.id).filter((id) => !stops.unowned.includes(id)));
    const cancelled = await tx.run.updateManyAndReturn({
      where: {
        ...threadStopRunWhere(target.threadId, runId, scope),
        id: { in: live.filter((run) => !owned.has(run.id)).map((run) => run.id) },
      },
      data: {
        status: "cancelled",
        completedAt: new Date(),
        error: runId === undefined && scope === "turn" ? STOPPED_TURN : null,
      },
      select: { id: true, botId: true, taskId: true },
    });
    await cancelRunsInTransaction(tx, cancelled, new Date());
    const ids = cancelled.map((run) => run.id);
    if (runId === undefined && scope === "all")
      await endThreadWorkInTransaction(tx, {
        spaceId: actor.spaceId,
        userId: actor.userId,
        threadId: target.threadId,
      });
    if (ids.length && !(runId === undefined && scope === "all")) {
      // Steering the stopped run already claimed went into its context and ends with it.
      // Unclaimed rows (steered but not yet read, or a queued continuation's input) survive
      // as pending input: the next run in this thread claims them. Stop cancels the run,
      // not what the user said while it ran.
      await tx.steeringMessage.deleteMany({
        where: { runId: { in: ids }, claimedAt: { not: null } },
      });
      await tx.steeringMessage.updateMany({
        where: { runId: { in: ids } },
        data: { runId: null },
      });
    }
    // Snapshot teardown coordinates before commit. Once cancellation becomes
    // visible, a worker can release its lease / execution columns immediately; a
    // later lookup would then miss the sandbox work this request must stop.
    // Team ownership lives on ComputerExecutionLease; Computer.executionRunId is
    // only a legacy secondary path and is not written by current acquisition.
    const leases = ids.length
      ? await tx.computerExecutionLease.findMany({
          where: { runId: { in: ids } },
          select: { computerId: true, botId: true, runId: true, fence: true },
        })
      : [];
    const leaseComputerIds = [...new Set(leases.map((lease) => lease.computerId))];
    const computers = ids.length
      ? await tx.computer.findMany({
          where:
            leaseComputerIds.length > 0
              ? {
                  OR: [{ id: { in: leaseComputerIds } }, { executionRunId: { in: ids } }],
                }
              : { executionRunId: { in: ids } },
          select: {
            id: true,
            homeKey: true,
            kind: true,
            providerRef: true,
            executionBotId: true,
            executionRunId: true,
          },
        })
      : [];
    // One terminal event per cancelled run, in the same commit as the status
    // flip and the progress purge below. Other clients learn the run ended, and
    // the fresh seq keeps max(seq) above every deleted progress row so a client
    // whose cursor pointed at one never discards later refreshes as stale.
    let eventSeq: number | null = null;
    for (const run of cancelled) {
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: run.botId,
        type: "run.cancelled",
        runId: run.id,
        payload: { stoppedByUserId: actor.userId },
      });
      eventSeq = event.seq;
    }
    const stoppedBotId =
      cancelled[0]?.botId ?? started.find((run) => owned.has(run.id))?.botId ?? null;
    if (announce && stoppedBotId) {
      // Everyone in the conversation sees who stopped the work, as a line in the transcript.
      const user = await tx.user.findUnique({
        where: { id: actor.userId },
        select: { name: true },
      });
      const latest = await tx.message.findFirst({
        where: { threadId: target.threadId, role: "user" },
        orderBy: { seq: "desc" },
        select: { blocks: true },
      });
      const blocks: MessageBlock[] = [
        {
          kind: "meta",
          text: stoppedNotice(
            user?.name,
            screenIsChinese(
              latest && Array.isArray(latest.blocks)
                ? [{ role: "user", blocks: latest.blocks as MessageBlock[] }]
                : [],
            ),
          ),
          resume: true,
        },
      ];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "system",
        botId: stoppedBotId,
        blocks,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: stoppedBotId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "system", blocks },
      });
      eventSeq = event.seq;
    }
    if (ids.length) {
      await tx.event.deleteMany({
        where: {
          type: "thread.progress",
          runId: { in: ids },
        },
      });
    }
    return { runIds: ids, computers, leases, eventSeq, sessionIds: stops.sessionIds };
  });
  const { runIds, computers, leases, eventSeq, sessionIds } = stopped;
  if (eventSeq !== null) {
    // The events are durable; subscribers refetch from their persisted cursor.
    await deps.events.notify(target.threadId, eventSeq).catch((error) => {
      getLogger().error("thread stop realtime notification", error);
    });
  }
  await deps.events.wakeSessions(sessionIds);
  // Keep the DB lease until after teardown so a replacement run cannot claim the
  // screen while we still need the cancelled run's screenLeaseId to release it.
  const computerById = new Map(computers.map((computer) => [computer.id, computer]));
  const teardownTargets: Array<{
    computer: (typeof computers)[number];
    botId: string;
    runId: string;
    lease: (typeof leases)[number] | null;
  }> = [];
  const seenTargets = new Set<string>();
  for (const lease of leases) {
    const computer = computerById.get(lease.computerId);
    if (!computer) continue;
    const key = `${computer.id}:${lease.runId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    teardownTargets.push({
      computer,
      botId: lease.botId,
      runId: lease.runId,
      lease,
    });
  }
  const cancelledRunIds = new Set(runIds);
  for (const computer of computers) {
    if (!computer.executionBotId || !computer.executionRunId) continue;
    // Computers may enter the snapshot via a cancelled lease while
    // Computer.executionRunId still points at an unrelated live run. Only treat
    // the legacy columns as a teardown target when they belong to a run we
    // cancelled in this transaction.
    if (!cancelledRunIds.has(computer.executionRunId)) continue;
    const key = `${computer.id}:${computer.executionRunId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    teardownTargets.push({
      computer,
      botId: computer.executionBotId,
      runId: computer.executionRunId,
      lease: null,
    });
  }
  await Promise.all(
    teardownTargets.map(async ({ computer, botId, runId, lease }) => {
      if (!computer.providerRef) return;
      const context = {
        operationId: "stop",
        traceId: "stop",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        runId,
        screenLeaseId: screenLeaseIdForRun(lease, runId),
        cancelRunWork: true,
        signal: new AbortController().signal,
      };
      const ref = toComputerRef(computer);
      await cancelComputerRunWork(deps.sandbox, ref, computer.id, runId, context);
      await deps.sandbox.releaseScreen?.(ref, context).catch(() => undefined);
    }),
  );
  await expireComputerExecutionLeases(deps.prisma, { runId: { in: runIds } });
  await deps.prisma.computer.updateMany({
    where: { executionRunId: { in: runIds } },
    data: {
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
    },
  });
}

export async function setThreadUnreadState(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  unread: boolean,
) {
  const result = await prisma.thread.updateMany({
    where: {
      id: target.threadId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      unread: { not: unread },
    },
    data: { unread },
  });
  if (result.count > 1) throw new IsolationError();
}
