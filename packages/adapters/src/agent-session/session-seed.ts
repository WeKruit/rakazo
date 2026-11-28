import type { Context, Session } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentThinking } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, closeEndedAsks, isOpenAskBlock } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { loadMessageThinking, loadRunHistoryMessages } from "@rakazo/db";
import { firstUnseenMessageId, teammateLabel } from "../executor.js";
import {
  formatCompactedSummary,
  LEGACY_HISTORY_WINDOW_SIZE,
  selectCompactedHistory,
} from "../history-compaction.js";
import { replayableThinking } from "../pi-runtime.js";
import { messageToAgentHistoryText } from "../reply-context.js";

/** The lane every conversation session runs on. */
export const SESSION_LANE = "main";

export interface SessionSeedKey {
  spaceId: string;
  userId: string;
  threadId: string;
  botId: string;
  /** The model the session starts on; saved reasoning is replayed only to that model. */
  model: Model<Api>;
}

/** One saved thread message, as the run history read returns it. */
export interface SeedMessage {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  botId: string | null;
  runId: string | null;
  blocks: unknown;
  createdAt: Date;
  replyToMessageId?: string | null;
  replyQuote?: string | null;
  replyTo?: {
    id: string;
    threadId: string;
    role: string;
    botId: string | null;
    blocks: unknown;
  } | null;
}

/** The reads a seed needs; `prismaSeedSource` answers them the way a run reads them today. */
export interface SessionSeedSource {
  thread(threadId: string): Promise<{
    groupId: string | null;
    historyCompactionSummary: string | null;
    historyCompactedUpToSeq: number | null;
  }>;
  /** The thread's newest history window, newest first. */
  history(threadId: string): Promise<SeedMessage[]>;
  botNames(key: SessionSeedKey, botIds: string[]): Promise<ReadonlyMap<string, string>>;
  /** The runs among these that still wait (their cards are still open). */
  waitingRunIds(runIds: string[]): Promise<ReadonlySet<string>>;
  thinking(messageIds: string[]): Promise<ReadonlyMap<string, AgentThinking>>;
}

export function prismaSeedSource(prisma: PrismaClient): SessionSeedSource {
  return {
    thread: (threadId) =>
      prisma.thread.findUniqueOrThrow({
        where: { id: threadId },
        select: { groupId: true, historyCompactionSummary: true, historyCompactedUpToSeq: true },
      }),
    // The run id only matters for a messaging-channel window, which a session never reads.
    history: (threadId) =>
      loadRunHistoryMessages(prisma, { id: "", threadId }, LEGACY_HISTORY_WINDOW_SIZE),
    botNames: async (key, botIds) =>
      new Map(
        botIds.length
          ? (
              await prisma.bot.findMany({
                where: { id: { in: botIds }, userId: key.userId, spaceId: key.spaceId },
                select: { id: true, name: true },
              })
            ).map((row) => [row.id, row.name])
          : [],
      ),
    waitingRunIds: async (runIds) =>
      new Set(
        runIds.length
          ? (
              await prisma.run.findMany({
                where: { id: { in: runIds }, status: { in: [...ACTIVE_RUN_STATUSES] } },
                select: { id: true },
              })
            ).map((row) => row.id)
          : [],
      ),
    thinking: (messageIds) => loadMessageThinking(prisma, messageIds),
  };
}

/**
 * The one-time import of a thread into a new session: its saved history for this bot, rendered
 * as a run renders it today (executor.ts continueRun history, pi-runtime.ts toHistory), with the
 * thread's compaction summary first when it covers the older part. Only messages with
 * `seq < beforeSeq` are imported; later ones arrive as session inputs. Runs once, right after
 * the session row is created; a second call fails because the lane's branch already exists.
 */
export async function seedSession(
  session: Session,
  source: SessionSeedSource,
  key: SessionSeedKey,
  beforeSeq: number,
  context: Context,
): Promise<void> {
  const [thread, window] = await Promise.all([
    source.thread(key.threadId),
    source.history(key.threadId),
  ]);
  const messages = window.filter((m) => m.seq < beforeSeq);
  const teammateIds = [
    ...new Set(
      messages.flatMap((m) =>
        m.role === "bot" && m.botId && m.botId !== key.botId ? [m.botId] : [],
      ),
    ),
  ];
  const cardRunIds = [
    ...new Set(
      messages.flatMap((m) =>
        m.runId && (m.blocks as MessageBlock[]).some(isOpenAskBlock) ? [m.runId] : [],
      ),
    ),
  ];
  const [teammateNames, waitingCardRuns] = await Promise.all([
    source.botNames(key, teammateIds),
    source.waitingRunIds(cardRunIds),
  ]);
  const firstUnseen = thread.groupId ? firstUnseenMessageId(messages, key.botId) : undefined;
  const compacted = selectCompactedHistory({
    messages: [...messages].reverse().map((m) => ({
      id: m.id,
      createdAt: m.createdAt.toISOString(),
      seq: m.seq,
      role: (m.role === "system"
        ? "system"
        : m.role === "bot" && m.botId === key.botId
          ? "assistant"
          : "user") as "user" | "assistant" | "system",
      content: `${m.id === firstUnseen ? "[new since your last reply] " : ""}${m.role === "bot" && m.botId !== key.botId ? `[bot ${teammateLabel(m.botId, teammateNames)}] ` : ""}${messageToAgentHistoryText(
        {
          ...m,
          blocks: closeEndedAsks(
            m.blocks as MessageBlock[],
            !m.runId || waitingCardRuns.has(m.runId),
          ),
        },
      )}`,
    })),
    summary: thread.historyCompactionSummary,
    historyCompactedUpToSeq: thread.historyCompactedUpToSeq,
  });
  const thinking = await source.thinking(
    compacted.history.flatMap((m) => (m.role === "assistant" && m.id ? [m.id] : [])),
  );

  const branch = await session.createBranch(SESSION_LANE, null, context);
  if (compacted.usedLocalSummary && compacted.summary) {
    const summary = {
      role: "user" as const,
      content: formatCompactedSummary(compacted.summary, thread.historyCompactedUpToSeq!),
      timestamp: Date.now(),
      rakazoHistory: true,
      rakazoSummary: true,
    };
    await branch.appendMessage(summary, context);
  }
  for (const m of compacted.history) {
    if (m.role === "system") continue;
    const timestamp = m.createdAt ? Date.parse(m.createdAt) : Date.now();
    const metadata = {
      timestamp,
      rakazoHistory: true,
      rakazoMessageId: m.id,
      rakazoCreatedAt: m.createdAt,
    };
    const message =
      m.role === "assistant"
        ? {
            ...metadata,
            role: "assistant" as const,
            content: [
              ...replayableThinking(m.id ? thinking.get(m.id) : undefined, key.model),
              { type: "text" as const, text: m.content },
            ],
            api: key.model.api,
            provider: key.model.provider,
            model: key.model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
          }
        : { ...metadata, role: "user" as const, content: m.content };
    await branch.appendMessage(message, context);
  }
}
