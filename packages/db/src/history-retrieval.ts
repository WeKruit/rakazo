import { createHash } from "node:crypto";
import type { HistoryReadInput, HistorySearchInput, MessageBlock } from "@rakazo/contracts";
import type { BoundApprovalRoute } from "@rakazo/core";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  messageFileReferences,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

/** Only the executor supplies scope; tool arguments cannot widen it. */
export interface HistoryScope {
  spaceId: string;
  userId: string;
  threadId: string;
  botId: string;
  channelId?: string;
  /** Server-captured history boundary. Search excludes the active request and later messages. */
  searchBeforeSeq?: number;
}
interface HistoryRow {
  id: string;
  seq: number;
  role: string;
  runId: string | null;
  replyToMessageId: string | null;
  createdAt: Date;
  blocks: Prisma.JsonValue;
  groupId?: string | null;
}
// Bound complete JSON pages, including cursors. Current retains Pi's legacy 12k
// result clipping; newer strategies preserve structured results within their context budget.
const MAX_RESPONSE_BYTES = 10_000;
const LINK_PAGE_SIZE = 5;
function bounded<
  T extends {
    messages: ReturnType<typeof reference>[];
    receipt?: {
      text: string;
      textOffset: number;
      nextTextOffset: number | null;
      truncated: boolean;
    } | null;
  },
>(response: T): T {
  const refs: Array<{
    text: string;
    textOffset: number;
    nextTextOffset: number | null;
    truncated: boolean;
  }> = [...response.messages];
  if (response.receipt) refs.push(response.receipt);
  if ("runs" in response) {
    const runs = response.runs as Array<{
      outcomes: ReturnType<typeof reference>[];
    }>;
    refs.push(...runs.flatMap((run) => run.outcomes));
  }
  while (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_RESPONSE_BYTES) {
    const longest = refs.reduce<(typeof refs)[number] | undefined>(
      (best, ref) => (!best || ref.text.length > best.text.length ? ref : best),
      undefined,
    );
    if (!longest || longest.text.length < 2)
      throw new Error("History metadata exceeds response budget");
    let end = Math.floor(longest.text.length / 2);
    if (
      /^[\uDC00-\uDFFF]/.test(longest.text.slice(end)) &&
      /[\uD800-\uDBFF]$/.test(longest.text.slice(0, end))
    )
      end--;
    if (end === 0) throw new Error("History metadata exceeds response budget");
    longest.text = longest.text.slice(0, end);
    longest.truncated = true;
    longest.nextTextOffset = longest.textOffset + longest.text.length;
  }
  return response;
}
const searchableText = Prisma.sql`jsonb_path_query_array(m.blocks,
  '$[*] ? (@.kind == "text" || @.kind == "channel_message" || @.kind == "bot_message_received" || @.kind == "bot_message_sent" || @.kind == "handoff").text')::text || jsonb_path_query_array(m.blocks, '$[*] ? (@.kind == "subagent").task')::text || jsonb_path_query_array(m.blocks, '$[*] ? (@.kind == "subagent").result')::text`;
const columns = Prisma.sql`m.id, m.seq, m.role, m."runId", m."replyToMessageId", m."createdAt", m.blocks, t."groupId" AS "groupId"`;
const MINE_SNIPPET_LENGTH = 200;

/**
 * Messages visible to this run. `thread` "conversation" is the current thread through this
 * bot's own authorization; "mine" is every other conversation owned by the same user in the
 * same Space (their bots' threads and their group chats), optionally one given thread. Other
 * users' threads in the Space are never visible under either mode.
 */
function visible(
  scope: HistoryScope,
  thread: "conversation" | { mine: string | null } = "conversation",
): Prisma.Sql {
  const channel = scope.channelId;
  const owned =
    thread === "conversation"
      ? Prisma.sql`t.id = ${scope.threadId}
    AND (t."botId" = ${scope.botId} OR (t."botId" IS NULL AND EXISTS (
      SELECT 1 FROM chat_groups g JOIN chat_group_members member ON member."groupId" = g.id
      WHERE g.id = t."groupId" AND g."spaceId" = ${scope.spaceId} AND g."userId" = ${scope.userId}
        AND g."archivedAt" IS NULL AND member."botId" = ${scope.botId}
    )))`
      : Prisma.sql`${thread.mine ? Prisma.sql`t.id = ${thread.mine}` : Prisma.sql`t.id <> ${scope.threadId}`}
    AND ((t."botId" IS NOT NULL AND EXISTS (SELECT 1 FROM bots owner WHERE owner.id = t."botId"
      AND owner."spaceId" = ${scope.spaceId} AND owner."userId" = ${scope.userId} AND owner."archivedAt" IS NULL))
      OR (t."groupId" IS NOT NULL AND EXISTS (SELECT 1 FROM chat_groups g WHERE g.id = t."groupId"
      AND g."spaceId" = ${scope.spaceId} AND g."userId" = ${scope.userId} AND g."archivedAt" IS NULL)))`;
  return Prisma.sql`
    ${owned} AND t."spaceId" = ${scope.spaceId}
    AND t."userId" = ${scope.userId}
    AND EXISTS (SELECT 1 FROM bots b WHERE b.id = ${scope.botId}
      AND b."spaceId" = ${scope.spaceId} AND b."userId" = ${scope.userId}
      AND b."archivedAt" IS NULL)
    ${
      channel
        ? Prisma.sql`AND (
      (m.role = 'user' AND m.blocks @> ${JSON.stringify([{ kind: "channel_message", channelId: channel }])}::jsonb)
      OR (m.role = 'bot' AND EXISTS (
        SELECT 1 FROM runs r JOIN messages source ON source.id = r."sourceMessageId"
        WHERE r.id = m."runId" AND r."threadId" = t.id
          AND r."spaceId" = ${scope.spaceId} AND r."userId" = ${scope.userId}
          AND r."botId" = ${scope.botId} AND source."threadId" = t.id
          AND source.blocks @> ${JSON.stringify([{ kind: "channel_message", channelId: channel }])}::jsonb
      )))`
        : Prisma.empty
    }
  `;
}
function pageSize(value = 10): number {
  if (!Number.isInteger(value) || value < 1)
    throw new Error("History limit must be a positive integer");
  return Math.min(value, 20);
}
function date(value: string | undefined): Date | undefined {
  if (value === undefined) return;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid history date");
  return parsed;
}
/** Text only: progress, commands, secret prompts and tool traces are not retrieval content. */
export function historyMessageText(blocks: Prisma.JsonValue): string {
  if (!Array.isArray(blocks)) return "";
  return (
    blocks.filter(
      (block) => block && typeof block === "object" && !Array.isArray(block),
    ) as MessageBlock[]
  )
    .flatMap((block) => {
      if (block.kind === "subagent") return [block.task, block.result ?? ""].filter(Boolean);
      return [
        "text",
        "channel_message",
        "bot_message_received",
        "bot_message_sent",
        "handoff",
      ].includes(block.kind) &&
        "text" in block &&
        typeof block.text === "string"
        ? [block.text]
        : [];
    })
    .join("\n");
}
function reference(row: HistoryRow, query = "", maxLength = 800, textOffset = 0) {
  const text = historyMessageText(row.blocks);
  const matchedTerm =
    query && !text.toLowerCase().includes(query.toLowerCase())
      ? (query.split(/\s+/).find((term) => text.toLowerCase().includes(term.toLowerCase())) ??
        query)
      : query;
  if (query) textOffset = Math.max(0, text.toLowerCase().indexOf(matchedTerm.toLowerCase()) - 40);
  return {
    messageId: row.id,
    seq: row.seq,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    runId: row.runId,
    replyToMessageId: row.replyToMessageId,
    files: messageFileReferences(row.blocks),
    text: text.slice(textOffset, textOffset + maxLength),
    textOffset,
    nextTextOffset: textOffset + maxLength < text.length ? textOffset + maxLength : null,
    truncated: textOffset > 0 || textOffset + maxLength < text.length,
  };
}

/** Other conversations of the same user: title, short snippet and a read_history reference. */
async function searchMine(
  prisma: PrismaClient,
  scope: HistoryScope,
  input: HistorySearchInput,
  query: string,
  limit: number,
) {
  const before = date(input.before);
  const after = date(input.after);
  // ponytail: (createdAt, id) is the cursor because seq is per thread; the row tuple order is exact.
  const cursor =
    before && input.beforeMessageId
      ? Prisma.sql`AND (m."createdAt", m.id) < (${before}, ${input.beforeMessageId})`
      : before
        ? Prisma.sql`AND m."createdAt" < ${before}`
        : Prisma.empty;
  const rows = await prisma.$queryRaw<
    Array<HistoryRow & { threadId: string; botName: string | null; groupName: string | null }>
  >(Prisma.sql`
    SELECT ${columns}, m."threadId" AS "threadId",
      (SELECT owner.name FROM bots owner WHERE owner.id = t."botId") AS "botName",
      (SELECT g.name FROM chat_groups g WHERE g.id = t."groupId") AS "groupName"
    FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${visible(scope, { mine: null })}
      ${after ? Prisma.sql`AND m."createdAt" >= ${after}` : Prisma.empty}
      ${cursor}
      AND to_tsvector('simple', ${searchableText}) @@ plainto_tsquery('simple', ${query})
    ORDER BY m."createdAt" DESC, m.id DESC LIMIT ${limit + 1}
  `);
  const page = rows.slice(0, limit);
  const last = rows.length > limit ? page.at(-1)! : undefined;
  return {
    untrusted: true as const,
    query,
    scope: "mine" as const,
    coverage: {
      scope: "requested_query_and_range" as const,
      status: last ? ("partial" as const) : ("exhausted" as const),
    },
    messages: page.map((row) => ({
      threadId: row.threadId,
      threadTitle: row.botName ?? row.groupName ?? "",
      messageId: row.id,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
      snippet: reference(row, query, MINE_SNIPPET_LENGTH).text,
    })),
    nextSearch: last
      ? {
          query,
          scope: "mine" as const,
          before: last.createdAt.toISOString(),
          beforeMessageId: last.id,
          limit,
          ...(input.after !== undefined ? { after: input.after } : {}),
        }
      : null,
  };
}

type MineSearchResult = Awaited<ReturnType<typeof searchMine>>;
type ConversationSearchResult = Awaited<ReturnType<typeof searchConversation>>;

/** PostgreSQL full text search, descending sequence cursor, at most five excerpts. */
export function searchHistory(
  prisma: PrismaClient,
  scope: HistoryScope,
  input: HistorySearchInput & { scope: "mine" },
): Promise<MineSearchResult>;
export function searchHistory(
  prisma: PrismaClient,
  scope: HistoryScope,
  input: HistorySearchInput & { scope?: "conversation" },
): Promise<ConversationSearchResult>;
export function searchHistory(
  prisma: PrismaClient,
  scope: HistoryScope,
  input: HistorySearchInput,
): Promise<MineSearchResult | ConversationSearchResult>;
export async function searchHistory(
  prisma: PrismaClient,
  scope: HistoryScope,
  input: HistorySearchInput,
): Promise<MineSearchResult | ConversationSearchResult> {
  const query = input.query.trim();
  if (!query || query.length > 500)
    throw new Error("History query must contain 1 to 500 characters");
  const limit = Math.min(pageSize(input.limit), 5);
  return input.scope === "mine"
    ? searchMine(prisma, scope, input, query, limit)
    : searchConversation(prisma, scope, input, query, limit);
}

async function searchConversation(
  prisma: PrismaClient,
  scope: HistoryScope,
  input: HistorySearchInput,
  query: string,
  limit: number,
) {
  const before = date(input.before);
  const after = date(input.after);
  if (
    input.beforeSeq !== undefined &&
    (!Number.isInteger(input.beforeSeq) || input.beforeSeq < 0)
  ) {
    throw new Error("Invalid history cursor");
  }
  if (
    scope.searchBeforeSeq !== undefined &&
    (!Number.isInteger(scope.searchBeforeSeq) || scope.searchBeforeSeq < 0)
  )
    throw new Error("Invalid history search boundary");
  const beforeSeq = Math.min(
    input.beforeSeq ?? Number.POSITIVE_INFINITY,
    scope.searchBeforeSeq ?? Number.POSITIVE_INFINITY,
  );
  const searchScope = Prisma.sql`${visible(scope)}
    ${before ? Prisma.sql`AND m."createdAt" < ${before}` : Prisma.empty}
    ${after ? Prisma.sql`AND m."createdAt" >= ${after}` : Prisma.empty}
    ${Number.isFinite(beforeSeq) ? Prisma.sql`AND m.seq < ${beforeSeq}` : Prisma.empty}`;
  // ponytail: filename matching scans scoped message blocks; add a filename index if scale requires it.
  // Separate ID branches preserve the conversational GIN expression; IN deduplicates exact messages.
  const rows = await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns} FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE m.id IN (
      SELECT m.id FROM messages m JOIN threads t ON t.id = m."threadId"
      WHERE ${searchScope}
        AND to_tsvector('simple', ${searchableText}) @@ plainto_tsquery('simple', ${query})
      UNION ALL
      SELECT m.id FROM messages m JOIN threads t ON t.id = m."threadId"
      WHERE ${searchScope}
        AND m.blocks @> '[{"kind":"file"}]'::jsonb
        AND to_tsvector('simple', ${searchableText} || jsonb_path_query_array(m.blocks,
          '$[*] ? (@.kind == "file").name')::text || regexp_replace(jsonb_path_query_array(m.blocks,
          '$[*] ? (@.kind == "file").name')::text, '[[:punct:]]+', ' ', 'g')) @@ plainto_tsquery('simple', ${query})
    )
    ORDER BY m.seq DESC LIMIT ${limit + 1}
  `);
  const page = rows.slice(0, limit);
  const nextBeforeSeq = rows.length > limit ? page.at(-1)!.seq : null;
  return bounded({
    untrusted: true as const,
    query,
    coverage: {
      scope: "requested_query_and_range" as const,
      status: nextBeforeSeq === null ? ("exhausted" as const) : ("partial" as const),
    },
    messages: page.map((row) => reference(row, query)),
    nextBeforeSeq,
    nextSearch:
      nextBeforeSeq === null
        ? null
        : {
            query,
            beforeSeq: nextBeforeSeq,
            limit,
            ...(input.after !== undefined ? { after: input.after } : {}),
            ...(input.before !== undefined ? { before: input.before } : {}),
          },
  });
}

/** Anchor authorization and neighbor authorization use the same predicate. */
export async function readHistory(
  prisma: PrismaClient,
  scope: HistoryScope,
  input: HistoryReadInput,
  authorizeReceipt?: (route: BoundApprovalRoute) => Promise<boolean>,
) {
  const limit = Math.min(pageSize(input.limit), 5);
  const direction = input.direction ?? "around";
  if (
    input.textOffset !== undefined &&
    (!Number.isInteger(input.textOffset) || input.textOffset < 0)
  )
    throw new Error("Invalid history text offset");
  if (!["around", "older", "newer"].includes(direction))
    throw new Error("Invalid history direction");
  // Another conversation of the same user reads messages only: runs, artifacts and receipts
  // stay bound to the current thread's authorization.
  const crossThread = Boolean(input.threadId && input.threadId !== scope.threadId);
  const where = crossThread ? visible(scope, { mine: input.threadId! }) : visible(scope);
  const anchors = await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns} FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${where} AND m.id = ${input.messageId} LIMIT 1
  `);
  const anchor = anchors[0];
  if (!anchor)
    return {
      untrusted: true as const,
      messages: [],
      runs: [],
      snapshots: [],
      nextRunId: null,
      nextArtifactId: null,
      nextOutcomeSeq: null,
      nextEffectId: null,
      receipt: null,
      olderMessageId: null,
      newerMessageId: null,
    };
  const bound =
    direction === "older"
      ? Prisma.sql`m.seq < ${anchor.seq}`
      : direction === "newer"
        ? Prisma.sql`m.seq > ${anchor.seq}`
        : Prisma.sql`m.seq >= ${Math.max(0, anchor.seq - Math.floor(limit / 2))}`;
  const rows =
    input.textOffset !== undefined && !input.effectId
      ? [anchor]
      : await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns} FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${where} AND ${bound}
    ORDER BY m.seq ${direction === "older" ? Prisma.sql`DESC` : Prisma.sql`ASC`} LIMIT ${limit}
  `);
  rows.sort((a, b) => a.seq - b.seq);
  const anchoredRunIds = rows.flatMap((row) =>
    row.role === "bot" && row.runId ? [row.runId] : [],
  );
  // Source-less background runs require an authorized surviving output anchor.
  const runRows = crossThread
    ? []
    : await prisma.run.findMany({
        where: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          threadId: scope.threadId,
          ...(anchor.groupId ? {} : { botId: scope.botId }),
          ...(input.linkedRunId
            ? { id: input.linkedRunId }
            : input.runAfterId
              ? { id: { gt: input.runAfterId } }
              : {}),
          ...(scope.channelId
            ? {
                sourceMessage: {
                  threadId: scope.threadId,
                  role: "user",
                  blocks: {
                    array_contains: [{ kind: "channel_message", channelId: scope.channelId }],
                  },
                },
              }
            : {
                AND: [
                  {
                    OR: [
                      { sourceMessage: { threadId: scope.threadId } },
                      { sourceMessageId: null, id: { in: anchoredRunIds } },
                    ],
                  },
                ],
              }),
          OR: [
            { sourceMessageId: { in: rows.map((row) => row.id) } },
            { id: { in: anchoredRunIds } },
          ],
        },
        select: {
          id: true,
          botId: true,
          sourceMessageId: true,
          status: true,
          createdAt: true,
          completedAt: true,
        },
        orderBy: { id: "asc" },
        take: LINK_PAGE_SIZE + 1,
      });
  const runs = runRows.slice(0, LINK_PAGE_SIZE);
  const [outcomeRows, artifactRows] = await Promise.all([
    runs.length
      ? prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns} FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${visible(scope)} AND m.role = 'bot' AND m."runId" IN (${Prisma.join(runs.map((run) => run.id))})
      ${input.outcomeAfterSeq !== undefined ? Prisma.sql`AND m.seq > ${input.outcomeAfterSeq}` : Prisma.empty}
    ORDER BY m.seq ASC LIMIT ${LINK_PAGE_SIZE + 1}
  `)
      : Promise.resolve([]),
    runs.length
      ? prisma.artifact.findMany({
          where: {
            spaceId: scope.spaceId,
            userId: scope.userId,
            ...(anchor.groupId
              ? { groupId: anchor.groupId }
              : { botId: scope.botId, groupId: null }),
            runId: { in: runs.map((run) => run.id) },
            ...(input.artifactAfterId ? { id: { gt: input.artifactAfterId } } : {}),
          },
          select: {
            id: true,
            runId: true,
            name: true,
            mimeType: true,
            size: true,
          },
          take: LINK_PAGE_SIZE + 1,
          orderBy: { id: "asc" },
        })
      : Promise.resolve([]),
  ]);
  const outcomes = outcomeRows.slice(0, LINK_PAGE_SIZE);
  const artifacts = artifactRows.slice(0, LINK_PAGE_SIZE);
  const effectRunIds = runs.filter((run) => run.botId === scope.botId).map((run) => run.id);
  const effectWhere: Prisma.ExternalEffectWhereInput = {
    spaceId: scope.spaceId,
    status: "completed",
    runId: { in: effectRunIds },
    run: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      threadId: scope.threadId,
      botId: scope.botId,
    },
    request: { path: ["0"], equals: "__rakazoCatalogTool" },
  };
  const effectSelect = {
    id: true,
    runId: true,
    kind: true,
    status: true,
    createdAt: true,
    request: true,
  } as const;
  const effects: Array<Prisma.ExternalEffectGetPayload<{ select: typeof effectSelect }>> = [];
  let receipt: {
    effectId: string;
    runId: string;
    kind: string;
    text: string;
    textOffset: number;
    nextTextOffset: number | null;
    truncated: boolean;
    offsetUnit: "utf16";
  } | null = null;
  if (input.linkedRunId && authorizeReceipt && effectRunIds.length) {
    let afterId = input.effectAfterId;
    // ponytail: scan only bounded metadata batches; denied routes never become public cursors.
    // If inaccessible receipts dominate at scale, move this filter into an authorized SQL join.
    while (effects.length <= LINK_PAGE_SIZE) {
      const batch = input.effectId
        ? [
            await prisma.externalEffect.findFirst({
              where: { ...effectWhere, id: input.effectId },
              select: effectSelect,
            }),
          ].filter((effect) => effect !== null)
        : await prisma.externalEffect.findMany({
            where: { ...effectWhere, ...(afterId ? { id: { gt: afterId } } : {}) },
            select: effectSelect,
            orderBy: { id: "asc" },
            take: LINK_PAGE_SIZE + 1,
          });
      for (const effect of batch) {
        const details =
          boundDirectApprovalDetails(effect.request, "__rakazoCatalogTool") ??
          catalogApprovalDetails(effect.request, "__rakazoCatalogTool");
        const route = details?.route;
        if (
          (!effect.kind.startsWith("mcp__") &&
            !["connectors_execute_tool", "mcp_execute_tool"].includes(effect.kind)) ||
          route?.connectorId !== "mcp" ||
          !(await authorizeReceipt(route))
        )
          continue;
        effects.push(effect);
        if (input.effectId) {
          // Fetch the result only after current host authorization, preserving the exact bound request.
          const saved = await prisma.externalEffect.findFirst({
            where: {
              ...effectWhere,
              id: effect.id,
              AND: [{ request: { equals: effect.request as Prisma.InputJsonValue } }],
            },
            select: { result: true },
          });
          if (saved) {
            const text = JSON.stringify(saved.result);
            const offset = input.textOffset ?? 0;
            if (
              offset > text.length ||
              (offset > 0 &&
                /^[\uDC00-\uDFFF]/.test(text.slice(offset)) &&
                /[\uD800-\uDBFF]$/.test(text.slice(0, offset)))
            )
              throw new Error("Invalid history receipt text offset");
            let selected = text.slice(offset, offset + 2000);
            if (/[\uD800-\uDBFF]$/.test(selected)) selected = selected.slice(0, -1);
            const end = offset + selected.length;
            receipt = {
              effectId: effect.id,
              runId: effect.runId,
              kind: effect.kind,
              text: selected,
              textOffset: offset,
              nextTextOffset: end < text.length ? end : null,
              truncated: offset > 0 || end < text.length,
              offsetUnit: "utf16",
            };
          }
        }
        if (effects.length > LINK_PAGE_SIZE) break;
      }
      if (input.effectId || batch.length < LINK_PAGE_SIZE + 1) break;
      afterId = batch.at(-1)!.id;
    }
  }
  const effectPage = effects.slice(0, LINK_PAGE_SIZE);
  return bounded({
    untrusted: true as const,
    nextRunId: runRows.length > LINK_PAGE_SIZE ? runs.at(-1)!.id : null,
    nextArtifactId: artifactRows.length > LINK_PAGE_SIZE ? artifacts.at(-1)!.id : null,
    nextOutcomeSeq: outcomeRows.length > LINK_PAGE_SIZE ? outcomes.at(-1)!.seq : null,
    nextEffectId: effects.length > LINK_PAGE_SIZE ? effectPage.at(-1)!.id : null,
    receipt,
    messages: rows.map((row) =>
      reference(
        row,
        "",
        2000,
        row.id === anchor.id && !input.effectId ? (input.textOffset ?? 0) : 0,
      ),
    ),
    runs: runs.map((run) => ({
      ...run,
      outcomes: outcomes.filter((row) => row.runId === run.id).map((row) => reference(row)),
      artifacts: artifacts.filter((artifact) => artifact.runId === run.id),
      effects: effectPage
        .filter((effect) => effect.runId === run.id)
        .map((effect) => ({
          effectId: effect.id,
          kind: effect.kind,
          status: effect.status,
          createdAt: effect.createdAt,
        })),
    })),
    snapshots: rows.map((row) => {
      const linkedRuns = runs.filter(
        (run) => run.sourceMessageId === row.id || run.id === row.runId,
      );
      const outcome = outcomes.find((message) =>
        linkedRuns.some((run) => run.id === message.runId),
      );
      return {
        anchorMessageId: row.id,
        fromSeq: row.seq,
        toSeq: row.seq,
        createdAt: row.createdAt.toISOString(),
        version: createHash("sha256").update(JSON.stringify(row.blocks)).digest("hex"),
        topic: reference(row, "", 200).text,
        openRunIds: linkedRuns
          .filter((run) => !["completed", "failed", "cancelled"].includes(run.status))
          .map((run) => run.id),
        outcome: outcome ? reference(outcome, "", 200).text : null,
        source: "original" as const,
      };
    }),
    olderMessageId: rows[0]?.id ?? null,
    newerMessageId: rows.at(-1)?.id ?? null,
  });
}
