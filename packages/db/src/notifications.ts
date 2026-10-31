import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { IsolationError } from "./scope.js";

export const NOTIFICATION_QUIET_MS = 15 * 60_000;
export const DESKTOP_ACTIVITY_MS = 90_000;
const DESKTOP_ACTIVITY = "desktop-active";
const PUSH_CLAIM = "notification-claim";

type NotificationKind = "completion" | "failure" | "help" | "takeover";

async function mobileNotificationSource(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    threadId: string;
    runId?: string;
    kind?: NotificationKind;
  },
): Promise<string | null> {
  if (!input.runId || !input.kind) return null;
  const statuses = {
    completion: ["completed"],
    failure: ["failed", "cancelled"],
    help: ["waiting_input", "queued"],
    takeover: ["waiting_takeover"],
  } as const;
  const run = await tx.run.findFirst({
    where: {
      id: input.runId,
      threadId: input.threadId,
      spaceId: input.spaceId,
      userId: input.userId,
      status: { in: [...statuses[input.kind]] },
    },
    select: { id: true, status: true, updatedAt: true },
  });
  if (!run) return null;
  // The initial queued state has no product event. Its native status timestamp is the episode.
  if (run.status === "queued") return `queued:${run.id}:${run.updatedAt.toISOString()}`;
  const type = {
    completed: "run.completed",
    failed: "run.failed",
    cancelled: "run.cancelled",
    waiting_input: "run.waiting_input",
    waiting_takeover: "computer.takeover.requested",
  }[run.status];
  if (!type) return null;
  const episode = await tx.event.findFirst({
    where: { threadId: input.threadId, runId: run.id, type },
    orderBy: { seq: "desc" },
    select: { id: true, seq: true },
  });
  if (!episode) return null;
  if (input.kind === "failure") return episode.id;
  // Native pause/completion commits its visible card/reply before the lifecycle event.
  // Sharing that message event with browser claims also dedupes cross-channel replays.
  const message = await tx.event.findFirst({
    where: {
      threadId: input.threadId,
      runId: run.id,
      type: "thread.message.created",
      seq: { lt: episode.seq },
      payload: { path: ["role"], equals: "bot" },
    },
    orderBy: { seq: "desc" },
    select: { id: true },
  });
  return message?.id ?? null;
}

function notificationClaimWhere(
  input: { threadId: string; userId: string; eventId?: string },
  now: Date,
): Prisma.EventWhereInput {
  return {
    threadId: input.threadId,
    type: "thread.meta",
    OR: [
      { createdAt: { gt: new Date(now.getTime() - NOTIFICATION_QUIET_MS) } },
      ...(input.eventId ? [{ payload: { path: ["sourceEventId"], equals: input.eventId } }] : []),
    ],
    AND: [
      { payload: { path: ["notice"], equals: PUSH_CLAIM } },
      { payload: { path: ["userId"], equals: input.userId } },
    ],
  };
}

/** A release check can distinguish an already claimed notification from a broken always-deny path. */
export async function hasConversationNotificationReservation(
  prisma: Pick<PrismaClient, "event">,
  input: { spaceId: string; userId: string; threadId: string; eventId?: string },
  now = new Date(),
): Promise<boolean> {
  return Boolean(
    await prisma.event.findFirst({
      where: {
        ...notificationClaimWhere(input, now),
        thread: { spaceId: input.spaceId, userId: input.userId },
      },
      select: { id: true },
    }),
  );
}

/** Presence is account-wide; only the focused desktop sends this heartbeat. */
export async function recordDesktopActivity(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: { spaceId: string; userId: string },
  now = new Date(),
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${actor.userId} FOR UPDATE`;
    const thread = await tx.thread.findFirst({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        OR: [{ botId: { not: null } }, { group: { members: { some: {} } } }],
      },
      select: {
        id: true,
        botId: true,
        group: { select: { members: { take: 1, select: { botId: true } } } },
      },
    });
    const botId = thread?.botId ?? thread?.group?.members[0]?.botId;
    if (!thread || !botId) return;
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: thread.id,
      botId,
      type: "thread.meta",
      payload: { notice: DESKTOP_ACTIVITY, userId: actor.userId, at: now.toISOString() },
    });
  });
}

/** A durable reservation shared by browser and phone, including across worker restarts. */
export async function claimConversationNotification(
  prisma: Pick<PrismaClient, "$transaction">,
  input: {
    spaceId: string;
    userId: string;
    threadId: string;
    channel: "browser" | "mobile";
    eventId?: string;
    runId?: string;
    kind?: NotificationKind;
  },
  now = new Date(),
): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    // ponytail: serialize this account's presence and dispatch on its user row; split
    // presence and per-thread locks only if account-level contention is measured.
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${input.userId} FOR UPDATE`;
    const thread = await tx.thread.findFirst({
      where: { id: input.threadId, spaceId: input.spaceId, userId: input.userId },
      select: {
        id: true,
        botId: true,
        group: { select: { members: { take: 1, select: { botId: true } } } },
      },
    });
    const botId = thread?.botId ?? thread?.group?.members[0]?.botId;
    if (!thread || !botId) throw new IsolationError();
    if (input.eventId) {
      const event = await tx.event.findFirst({
        where: { id: input.eventId, threadId: thread.id },
        select: { type: true, payload: true },
      });
      if (
        !event ||
        !(
          event.type === "run.failed" ||
          event.type === "run.cancelled" ||
          (event.type === "thread.message.created" &&
            (event.payload as { role?: string }).role === "bot")
        )
      )
        throw new IsolationError();
    }
    const sourceEventId =
      input.channel === "mobile" ? await mobileNotificationSource(tx, input) : input.eventId;
    if (input.channel === "mobile" && !sourceEventId) return null;
    if (
      input.channel === "mobile" &&
      (await tx.event.findFirst({
        where: {
          type: "thread.meta",
          thread: { userId: input.userId },
          createdAt: { gt: new Date(now.getTime() - DESKTOP_ACTIVITY_MS) },
          AND: [
            { payload: { path: ["notice"], equals: DESKTOP_ACTIVITY } },
            { payload: { path: ["userId"], equals: input.userId } },
          ],
        },
        select: { id: true },
      }))
    )
      return null;
    if (
      await tx.event.findFirst({
        where: notificationClaimWhere({ ...input, eventId: sourceEventId ?? undefined }, now),
        select: { id: true },
      })
    )
      return null;
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: thread.id,
      botId,
      type: "thread.meta",
      payload: {
        notice: PUSH_CLAIM,
        userId: input.userId,
        channel: input.channel,
        ...(sourceEventId ? { sourceEventId } : {}),
      },
    });
    return event.id;
  });
}
