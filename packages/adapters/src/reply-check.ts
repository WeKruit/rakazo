import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob, threadReplyCheckJob } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { AUTOCONTINUE_NONCE_PREFIX } from "./turn-end-guard.js";

/**
 * Every message a person writes gets a reply. When the conversation goes quiet (no turn running
 * or queued, nothing waiting to be picked up) and the newest message is still the person's,
 * the agent it went to is asked once to answer it. Whether the reply is good enough is the
 * agent's call; this only makes sure the person is not left without one.
 */
export const REPLY_CHECK_DELAY_MS = 5_000;
/** The error a person's Stop of one turn leaves on it (kept in step with cancel-runs). */
const STOPPED_TURN_ERROR = "turn_stopped";
/** Older unanswered messages are left alone: the person has moved on. */
const MAX_AGE_MS = 60 * 60_000;
/**
 * A person's message reaches an agent as a turn of its own or as steering of a busy one. A
 * person's turn whose slow tool moved to the background keeps its message as the person's.
 */
const PERSON_TRIGGERS = ["user", "follow_up", "tool_background"];

export function replyNudgeNonce(messageId: string): string {
  return `${AUTOCONTINUE_NONCE_PREFIX}reply:${messageId}`;
}

export function replyNudgeText(request: string): string {
  const quoted = request.length > 600 ? `${request.slice(0, 600)}…` : request;
  return [
    "Continue: your turn ended without a reply to the user's latest message, so they have heard nothing back.",
    `Their message: "${quoted}"`,
    "Answer it now: do what it asks, or say plainly what you did and what is still missing. (This is an automatic continuation, not the user's words.)",
  ].join("\n");
}

function messageText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) =>
      block && typeof block === "object" && (block as { kind?: unknown }).kind === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n")
    .trim();
}

/** Schedule the check after a turn ends; a later turn ending replaces a waiting check. */
export function scheduleReplyCheck(
  jobs: Pick<JobPublisher, "enqueue">,
  threadId: string,
  now = Date.now(),
): Promise<void> {
  return jobs.enqueue(threadReplyCheckJob({ threadId }, new Date(now + REPLY_CHECK_DELAY_MS)));
}

export async function checkThreadReplied(
  deps: {
    prisma: PrismaClient;
    events: Pick<ThreadEvents, "sendUserMessage">;
    jobs: Pick<JobPublisher, "enqueue">;
  },
  payload: BackgroundJobPayloads["thread.reply_check"],
  now = Date.now(),
): Promise<void> {
  const skipped = (reason: string) =>
    getLogger().debug("thread.reply_check.skipped", { ...payload, reason });
  const thread = await deps.prisma.thread.findUnique({
    where: { id: payload.threadId },
    select: { id: true, spaceId: true, userId: true },
  });
  if (!thread) return skipped("no thread");
  const latest = await deps.prisma.message.findFirst({
    where: { threadId: thread.id, role: { in: ["user", "bot"] } },
    orderBy: { seq: "desc" },
    select: {
      id: true,
      role: true,
      blocks: true,
      createdAt: true,
      sourceRuns: { select: { botId: true, trigger: true, status: true, error: true }, take: 1 },
      steeringMessages: {
        select: { botId: true, claimedAt: true, run: { select: { status: true, error: true } } },
      },
    },
  });
  if (latest?.role !== "user") return skipped("replied");
  if (latest.createdAt.getTime() < now - MAX_AGE_MS) return skipped("old");
  // Only a message sent to an agent: transcripts and automation input carry their own rules.
  const source = latest.sourceRuns[0];
  if (source && !PERSON_TRIGGERS.includes(source.trigger)) return skipped("automated");
  // Still being worked on: a turn is running, queued or waiting on a card, or the message waits
  // to be picked up. That turn ending schedules this check again.
  if (latest.steeringMessages.some((row) => !row.claimedAt)) return skipped("pending");
  // The person stopped the turn that had their message: answering anyway would undo the stop.
  // A person's Stop leaves no error or "turn_stopped"; a stuck turn the server cancelled carries
  // another error and is still answered.
  const stopped = (run: { status: string; error: string | null } | null | undefined) =>
    run?.status === "cancelled" && (!run.error || run.error === STOPPED_TURN_ERROR);
  if (stopped(source) || latest.steeringMessages.some((row) => stopped(row.run)))
    return skipped("stopped");
  const busy = await deps.prisma.run.findFirst({
    where: { threadId: thread.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  if (busy) return skipped("busy");
  const botId = source?.botId ?? latest.steeringMessages[0]?.botId;
  if (!botId) return skipped("no recipient");
  // Once per message: a nudge that still gets no reply is not repeated.
  const clientNonce = replyNudgeNonce(latest.id);
  const nudged = await deps.prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId: thread.id, clientNonce } },
    select: { id: true },
  });
  if (nudged) return skipped("already nudged");
  const text = replyNudgeText(messageText(latest.blocks));
  getLogger().info("thread.reply_check.nudged", { ...payload, botId, messageId: latest.id });
  const sent = await deps.events
    .sendUserMessage({
      spaceId: thread.spaceId,
      threadId: thread.id,
      botId,
      userId: thread.userId,
      blocks: [{ kind: "text", text }],
      prompt: text,
      trigger: "follow_up",
      internal: true,
      skipWaitingRuns: true,
      clientNonce,
    })
    .catch((error) => {
      getLogger().error("thread.reply_check nudge", error);
      return null;
    });
  if (sent?.runId)
    await deps.jobs.enqueue(runContinueJob(sent.runId)).catch(() => {
      getLogger().warn("reply nudge deferred to reconciliation");
    });
}
