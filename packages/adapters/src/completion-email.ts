import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { truncatedPlainText } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { recruitingResearchInFlight } from "./recruiting-research-poll.js";

/**
 * "Email me when this finishes": the recruiter's answer to an agent's offer on long work is
 * kept as an effect row on the turn that recorded it, and the server sends one email to the
 * recruiter's own account address when a later turn ends with nothing else still running in
 * the conversation. Nothing else is sent, so no approval card is involved.
 */
export const COMPLETION_EMAIL_TOOL = "email_when_done";
export const COMPLETION_EMAIL_KIND = "completion_email";
const BODY_MAX_CHARS = 3_000;
const BUSY = ["queued", "leased", "running"];
/** Grading and reply check-ins run on their own and never report back as the end of a task. */
const SIDE_TRIGGERS = ["recruiting_grade", "recruiting_checkin"];

export const completionEmailTool = {
  name: COMPLETION_EMAIL_TOOL,
  description:
    'When work you start or hand off will likely take more than five to ten minutes (for example a large or hard search), ask the recruiter once with ask_user, in English: "Want an email when this finishes? It keeps running in the background." with the options "Yes, email me" and "No thanks". Then call this with their answer and carry on with the work. Never ask again in this conversation once they answered. With email true the server emails the recruiter\'s own account address once all of this work has finished, with your final message; it goes only to them, so it needs no approval card.',
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "boolean", description: "The recruiter's answer: true for yes." },
    },
    required: ["email"],
    additionalProperties: false,
  },
};

/** Added to a long stage's first check-in when the recruiter has not been asked yet. */
export const COMPLETION_EMAIL_OFFER = `This is long work: if the recruiter has not been offered an email yet, ask them now with one ask_user card, "Want an email when this finishes? It keeps running in the background.", and record their answer with ${COMPLETION_EMAIL_TOOL}.`;

type Turn = { id: string; spaceId: string; threadId: string; botId: string; userId: string };

/** Record the recruiter's answer; a later yes replaces an earlier one still waiting. */
export async function recordCompletionEmailChoice(
  prisma: PrismaClient,
  run: Turn,
  args: Record<string, unknown>,
): Promise<{ ok: true; email: boolean } | { error: string }> {
  if (typeof args.email !== "boolean") return { error: "email must be true or false." };
  await prisma.externalEffect.updateMany({
    where: {
      kind: COMPLETION_EMAIL_KIND,
      status: "armed",
      spaceId: run.spaceId,
      run: { threadId: run.threadId },
    },
    data: { status: "replaced" },
  });
  await prisma.externalEffect.upsert({
    where: { idempotencyKey: `${COMPLETION_EMAIL_KIND}:${run.id}` },
    create: {
      spaceId: run.spaceId,
      runId: run.id,
      kind: COMPLETION_EMAIL_KIND,
      idempotencyKey: `${COMPLETION_EMAIL_KIND}:${run.id}`,
      status: args.email ? "armed" : "declined",
      request: { botId: run.botId, threadId: run.threadId },
    },
    update: { status: args.email ? "armed" : "declined" },
  });
  return { ok: true, email: args.email };
}

/** Whether the recruiter already answered an email offer in this conversation. */
export async function completionEmailAnswered(
  prisma: Pick<PrismaClient, "externalEffect">,
  run: { spaceId: string; threadId: string },
): Promise<boolean> {
  return Boolean(
    await prisma.externalEffect.findFirst({
      where: { kind: COMPLETION_EMAIL_KIND, spaceId: run.spaceId, run: { threadId: run.threadId } },
      select: { id: true },
    }),
  );
}

/**
 * Called when a turn ends (or stops on a question). Sends the waiting email when the yes was
 * recorded on an earlier turn and no other turn or role research is still running here. The
 * body is what the turn said, else the conversation's latest reply (a coordinator that only
 * checked a teammate's result says nothing itself). Never throws: the turn is already over.
 */
export async function sendCompletionEmailIfDone(
  deps: { prisma: PrismaClient; email?: TransactionalEmailProvider; webOrigin?: string },
  run: Turn,
  ended: { text: string; groupId: string | null; continuing: boolean; question?: boolean },
): Promise<void> {
  if (!deps.email || ended.continuing) return;
  try {
    const armed = await deps.prisma.externalEffect.findFirst({
      where: {
        kind: COMPLETION_EMAIL_KIND,
        status: "armed",
        spaceId: run.spaceId,
        run: { threadId: run.threadId },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, runId: true, request: true },
    });
    if (!armed || armed.runId === run.id) return;
    const busy = await deps.prisma.run.count({
      where: {
        threadId: run.threadId,
        id: { not: run.id },
        status: { in: BUSY },
        trigger: { notIn: SIDE_TRIGGERS },
      },
    });
    if (busy) return;
    const thread = await deps.prisma.thread.findUnique({
      where: { id: run.threadId },
      select: { activeRecruitingRole: { select: { id: true, title: true } } },
    });
    const role = thread?.activeRecruitingRole;
    if (role && (await recruitingResearchInFlight(deps.prisma, role.id))) return;
    const body = ended.text.trim() || (await latestReply(deps.prisma, run.threadId));
    if (!body) return;
    const claimed = await deps.prisma.externalEffect.updateMany({
      where: { id: armed.id, status: "armed" },
      data: { status: "sending" },
    });
    if (claimed.count !== 1) return;
    const user = await deps.prisma.user.findUnique({
      where: { id: run.userId },
      select: { email: true },
    });
    if (!user?.email) {
      await settle(deps.prisma, armed.id, "failed", { error: "no account email" });
      return;
    }
    const title = role?.title?.trim() || "Your task";
    const link = deps.webOrigin
      ? new URL(ended.groupId ? `/app/g/${ended.groupId}` : `/app/${run.botId}`, deps.webOrigin)
          .href
      : undefined;
    try {
      await deps.email.send({
        to: user.email,
        subject: ended.question ? `${title}: your answer is needed` : `${title} is done`,
        text: [truncatedPlainText(body, BODY_MAX_CHARS), link ? `Open it: ${link}` : ""]
          .filter(Boolean)
          .join("\n\n"),
      });
      await settle(deps.prisma, armed.id, "sent", { sentByRunId: run.id });
    } catch (error) {
      await settle(deps.prisma, armed.id, "failed", { error: String(error).slice(0, 300) });
      getLogger().error("completion email", error);
    }
  } catch (error) {
    getLogger().error("completion email check", error);
  }
}

/** The text of the newest agent message the recruiter sees in this conversation. */
async function latestReply(prisma: PrismaClient, threadId: string): Promise<string> {
  const messages = await prisma.message.findMany({
    where: { threadId, role: "bot" },
    orderBy: { seq: "desc" },
    take: 10,
    select: { blocks: true },
  });
  for (const message of messages) {
    const blocks = Array.isArray(message.blocks) ? message.blocks : [];
    const text = blocks
      .flatMap((block) => {
        const value = block as { kind?: unknown; text?: unknown };
        return value.kind === "text" && typeof value.text === "string" ? [value.text] : [];
      })
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

async function settle(
  prisma: PrismaClient,
  id: string,
  status: "sent" | "failed",
  result: Record<string, string>,
) {
  await prisma.externalEffect
    .update({ where: { id }, data: { status, result } })
    .catch((error) => getLogger().error("completion email status", error));
}
