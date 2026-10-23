import { ORPCError } from "@orpc/server";
import type {
  Actor,
  RoutineDelegation,
  RoutineHistory,
  RoutineRun,
  RoutineRunCursor,
} from "@rakazo/contracts";
import { MessageBlock } from "@rakazo/contracts";
import { BOT_MESSAGE_MAX_HOPS } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";

// ponytail: cap each page at 200 runs and each graph query at 200 messages; larger chains need child pagination.
const MAX_HISTORY_NODES = 200;
const messageSelect = {
  id: true,
  threadId: true,
  runId: true,
  botId: true,
  role: true,
  blocks: true,
  externalTranscriptFor: { select: { id: true } },
} satisfies Prisma.MessageSelect;
const runSelect = {
  id: true,
  spaceId: true,
  userId: true,
  botId: true,
  threadId: true,
  bot: { select: { id: true, spaceId: true, userId: true, name: true, archivedAt: true } },
  thread: {
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      groupId: true,
      group: { select: { id: true, spaceId: true, userId: true, archivedAt: true } },
    },
  },
  trigger: true,
  sourceMessageId: true,
  sourceMessage: { select: messageSelect },
  status: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} satisfies Prisma.RunSelect;
type HistoryRun = Prisma.RunGetPayload<{ select: typeof runSelect }>;
type HistoryMessage = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;
type DelegationBlock = Extract<MessageBlock, { kind: "handoff" | "bot_message_sent" }>;

function ownedRun(run: HistoryRun, actor: Actor) {
  const owned = (row: { spaceId: string; userId: string }) =>
    row.spaceId === actor.spaceId && row.userId === actor.userId;
  return (
    owned(run) &&
    owned(run.bot) &&
    owned(run.thread) &&
    run.bot.id === run.botId &&
    run.thread.id === run.threadId &&
    (run.thread.groupId
      ? run.thread.group?.id === run.thread.groupId && owned(run.thread.group)
      : run.thread.botId === run.botId)
  );
}
function blocks(message: HistoryMessage): MessageBlock[] {
  if (!Array.isArray(message.blocks)) return [];
  return message.blocks.flatMap((value) => {
    const parsed = MessageBlock.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}
function resourceLimit(): never {
  throw new ORPCError("PAYLOAD_TOO_LARGE", {
    message: "Routine delegation history exceeds the supported size or depth.",
  });
}

export async function listRoutineRuns(
  prisma: PrismaClient,
  actor: Actor,
  routineId: string,
  before?: RoutineRunCursor,
): Promise<RoutineHistory> {
  const routine = await prisma.routine.findFirst({
    where: {
      id: routineId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
    },
    select: { botId: true },
  });
  if (!routine) throw new ORPCError("NOT_FOUND");
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const rows = await prisma.run.findMany({
    where: {
      routineId,
      botId: routine.botId,
      ...scope,
      ...(before
        ? {
            OR: [
              { createdAt: { lt: new Date(before.createdAt) } },
              { createdAt: new Date(before.createdAt), id: { lt: before.id } },
            ],
          }
        : {}),
    },
    select: runSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 21,
  });
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  const nextCursor =
    rows.length > 20 && last ? { id: last.id, createdAt: last.createdAt.toISOString() } : null;
  const roots = page.filter((run) => ownedRun(run, actor));
  const all = new Map(roots.map((run) => [run.id, run]));
  const childrenByParent = new Map<string, Set<string>>();
  let frontier = roots;
  for (let depth = 0; frontier.length; depth += 1) {
    const parents = new Map(frontier.map((run) => [run.id, run]));
    const messages = await prisma.message.findMany({
      where: {
        runId: { in: [...parents.keys()] },
        threadId: { in: [...new Set(frontier.map((run) => run.threadId))] },
        role: "bot",
        externalTranscriptFor: null,
        thread: scope,
        OR: [
          { blocks: { array_contains: [{ kind: "handoff" }] } },
          ...["request", "question"].map((intent) => ({
            blocks: { array_contains: [{ kind: "bot_message_sent", intent }] },
          })),
        ],
      },
      select: messageSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_HISTORY_NODES + 1,
    });
    if (messages.length > MAX_HISTORY_NODES) resourceLimit();
    const outbound = new Map<string, { parent: HistoryRun; block: DelegationBlock }>();
    for (const message of messages) {
      const parent = message.runId ? parents.get(message.runId) : undefined;
      if (
        !parent ||
        message.role !== "bot" ||
        message.botId !== parent.botId ||
        message.threadId !== parent.threadId ||
        message.externalTranscriptFor
      )
        continue;
      const requests = blocks(message).filter((block): block is DelegationBlock =>
        block.kind === "handoff"
          ? block.fromBotId === parent.botId && !!parent.thread.groupId
          : block.kind === "bot_message_sent" &&
            (block.intent === "request" || block.intent === "question"),
      );
      // A native dispatch creates one task. Ambiguous or edited receipts prove no edge.
      if (requests.length === 1) outbound.set(message.id, { parent, block: requests[0]! });
    }
    if (!outbound.size) break;
    const groupIds = [...outbound]
      .filter(([, item]) => item.block.kind === "handoff")
      .map(([id]) => id);
    const dmIds = [...outbound]
      .filter(([, item]) => item.block.kind === "bot_message_sent")
      .map(([id]) => id);
    const children = await prisma.run.findMany({
      where: {
        ...scope,
        bot: scope,
        thread: scope,
        OR: [
          ...(groupIds.length ? [{ trigger: "follow_up", sourceMessageId: { in: groupIds } }] : []),
          ...(dmIds.length
            ? [
                {
                  trigger: "bot_message",
                  sourceMessage: {
                    role: "user",
                    botId: null,
                    externalTranscriptFor: null,
                    OR: dmIds.map((id) => ({
                      blocks: {
                        array_contains: [{ kind: "bot_message_received", returnToMessageId: id }],
                      },
                    })),
                  },
                },
              ]
            : []),
        ],
      },
      select: runSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_HISTORY_NODES + 1,
    });
    if (children.length > MAX_HISTORY_NODES) resourceLimit();
    const next: HistoryRun[] = [];
    for (const child of children) {
      const source = child.sourceMessage;
      if (
        !ownedRun(child, actor) ||
        !child.bot.name.trim() ||
        !source ||
        source.id !== child.sourceMessageId ||
        source.threadId !== child.threadId ||
        source.externalTranscriptFor
      )
        continue;
      const matches = new Set<string>();
      for (const received of blocks(source)) {
        const sent = outbound.get(
          received.kind === "handoff"
            ? source.id
            : received.kind === "bot_message_received"
              ? (received.returnToMessageId ?? "")
              : "",
        );
        if (!sent || sent.parent.id === child.id) continue;
        const { parent, block } = sent;
        if (
          received.kind === "handoff" &&
          block.kind === "handoff" &&
          child.trigger === "follow_up" &&
          source.role === "bot" &&
          source.runId === parent.id &&
          source.botId === parent.botId &&
          child.threadId === parent.threadId &&
          child.thread.groupId === parent.thread.groupId &&
          received.fromBotId === parent.botId &&
          received.toBotId === child.botId &&
          received.text === block.text &&
          received.toBotId === block.toBotId
        )
          matches.add(parent.id);
        if (
          received.kind === "bot_message_received" &&
          block.kind === "bot_message_sent" &&
          child.trigger === "bot_message" &&
          !child.thread.groupId &&
          source.role === "user" &&
          source.botId === null &&
          source.runId === child.id &&
          received.fromBotId === parent.botId &&
          block.toBotId === child.botId &&
          received.intent === block.intent &&
          received.text === block.text
        )
          matches.add(parent.id);
      }
      if (matches.size !== 1) continue;
      const parentId = [...matches][0]!;
      const siblings = childrenByParent.get(parentId) ?? new Set<string>();
      siblings.add(child.id);
      childrenByParent.set(parentId, siblings);
      if (!all.has(child.id)) {
        if (depth >= BOT_MESSAGE_MAX_HOPS || all.size >= MAX_HISTORY_NODES) resourceLimit();
        all.set(child.id, child);
        next.push(child);
      }
    }
    frontier = next;
  }
  // Silent roots have no chat link; children may link to their verified dispatch before replying.
  const messages = all.size
    ? await prisma.$queryRaw<Array<{ id: string; runId: string; threadId: string }>>(Prisma.sql`
        SELECT DISTINCT ON (m."runId") m.id, m."runId", m."threadId"
        FROM messages m
        INNER JOIN runs r ON r.id = m."runId" AND r."threadId" = m."threadId"
        INNER JOIN threads t ON t.id = m."threadId"
        WHERE r.id IN (${Prisma.join([...all.keys()])})
          AND r."spaceId" = ${actor.spaceId} AND r."userId" = ${actor.userId}
          AND t."spaceId" = ${actor.spaceId} AND t."userId" = ${actor.userId}
          AND m.role = 'bot' AND m."botId" = r."botId"
        ORDER BY m."runId", m."createdAt" DESC, m.id DESC
        LIMIT ${all.size}
      `)
    : [];
  const replyByRun = new Map(
    messages
      .filter((message) => all.get(message.runId)?.threadId === message.threadId)
      .map((message) => [message.runId, message.id]),
  );
  function project(run: HistoryRun, delegated = false) {
    const navigable = !run.bot.archivedAt && (!run.thread.groupId || !run.thread.group?.archivedAt);
    return {
      id: run.id,
      botId: run.botId,
      groupId: run.thread.groupId,
      status: run.status as RoutineRun["status"],
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      messageId: navigable
        ? (replyByRun.get(run.id) ?? (delegated ? run.sourceMessageId : null))
        : null,
    };
  }
  return {
    nextCursor,
    runs: roots.map((root) => {
      const seen = new Set([root.id]);
      const delegations: RoutineDelegation[] = [];
      function visit(parentId: string, depth: number) {
        for (const id of childrenByParent.get(parentId) ?? []) {
          if (seen.has(id)) continue;
          if (depth > BOT_MESSAGE_MAX_HOPS) resourceLimit();
          seen.add(id);
          const child = all.get(id)!;
          delegations.push({
            ...project(child, true),
            parentRunId: parentId,
            botName: child.bot.name,
          });
          visit(id, depth + 1);
        }
      }
      visit(root.id, 1);
      return { ...project(root), delegations };
    }),
  };
}
