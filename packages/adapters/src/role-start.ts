import { createHash } from "node:crypto";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createGroupInTransaction,
  createThreadMessageInTransaction,
  lockSpaceForContentCreation,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";
import { askedTemplate } from "./turn-report.js";
import { ROLE_START_NONCE } from "./working-state.js";

/**
 * A request for an email template only, with no ask to find people: simulated 11-14, "write me a
 * short first outreach email … and keep it as my template" opened a role whose first card asked
 * about hybrid attendance, and the draft never came.
 */
export function templateOnlyRequest(text: string): boolean {
  return askedTemplate(text) && !FIND_PEOPLE.test(text);
}

const FIND_PEOPLE =
  /\b(?:find|search|source|sourcing|look for|candidates? like)\b|找人|找候选|搜|寻访|物色|찾아|検索|探して/i;

/**
 * A request to write to people the recruiter names with their addresses, with no ask to find
 * people: simulated 11-15, "Noah … and Ada … 写第一封，今晚发" opened a role whose team asked a
 * location question and listed ten strangers before the two emails.
 */
export function writesToNamedPeople(text: string): boolean {
  return /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i.test(text) && !FIND_PEOPLE.test(text);
}

/** Model-facing: start_role refused for a template-only request. */
export const TEMPLATE_NOT_ROLE_NOTE =
  "Not opened: the recruiter asked for an email template, not for people. Write the template in your reply now, from the recruiter to the candidate with {{firstName}} and the role details they gave, and keep it where it can be found: for a saved role they name, save it to that role with ensure_role_campaign and say it is on that role's Sequence tab; with no saved role, save it to memory and say it is kept for when they ask for it by role name, naming no page. Open a role only when they ask to find people.";

/** The parts of a recruiter's own message that a new role conversation starts from. */
function recruiterBlocks(message: {
  role: string;
  botId: string | null;
  clientNonce: string | null;
  blocks: unknown;
}): MessageBlock[] | undefined {
  if (message.role !== "user" || message.botId !== null) return undefined;
  if (message.clientNonce?.startsWith("autocontinue:")) return undefined;
  const blocks = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
  if (!blocks.length || !blocks.every((b) => ["text", "file", "image"].includes(b.kind)))
    return undefined;
  // The global conversation's chat context does not belong to the new role.
  return blocks.map((block) =>
    block.kind === "text" ? { kind: "text" as const, text: block.text } : block,
  );
}

/** The recruiter's latest own message in a conversation, with the blocks a role starts from. */
async function latestRecruiterMessage(
  prisma: Pick<PrismaClient, "message">,
  threadId: string,
): Promise<{ id: string; blocks: MessageBlock[] } | undefined> {
  const recent = await prisma.message.findMany({
    where: { threadId, role: "user", botId: null },
    orderBy: { seq: "desc" },
    take: 10,
    select: {
      id: true,
      role: true,
      botId: true,
      clientNonce: true,
      blocks: true,
      externalTranscriptFor: { select: { id: true } },
    },
  });
  for (const message of recent) {
    const blocks = message.externalTranscriptFor ? undefined : recruiterBlocks(message);
    if (blocks) return { id: message.id, blocks };
  }
  return undefined;
}

/** The id of the role conversation opened under a key. */
export function roleGroupId(key: string): string {
  return `role-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

/** Title letters and digits only, so "Senior Data Engineer — Seattle" is "Senior Data Engineer Seattle". */
function titleCore(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The key a new role is opened under: one recruiter message opens one role, so a later turn or
 * call that asks for it again (a follow-up check, a retry with a reworded title) gets the same
 * role. Staging 11-14: a follow-up turn opened a second "Senior Data Engineer — Seattle" from the
 * same message and both teams emailed the same people. A different role asked for in the same
 * message gets its own key; without a recruiter message the call's own key is used.
 */
export async function roleStartKey(
  prisma: Pick<PrismaClient, "message" | "chatGroup">,
  input: { spaceId: string; userId: string; threadId: string; title: string; fallback: string },
): Promise<string> {
  const asked = await latestRecruiterMessage(prisma, input.threadId);
  if (!asked) return input.fallback;
  const opened = await prisma.chatGroup.findFirst({
    where: { id: roleGroupId(asked.id), spaceId: input.spaceId, userId: input.userId },
    select: { name: true },
  });
  if (!opened) return asked.id;
  const [a, b] = [titleCore(opened.name), titleCore(input.title)];
  return a.includes(b) || b.includes(a) ? asked.id : `${asked.id}:${b}`;
}

/**
 * A role this conversation already opened under the same title, from an earlier recruiter
 * message. Simulated 11-20 (feedback-on-some-people, 3 of 5 runs): "these three are not a fit,
 * next batch like this" went to start_role, which opened a second and third "Senior Data
 * Engineer" role; each started empty, so the turned-down people came back, the location in the
 * JD was asked again, and Results showed no marks.
 */
export async function roleAlreadyOpenedHere(
  prisma: Pick<PrismaClient, "message" | "chatGroup">,
  input: { spaceId: string; userId: string; threadId: string; title: string },
): Promise<{ groupId: string; title: string } | undefined> {
  const asked = await prisma.message.findMany({
    where: { threadId: input.threadId, role: "user", botId: null },
    orderBy: { seq: "desc" },
    take: 20,
    select: { id: true },
  });
  const latest = await latestRecruiterMessage(prisma, input.threadId);
  const core = titleCore(input.title);
  const ids = asked
    .filter((message) => message.id !== latest?.id)
    .flatMap((message) => [roleGroupId(message.id), roleGroupId(`${message.id}:${core}`)]);
  if (!core || !ids.length) return undefined;
  const groups = await prisma.chatGroup.findMany({
    where: { id: { in: ids }, spaceId: input.spaceId, userId: input.userId, archivedAt: null },
    select: { id: true, name: true },
  });
  const same = groups.find((group) => {
    const opened = titleCore(group.name);
    return opened.includes(core) || core.includes(opened);
  });
  return same ? { groupId: same.id, title: same.name } : undefined;
}

/** Model-facing: start_role refused because this role is already open. */
export const roleAlreadyOpenNote = (role: { groupId: string; title: string }) =>
  `Not opened: "${role.title}" is already open (group_id "${role.groupId}"), with its people and the recruiter's earlier requirements. Pass this request to its team with delegate_to_role and that group_id, in the recruiter's own words. Only if the recruiter clearly wants a second, separate role with the same title, call start_role again.`;

/**
 * Open (or find) the role conversation for one start_role call. The key is chosen under the
 * space's content lock, so roles asked for in parallel see each other. Staging 11-16: three
 * parallel calls for Java, Android and Data Engineer each found no role yet, all took the
 * message's first-role key, and only "Java" was opened while Kruit said all three were.
 */
export async function openRoleGroup(
  prisma: Pick<PrismaClient, "$transaction">,
  input: {
    spaceId: string;
    userId: string;
    threadId: string;
    title: string;
    fallback: string;
    botIds: string[];
  },
) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockSpaceForContentCreation(tx, input);
      const roleKey = await roleStartKey(tx, input);
      const group = await createGroupInTransaction(
        tx,
        { spaceId: input.spaceId, userId: input.userId, email: "", isDeploymentOwner: false },
        { id: roleGroupId(roleKey), name: input.title.slice(0, 120), botIds: input.botIds },
      );
      return { roleKey, group };
    }),
  );
}

/**
 * Whether a role conversation was opened from the recruiter's latest message here, so its team
 * already has that request. Staging 11-14: a follow-up turn delegated the same message to the
 * role start_role had just opened, and two runs each made a Send card for the same people.
 */
export async function roleOpenedFromLatestMessage(
  prisma: Pick<PrismaClient, "message">,
  threadId: string,
  role: { groupId: string; title: string },
): Promise<boolean> {
  const asked = await latestRecruiterMessage(prisma, threadId);
  if (!asked) return false;
  return [asked.id, `${asked.id}:${titleCore(role.title)}`].some(
    (key) => roleGroupId(key) === role.groupId,
  );
}

/**
 * Start a new role's conversation from the recruiter's own message in the global
 * conversation: the same words appear there as theirs, and the role team's lead takes
 * its first turn on them, exactly as if they had been written in the role.
 * Returns false when the source is not a message the recruiter wrote.
 */
export async function startRoleFromRecruiterMessage(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: { spaceId: string; userId: string; threadId: string; sourceMessageId?: string | null },
  role: {
    threadId: string;
    botId: string;
    deliveryKey: string;
    /** The role this conversation is for, named when the recruiter's words don't. */
    title?: string;
    /** Requirements Kruit gathered from earlier messages, when the latest one alone lacks them. */
    earlier?: string;
  },
): Promise<boolean> {
  if (!run.sourceMessageId) return false;
  // The recruiter's latest message here: a turn resumed by answering a card keeps the
  // card's original message as its source, but the role was asked for in the answer.
  const blocks = (await latestRecruiterMessage(deps.prisma, run.threadId))?.blocks;
  if (!blocks) return false;
  // A JD sent only as a file still starts the role; its team reads the file.
  const text = blocks
    .flatMap((block) =>
      block.kind === "text" ? [block.text] : block.kind === "file" ? [block.name] : [],
    )
    .join("\n")
    .trim();
  if (!text) return false;
  // Staging 11-13: "现在开始找候选人" opened the role with only those words, so its team asked
  // for the location the recruiter had given earlier, and that card held every later request.
  const earlier = role.earlier?.trim();
  const asked =
    earlier && !text.includes(earlier)
      ? `${text}\n\nWhat the recruiter said about this role earlier, in the main conversation:\n${earlier}`
      : text;
  // Staging 11-16: 「没有就直接帮我建这三个」 opened three roles with the same words, so the
  // Java team asked what the other two are called and Data Engineer asked what 「三个」 means;
  // 「Java、Android、data engineer 三个」 names them all, and Java still set up all three.
  const title = role.title?.trim();
  const prompt = title
    ? `This conversation is for one role: ${title}. The recruiter wrote the message below in the main conversation; any other roles it mentions have their own conversations.\n\n${asked}`
    : asked;
  const clientNonce = `${ROLE_START_NONCE}${role.deliveryKey}`;
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${role.threadId} FOR UPDATE`;
      const already = await tx.message.findUnique({
        where: { threadId_clientNonce: { threadId: role.threadId, clientNonce } },
        select: { id: true },
      });
      if (already) return null;
      const message = await createThreadMessageInTransaction(tx, {
        threadId: role.threadId,
        role: "user",
        blocks,
        clientNonce,
      });
      const task = await tx.task.create({
        data: {
          spaceId: run.spaceId,
          botId: role.botId,
          threadId: role.threadId,
          userId: run.userId,
          prompt,
          status: "queued",
        },
      });
      const next = await tx.run.create({
        data: {
          spaceId: run.spaceId,
          botId: role.botId,
          threadId: role.threadId,
          taskId: task.id,
          userId: run.userId,
          status: "queued",
          trigger: "user",
          sourceMessageId: message.id,
        },
        select: { id: true },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: role.threadId,
        botId: role.botId,
        type: "thread.message.created",
        runId: next.id,
        payload: { messageId: message.id, role: "user", blocks, runIds: [next.id] },
      });
      return { runId: next.id, eventSeq: event.seq };
    }),
  );
  if (!committed) return true;
  await deps.events.notify(role.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("role start realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable; the job reconciler repairs a missed wake.
    getLogger().error("role start enqueue", error);
  });
  return true;
}
