import { isDeepStrictEqual } from "node:util";
import { buildApprovalAskBlock } from "@rakazo/adapters";
import type {
  Actor,
  MessageBlock,
  ProductEvent,
  ThreadMessage,
  ThreadMessagePage,
} from "@rakazo/contracts";
import {
  MessageBlock as MessageBlockSchema,
  RecruitingCriterionSchema,
  RecruitingCrmBindingInputSchema,
  RecruitingSourceRefSchema,
  RetainedRecruitingApprovalRequestSchema,
} from "@rakazo/contracts";
import {
  answerableAskMessageIds,
  BACKGROUND_RUN_TRIGGERS,
  callIdFromClientNonce,
  extractRecruitingCrmTarget,
  isBackgroundInputBlock,
  isBackgroundRunTrigger,
  isPeerReceiptBlocks,
  mergeMessagesById,
} from "@rakazo/core";
import { messageReplyPreview } from "@rakazo/core/message-quote";
import type { Prisma, PrismaClient } from "@rakazo/db";

type MessageDb = PrismaClient | Prisma.TransactionClient;

/** Public DTO only: native approval targets and stored blocks remain unchanged. */
export async function projectRecruitingApprovalFiles<
  T extends Pick<ThreadMessage, "id" | "threadId" | "runId" | "botId" | "role" | "blocks">,
>(prisma: MessageDb, actor: Actor, threadId: string, messages: readonly T[]): Promise<T[]> {
  // preview is output metadata, never authority supplied by an artifact, message, or event.
  let clean = messages.map((message) => {
    if (!message.blocks.some((block) => block.kind === "file" && block.preview !== undefined))
      return message;
    return {
      ...message,
      blocks: message.blocks.map((block) => {
        if (block.kind !== "file") return block;
        const { preview: _, ...file } = block;
        return file;
      }),
    };
  });
  const candidates = clean.filter(
    (message) =>
      message.id &&
      message.threadId === threadId &&
      message.role === "bot" &&
      message.runId &&
      message.botId &&
      message.blocks.some((block) => block.kind === "ask" && block.approvalEffectId),
  );
  const ids = [
    ...new Set(
      candidates.flatMap((message) =>
        message.blocks.flatMap((block) =>
          block.kind === "ask" && block.approvalEffectId ? [block.approvalEffectId] : [],
        ),
      ),
    ),
  ];
  if (!ids.length) return clean;

  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const where = {
    spaceId: actor.spaceId,
    run: { ...scope, threadId, thread: scope, bot: scope },
  };
  const select = {
    id: true,
    kind: true,
    runId: true,
    status: true,
    request: true,
    result: true,
    run: { select: { botId: true } },
  } as const;
  const effects = await prisma.externalEffect.findMany({
    where: {
      ...where,
      id: { in: ids },
      kind: { in: ["recruiting_request_approval", "recruiting_crm_target"] },
    },
    select,
  });
  const connections = effects.flatMap((effect) => {
    if (effect.kind !== "recruiting_crm_target") return [];
    const parsed = RecruitingCrmBindingInputSchema.safeParse(effect.request);
    return parsed.success ? [{ effect, input: parsed.data }] : [];
  });
  if (connections.length) {
    const [reads, thread, stored] = await Promise.all([
      prisma.externalEffect.findMany({
        where: {
          ...where,
          id: { in: [...new Set(connections.map(({ input }) => input.crmRoleReadEffectId))] },
          status: "completed",
        },
        select,
      }),
      prisma.thread.findFirst({
        where: { id: threadId, ...scope, activeRecruitingRole: { ...scope, sourceThread: scope } },
        select: {
          activeRecruitingRole: {
            select: {
              id: true,
              title: true,
              crmBindingEffectId: true,
              revision: true,
              currentRevisionId: true,
              currentRevision: { select: { id: true, roleId: true, revision: true } },
            },
          },
        },
      }),
      prisma.message.findMany({
        where: {
          id: { in: candidates.map((message) => message.id) },
          threadId,
          thread: scope,
          role: "bot",
        },
        select: { id: true, runId: true, botId: true, blocks: true },
      }),
    ]);
    const role = thread?.activeRecruitingRole;
    clean = clean.map((message) => {
      if (
        !connections.some(
          ({ effect }) =>
            effect.runId === message.runId &&
            message.blocks.some(
              (block) => block.kind === "ask" && block.approvalEffectId === effect.id,
            ),
        )
      )
        return message;
      return {
        ...message,
        blocks: message.blocks.map((block) => {
          if (block.kind !== "ask" || !candidates.includes(message)) return block;
          const connection = connections.find(
            ({ effect }) =>
              effect.id === block.approvalEffectId &&
              effect.runId === message.runId &&
              effect.run.botId === message.botId,
          );
          const original = stored.find(
            (row) =>
              row.id === message.id && row.runId === message.runId && row.botId === message.botId,
          );
          const parsed = MessageBlockSchema.array().safeParse(original?.blocks);
          if (
            !connection ||
            !parsed.success ||
            !parsed.data.some(
              (saved) => saved.kind === "ask" && saved.approvalEffectId === block.approvalEffectId,
            ) ||
            role?.id !== connection.input.roleId ||
            role.revision !== connection.input.expectedRoleRevision ||
            ((role.crmBindingEffectId ?? null) !== connection.input.expectedBindingEffectId &&
              !(
                connection.effect.status === "completed" &&
                role.crmBindingEffectId === connection.effect.id
              )) ||
            role.currentRevision?.id !== role.currentRevisionId ||
            role.currentRevision.roleId !== role.id ||
            role.currentRevision.revision !== role.revision ||
            !role.title.trim()
          )
            return block;
          const source = reads.find(
            (read) =>
              read.id === connection.input.crmRoleReadEffectId && read.run.botId === message.botId,
          );
          const target = source && extractRecruitingCrmTarget(source);
          if (!target) return block;
          const display = buildApprovalAskBlock(
            connection.effect.id,
            "recruiting_crm_target",
            { operation: "bind", roleTitle: role.title, target },
            [],
          );
          // Presentation only: the original native actions, status and approval identity stay authoritative.
          return { ...block, text: display.text, detail: display.detail };
        }),
      };
    });
  }
  const approvals = effects.flatMap((effect) => {
    const parsed = RetainedRecruitingApprovalRequestSchema.safeParse(effect.request);
    return parsed.success ? [{ effect, input: parsed.data }] : [];
  });
  const inheritedIds = [
    ...new Set(
      approvals.flatMap(({ input }) =>
        input.stage === "calibration" ? [input.documentsApprovalEffectId] : [],
      ),
    ),
  ];
  const inherited = inheritedIds.length
    ? await prisma.externalEffect.findMany({
        where: {
          ...where,
          kind: "recruiting_request_approval",
          id: { in: inheritedIds },
          status: "completed",
        },
        select,
      })
    : [];
  const documents = approvals.flatMap(({ effect, input }) => {
    if (input.stage === "documents") return [{ effect, input }];
    if (input.stage !== "calibration") return [];
    const parent = inherited.find(
      (row) => row.id === input.documentsApprovalEffectId && row.status === "completed",
    );
    const parsed = RetainedRecruitingApprovalRequestSchema.safeParse(parent?.request);
    return parsed.success &&
      parsed.data.stage === "documents" &&
      parsed.data.roleId === input.roleId &&
      parsed.data.expectedRoleRevision === input.expectedRoleRevision
      ? [{ effect, input: parsed.data }]
      : [];
  });
  if (!documents.length) return clean;
  const artifactIds = [...new Set(documents.map(({ input }) => input.documents.jdText.artifactId))];
  const [artifacts, thread] = await Promise.all([
    prisma.artifact.findMany({
      where: { ...scope, id: { in: artifactIds } },
      select: { id: true, hash: true, name: true, mimeType: true, size: true },
    }),
    prisma.thread.findFirst({
      where: { id: threadId, ...scope, activeRecruitingRole: { ...scope, sourceThread: scope } },
      select: {
        activeRecruitingRole: {
          select: {
            id: true,
            revision: true,
            currentRevisionId: true,
            currentRevision: {
              select: { id: true, roleId: true, revision: true, sourceRefs: true, criteria: true },
            },
          },
        },
      },
    }),
  ]);
  const role = thread?.activeRecruitingRole;
  const revision = role?.currentRevision;
  const sources = RecruitingSourceRefSchema.array().safeParse(revision?.sourceRefs);
  const criteria = RecruitingCriterionSchema.array().safeParse(revision?.criteria);
  const refs =
    sources.success && criteria.success
      ? [...sources.data, ...criteria.data.flatMap((criterion) => criterion.sourceRefs)]
      : [];
  return clean.map((message) => {
    if (!candidates.includes(message)) return message;
    const matches = documents.filter(
      ({ effect }) =>
        effect.runId === message.runId &&
        effect.run.botId === message.botId &&
        message.blocks.some(
          (block) => block.kind === "ask" && block.approvalEffectId === effect.id,
        ),
    );
    return {
      ...message,
      blocks: message.blocks.map((block) => {
        if (block.kind !== "file") return block;
        const match = matches.find(
          ({ input }) => input.documents.jdText.artifactId === block.artifactId,
        );
        if (!match) return block;
        const ref = match.input.documents.jdText;
        const artifact = artifacts.find((row) => row.id === ref.artifactId);
        if (
          !artifact ||
          artifact.hash !== ref.sha256 ||
          artifact.name !== block.name ||
          artifact.size !== block.size ||
          artifact.mimeType !== block.mimeType
        )
          return block;
        const source =
          role?.id === match.input.roleId &&
          role.revision === match.input.expectedRoleRevision &&
          revision?.id === role.currentRevisionId &&
          revision.roleId === role.id &&
          revision.revision === role.revision
            ? refs.find(
                (source) =>
                  source.readState === "read" &&
                  source.quote &&
                  source.anchor.kind === "artifact" &&
                  source.anchor.locator === "text" &&
                  source.anchor.artifact.artifactId === ref.artifactId &&
                  source.anchor.artifact.sha256 === ref.sha256 &&
                  refs.every((other) => other.id !== source.id || isDeepStrictEqual(other, source)),
              )
            : undefined;
        return {
          ...block,
          preview: {
            label: "Job description",
            source:
              source && revision
                ? {
                    kind: "role" as const,
                    threadId,
                    roleRevisionId: revision.id,
                    sourceRefId: source.id,
                  }
                : null,
          },
        };
      }),
    };
  });
}

export async function projectRecruitingApprovalEvent(
  prisma: MessageDb,
  actor: Actor,
  threadId: string,
  event: ProductEvent,
): Promise<ProductEvent> {
  if (
    (event.type !== "thread.message.created" && event.type !== "thread.message.updated") ||
    !Array.isArray(event.payload.blocks)
  )
    return event;
  const [message] = await projectRecruitingApprovalFiles(prisma, actor, threadId, [
    {
      id: typeof event.payload.messageId === "string" ? event.payload.messageId : "",
      threadId: event.threadId,
      runId: event.runId,
      botId: event.botId,
      role: event.spaceId === actor.spaceId && event.payload.role === "bot" ? "bot" : "user",
      blocks: event.payload.blocks as MessageBlock[],
    },
  ]);
  return { ...event, payload: { ...event.payload, blocks: message!.blocks } };
}

const replySelection = {
  threadId: true,
  role: true,
  botId: true,
  blocks: true,
} as const;

/** Waiting cards remain accessible independently of the ordinary history page. */
export async function includeWaitingAskMessages(
  prisma: MessageDb,
  page: ThreadMessagePage,
  runs: readonly Pick<
    Prisma.RunGetPayload<Record<string, never>>,
    "id" | "botId" | "spaceId" | "userId" | "status"
  >[],
): Promise<ThreadMessagePage> {
  const loaded = new Set(answerableAskMessageIds({ messages: page.messages, activeRuns: runs }));
  const missing = runs.filter(
    (run) =>
      run.status === "waiting_input" &&
      !page.messages.some((message) => message.runId === run.id && loaded.has(message.id)),
  );
  if (!missing.length) return page;
  const pending = (
    await Promise.all(
      missing.map(async (run) => {
        const where: Prisma.MessageWhereInput = {
          threadId: page.threadId,
          runId: run.id,
          botId: run.botId,
          role: "bot",
          thread: { id: page.threadId, spaceId: run.spaceId, userId: run.userId },
          blocks: { array_contains: [{ kind: "ask" }] },
        };
        const rows = await prisma.message.findMany({
          where,
          orderBy: { seq: "desc" },
          // Native answer lookup inspects the last 50 messages of a paused run.
          take: 50,
          include: { replyTo: { select: replySelection } },
        });
        const messages = rows.reverse().map(toThreadMessage);
        const ids = new Set(answerableAskMessageIds({ messages, activeRuns: [run] }));
        return messages.filter((message) => ids.has(message.id));
      }),
    )
  ).flat();
  if (!pending.length) return page;
  return {
    ...page,
    messages: mergeMessagesById(page.messages, pending).sort((left, right) => left.seq - right.seq),
  };
}

export async function loadMessagePage(
  prisma: MessageDb,
  threadId: string,
  before: number | undefined,
  pageSize: number,
  around?: { messageId?: string; seq?: number },
  includePeerRuns = false,
  includePeerReceipts = false,
): Promise<ThreadMessagePage> {
  if (around) {
    let targetSeq = around.seq;
    if (targetSeq === undefined && around.messageId) {
      const row = await prisma.message.findFirst({
        where: { id: around.messageId, threadId },
        select: { seq: true },
      });
      targetSeq = row?.seq;
    }
    if (targetSeq !== undefined) {
      const half = Math.floor(pageSize / 2);
      const minSeq = Math.max(0, targetSeq - half);
      const maxSeq = targetSeq + half;
      const rows = await prisma.message.findMany({
        where: { threadId, seq: { gte: minSeq, lte: maxSeq } },
        orderBy: { seq: "asc" },
        take: pageSize,
        include: { replyTo: { select: replySelection } },
      });
      const truncated = rows.length >= pageSize;
      const coveredThroughSeq = truncated ? (rows[rows.length - 1]?.seq ?? maxSeq) : maxSeq;
      const first = rows[0];
      const hasOlder = first
        ? (await prisma.message.count({ where: { threadId, seq: { lt: first.seq } } })) > 0
        : false;
      // Peer text/activity stays out of the normal transcript (including the
      // around target). Receipts remain via withoutPeerRunMessages; full peer
      // history belongs in the bot-messages overlay (includePeerRuns).
      const messages = includePeerRuns ? rows : await withoutPeerRunMessages(prisma, rows);
      return {
        threadId,
        messages: messages.map(toThreadMessage),
        olderCursor: hasOlder ? (first?.seq ?? null) : null,
        coveredThroughSeq,
      };
    }
  }

  let cursor = before;
  while (true) {
    const rows = await prisma.message.findMany({
      where: {
        threadId,
        ...(cursor === undefined ? {} : { seq: { lt: cursor } }),
      },
      orderBy: { seq: "desc" },
      take: pageSize + 1,
      include: { replyTo: { select: replySelection } },
    });
    const hasOlder = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize).reverse();
    const visibleRows = includePeerRuns ? pageRows : await withoutPeerRunMessages(prisma, pageRows);
    // Web hides receipts client-side, so its receipt-only pages keep scanning.
    // Mobile explicitly retains them and must receive each page for pagination.
    const hasSubstantive = visibleRows.some(
      (row) => !isPeerReceiptBlocks(row.blocks as MessageBlock[]),
    );
    if (hasSubstantive || includePeerReceipts || !hasOlder || includePeerRuns) {
      return {
        threadId,
        messages: visibleRows.map(toThreadMessage),
        olderCursor: hasOlder ? (pageRows[0]?.seq ?? null) : null,
      };
    }
    // TODO: only rescan when a raw page is entirely peer output. Consider a run relation if
    // long peer-only histories make this path hot.
    cursor = pageRows[0]?.seq;
  }
}

export async function loadAllMessages(
  prisma: PrismaClient,
  threadId: string,
  pageSize: number,
): Promise<ThreadMessage[]> {
  const pages: ThreadMessage[][] = [];
  let before: number | undefined;
  do {
    const page = await loadMessagePage(prisma, threadId, before, pageSize, undefined, true);
    pages.push(page.messages);
    before = page.olderCursor ?? undefined;
  } while (before !== undefined);
  return pages.reverse().flat();
}

async function withoutPeerRunMessages<
  T extends {
    runId: string | null;
    blocks: Prisma.JsonValue;
  },
>(prisma: MessageDb, rows: T[]): Promise<T[]> {
  const runIds = [...new Set(rows.flatMap((row) => (row.runId ? [row.runId] : [])))];
  if (runIds.length === 0) return rows;
  const runs = await prisma.run.findMany({
    where: {
      id: { in: runIds },
      trigger: { in: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
    },
    select: { id: true, trigger: true },
  });
  const backgroundRunIds = new Set(
    runs.filter((run) => isBackgroundRunTrigger(run.trigger)).map((r) => r.id),
  );
  const peerRunIds = new Set(
    runs.filter((run) => !backgroundRunIds.has(run.id)).map((run) => run.id),
  );
  return rows.filter((row) => {
    if (!row.runId) return true;
    const blocks = row.blocks as MessageBlock[];
    if (backgroundRunIds.has(row.runId)) {
      // Ticket work stays off the transcript except existing user-input cards.
      return blocks.some(isBackgroundInputBlock);
    }
    if (!peerRunIds.has(row.runId)) return true;
    // Keep peer receipts (chips), ask cards, and the bot's own text reply.
    return blocks.some(
      (block) =>
        block.kind === "bot_message_sent" ||
        block.kind === "bot_message_received" ||
        block.kind === "ask" ||
        block.kind === "text",
    );
  });
}

export async function isPeerRun(
  prisma: MessageDb,
  runId: string | undefined,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!runId) return false;
  let peerRun = cache.get(runId);
  if (!peerRun) {
    peerRun = prisma.run
      .findUnique({ where: { id: runId }, select: { trigger: true } })
      .then((run) => run?.trigger === "bot_message");
    cache.set(runId, peerRun);
  }
  return peerRun;
}

export async function isBackgroundRun(
  prisma: MessageDb,
  runId: string | undefined,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!runId) return false;
  let backgroundRun = cache.get(runId);
  if (!backgroundRun) {
    backgroundRun = prisma.run
      .findUnique({ where: { id: runId }, select: { trigger: true } })
      .then((run) => isBackgroundRunTrigger(run?.trigger));
    cache.set(runId, backgroundRun);
  }
  return backgroundRun;
}

/** Peer-run SSE events that must still reach an open thread (terminals, waits, receipts, asks, text). */
export function shouldForwardPeerThreadEvent(event: {
  type: string;
  payload: { blocks?: unknown };
}): boolean {
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested"
  ) {
    return true;
  }
  if (event.type !== "thread.message.created" && event.type !== "thread.message.updated") {
    return false;
  }
  const blocks = event.payload.blocks;
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        "kind" in block &&
        (block.kind === "bot_message_received" ||
          block.kind === "bot_message_sent" ||
          block.kind === "ask" ||
          block.kind === "text"),
    )
  );
}

/**
 * A background run's chatter stays off the transcript: no starts, progress, steps,
 * or final text. An open thread still receives the state it needs to answer without
 * a reload — waiting input, computer takeover, and terminal run events — plus the
 * existing user-input cards.
 */
export function shouldForwardBackgroundThreadEvent(event: {
  type: string;
  payload: { blocks?: unknown };
}): boolean {
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested"
  ) {
    return true;
  }
  if (event.type !== "thread.message.created" && event.type !== "thread.message.updated") {
    return false;
  }
  const blocks = event.payload.blocks;
  return Array.isArray(blocks) && blocks.some(isBackgroundInputBlock);
}

function toThreadMessage(row: {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Prisma.JsonValue;
  botId: string | null;
  replyToMessageId: string | null;
  replyQuote: string | null;
  replyTo?: {
    threadId: string;
    role: string;
    botId: string | null;
    blocks: Prisma.JsonValue;
  } | null;
  runId: string | null;
  clientNonce?: string | null;
  createdAt: Date;
}): ThreadMessage {
  const parent = row.replyTo?.threadId === row.threadId ? row.replyTo : null;
  const parsed = parent ? MessageBlockSchema.array().safeParse(parent.blocks) : undefined;
  const replyPreview =
    parent && parsed?.success
      ? messageReplyPreview(
          parsed.data,
          parent.role as ThreadMessage["role"],
          parent.botId ?? undefined,
        )
      : row.replyToMessageId || row.replyQuote != null
        ? null
        : undefined;
  return {
    id: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as ThreadMessage["role"],
    blocks: row.blocks as ThreadMessage["blocks"],
    botId: row.botId ?? undefined,
    replyToMessageId: row.replyToMessageId ?? undefined,
    replyQuote: row.replyQuote ?? undefined,
    replyPreview,
    runId: row.runId ?? undefined,
    callId: callIdFromClientNonce(row.clientNonce),
    createdAt: row.createdAt.toISOString(),
  };
}
