import type { JobPublisher, RealtimeFanout } from "@rakazo/adapter-kit";
import { sessionDriveJob } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { Prisma } from "./client.js";
import type { ConversationSessionKey, SessionInputKind } from "./conversation-session.js";
import { ensureConversationSession, submitSessionInput } from "./conversation-session.js";

/**
 * What an input carries to the session owner. `text` is the user-role text the lane receives;
 * the rest are facts the owner and the run projection read (never instructions).
 */
export interface SessionInputPayload {
  text: string;
  /** Written by the server or a teammate, not by the person. */
  internal?: true;
  /** The routine whose saved prompt this is. */
  routineId?: string;
  /** Model chosen by the sender (a routine or a native inbound sender). */
  modelPin?: { modelProvider: string; modelId: string; thinkingLevel: string | null };
  /** For `stop`: the run the person stopped, when they stopped one in particular. */
  runId?: string;
  /** A wake that reaches the session once: the source it was started for. */
  wakeKey?: string;
  /** For a recruiting check-in: the replies it reports. */
  checkinReplyIds?: string[];
}

/** Realtime topic the owner of a session listens on. */
export function sessionTopic(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * The one admission path: the agent's session in this conversation (created on first use) gets
 * the input. Joins the caller's transaction so it commits with the message it belongs to.
 */
export async function submitConversationInput(
  tx: Prisma.TransactionClient,
  key: ConversationSessionKey,
  input: {
    kind: SessionInputKind;
    trigger: string;
    messageId?: string;
    payload: SessionInputPayload;
  },
): Promise<{ sessionId: string; inputId: string; seq: number }> {
  const session = await ensureConversationSession(tx, key);
  const submitted = await submitSessionInput(tx, {
    sessionId: session.id,
    kind: input.kind,
    trigger: input.trigger,
    messageId: input.messageId,
    payload: input.payload as unknown as Prisma.InputJsonValue,
  });
  return { sessionId: session.id, ...submitted };
}

/**
 * After commit: tell a live owner at once, and queue `session.drive` for when there is none. Both
 * are best effort: the input is durable and the reconciler drives a session with undelivered input.
 */
export async function wakeSessions(
  deps: { realtime?: RealtimeFanout; jobs?: Pick<JobPublisher, "enqueue"> },
  sessionIds: Iterable<string>,
): Promise<void> {
  await Promise.all(
    [...new Set(sessionIds)].map(async (sessionId) => {
      await deps.realtime?.publish(sessionTopic(sessionId), "{}").catch((error) => {
        getLogger().error("session.notify.failed", error, { sessionId });
      });
      await deps.jobs?.enqueue(sessionDriveJob(sessionId)).catch((error) => {
        getLogger().error("session.drive.enqueue.failed", error, { sessionId });
      });
    }),
  );
}

/**
 * A wake that must reach the session once (a poll close, a finished child, a ticket change): the
 * thread row serializes it with the conversation's other starts, and an earlier input with the
 * same `wakeKey` makes it a no-op. Null when it was already submitted or the thread is gone.
 */
export async function submitConversationWakeOnce(
  tx: Prisma.TransactionClient,
  key: ConversationSessionKey,
  input: {
    kind: SessionInputKind;
    trigger: string;
    messageId?: string;
    payload: SessionInputPayload & { wakeKey: string };
  },
): Promise<{ sessionId: string; inputId: string; seq: number } | null> {
  const locked = await tx.thread.updateMany({
    where: { id: key.threadId, spaceId: key.spaceId },
    data: { nextEventSeq: { increment: 0 } },
  });
  if (!locked.count) return null;
  const earlier = await tx.sessionInput.findFirst({
    where: {
      session: { threadId: key.threadId, botId: key.botId },
      payload: { path: ["wakeKey"], equals: input.payload.wakeKey },
    },
    select: { id: true },
  });
  if (earlier) return null;
  return submitConversationInput(tx, key, input);
}
