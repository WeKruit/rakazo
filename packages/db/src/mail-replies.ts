import type { Actor, MailReply, MailReplySendAnswer, ThreadMessage } from "@rakazo/contracts";
import { MailReplySendAnswerSchema, MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import {
  boundDirectApprovalDetails,
  boundDirectApprovalRequest,
  catalogApprovalDetails,
  catalogApprovalRequest,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { IsolationError } from "./scope.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const marker = "__rakazoCatalogTool";

/** Only these two mutable fields can enter the saved, one-time native approval. */
export function editMailReplyRequest(
  request: unknown,
  draft: MailReply,
  raw: MailReplySendAnswer,
): Prisma.InputJsonValue {
  const answer = MailReplySendAnswerSchema.parse(raw);
  const direct = boundDirectApprovalDetails(request, marker);
  const catalog = catalogApprovalDetails(request, marker);
  const route = direct?.route ?? catalog?.route;
  const original = direct?.args ?? object(catalog?.args.arguments);
  if (!route || !original || route.resourceId !== draft.inReplyTo.sourceId)
    throw new IsolationError();
  const args = { ...original };
  if (route.connectorId === "mcp" && route.toolName === "reply_to_email") {
    if (
      args.reply_to_uuid !== draft.inReplyTo.emailId ||
      args.eaccount !== draft.from ||
      args.to !== draft.to[0] ||
      args.subject !== draft.subject
    )
      throw new IsolationError();
    args.body_text = answer.body;
    delete args.body_html;
    if (answer.cc.length) args.cc_address_email_list = answer.cc.join(", ");
    else delete args.cc_address_email_list;
  } else if (route.connectorId === "mcp" && route.toolName === "native_instantly_reply_to_email") {
    if (
      args.reply_to_uuid !== draft.inReplyTo.emailId ||
      (args.eaccount !== undefined && args.eaccount !== draft.from) ||
      (args.subject !== undefined && args.subject !== draft.subject)
    )
      throw new IsolationError();
    if (!draft.from) throw new IsolationError();
    args.eaccount = draft.from;
    args.subject = draft.subject;
    args.body = { text: answer.body };
    if (answer.cc.length) args.cc_address_email_list = answer.cc.join(", ");
    else delete args.cc_address_email_list;
  } else if (
    route.connectorId === "composio" &&
    route.toolName.toUpperCase() === "GMAIL_REPLY_TO_THREAD"
  ) {
    if (args.thread_id !== draft.inReplyTo.threadId || args.recipient_email !== draft.to[0])
      throw new IsolationError();
    args.message_body = answer.body;
    args.is_html = false;
    args.cc = answer.cc;
  } else throw new IsolationError();
  return (
    direct
      ? boundDirectApprovalRequest(route, args, marker)
      : catalogApprovalRequest(
          catalog!.toolName,
          { ...catalog!.args, arguments: args },
          marker,
          route,
        )
  ) as Prisma.InputJsonValue;
}

type Effect = {
  status: string;
  request: Prisma.JsonValue;
  result: Prisma.JsonValue | null;
  updatedAt: Date;
};
function state(draft: MailReply, effect: Effect): MailReply {
  const result = object(effect.result);
  const provider = object(result?.providerResult) ?? result;
  const envelope =
    object(object(provider?.structuredContent)?.result) ??
    object(provider?.structuredContent) ??
    object(provider?.data) ??
    provider;
  const payload = object(envelope?.data) ?? envelope;
  const error =
    effect.status === "failed" ||
    provider?.isError === true ||
    provider?.successful === false ||
    envelope?.successful === false ||
    typeof provider?.error === "string" ||
    typeof envelope?.error === "string";
  const direct = boundDirectApprovalDetails(effect.request, marker);
  const catalog = catalogApprovalDetails(effect.request, marker);
  const args = direct?.args ?? object(catalog?.args.arguments);
  const body = object(args?.body);
  const edited =
    typeof args?.body_text === "string"
      ? args.body_text
      : typeof body?.text === "string"
        ? body.text
        : typeof args?.message_body === "string"
          ? args.message_body
          : draft.body;
  // A completed tool without a send receipt is not proof that an email was sent.
  const route = direct?.route ?? catalog?.route;
  const gmailReceipt =
    route?.connectorId === "composio" &&
    route.toolName.toUpperCase() === "GMAIL_REPLY_TO_THREAD" &&
    payload?.threadId === draft.inReplyTo.threadId &&
    (typeof payload?.id === "string" || typeof payload?.messageId === "string");
  const sameAddresses = (value: unknown, expected: string[]) =>
    typeof value === "string" &&
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join("\n") ===
      expected
        .map((item) => item.toLowerCase())
        .sort()
        .join("\n");
  const nativeReceipt =
    payload?.ue_type === 3 &&
    typeof payload?.id === "string" &&
    payload?.eaccount === draft.from &&
    sameAddresses(payload?.to_address_email_list, draft.to) &&
    payload?.subject === draft.subject &&
    object(payload?.body)?.text === edited &&
    sameAddresses(payload?.cc_address_email_list ?? "", draft.cc);
  const sent =
    !error &&
    effect.status === "completed" &&
    (result?.status === "sent_recorded" || nativeReceipt || gmailReceipt);
  return {
    ...draft,
    body: edited,
    status:
      effect.status === "denied"
        ? "discarded"
        : error
          ? "failed"
          : sent
            ? "sent"
            : effect.status === "uncertain" || effect.status === "completed"
              ? "unknown"
              : ["approved", "executing"].includes(effect.status)
                ? "sending"
                : "needs_approval",
    sentAt: sent
      ? typeof payload?.timestamp_email === "string"
        ? payload.timestamp_email
        : effect.updatedAt.toISOString()
      : null,
  };
}

export type MailReplyEffect = Effect & { id: string; runId: string; run: { status: string } };

/** One bounded read enriches the original cards; no duplicate message or send history is written. */
export async function projectMailReplyCards<
  T extends Pick<ThreadMessage, "id" | "runId" | "blocks">,
>(
  prisma: Pick<PrismaClient, "externalEffect">,
  actor: Actor,
  messages: readonly T[],
  prefetchedEffects?: readonly MailReplyEffect[],
): Promise<T[]> {
  const ids = messages.flatMap((message) =>
    message.blocks.flatMap((block) =>
      block.kind === "ask" && block.mailReply && block.approvalEffectId
        ? [block.approvalEffectId]
        : [],
    ),
  );
  if (!ids.length) return [...messages];
  const effects =
    prefetchedEffects ??
    (await prisma.externalEffect.findMany({
      where: {
        id: { in: ids },
        spaceId: actor.spaceId,
        run: { userId: actor.userId, spaceId: actor.spaceId },
      },
      select: {
        id: true,
        runId: true,
        status: true,
        request: true,
        result: true,
        updatedAt: true,
        run: { select: { status: true } },
      },
    }));
  const byId = new Map(effects.map((effect) => [effect.id, effect]));
  return messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block) => {
      if (block.kind !== "ask" || !block.mailReply || !block.approvalEffectId) return block;
      const effect = byId.get(block.approvalEffectId);
      return effect && effect.runId === message.runId
        ? {
            ...block,
            mailReply: {
              ...state(block.mailReply, effect),
              canAnswer:
                block.status === "pending" &&
                effect.status === "intended" &&
                effect.run.status === "waiting_input",
            },
          }
        : block;
    }),
  }));
}

/** Publish a state change on the existing message after its native effect settles. */
export async function publishMailReplyCard(prisma: PrismaClient, actor: Actor, effectId: string) {
  return prisma.$transaction(async (tx) => {
    const effect = await tx.externalEffect.findFirst({
      where: {
        id: effectId,
        spaceId: actor.spaceId,
        run: { userId: actor.userId, spaceId: actor.spaceId },
      },
      include: { run: true },
    });
    if (!effect) return null;
    const message = await tx.message.findFirst({
      where: {
        runId: effect.runId,
        threadId: effect.run.threadId,
        role: "bot",
        blocks: { array_contains: [{ approvalEffectId: effectId }] },
      },
      orderBy: { seq: "desc" },
    });
    const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
    if (!message || !parsed.success) return null;
    const blocks = parsed.data.map((block) =>
      block.kind === "ask" && block.mailReply && block.approvalEffectId === effectId
        ? { ...block, mailReply: { ...state(block.mailReply, effect), canAnswer: false } }
        : block,
    );
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    return appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: effect.run.threadId,
      botId: effect.run.botId,
      runId: effect.runId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks },
    });
  });
}
