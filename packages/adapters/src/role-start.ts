import { createHash } from "node:crypto";
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
import { ROLE_START_NONCE } from "./working-state.js";

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

/** The recruiter's own messages in a conversation, newest first, with the blocks a role starts from. */
async function recruiterMessages(
  prisma: Pick<PrismaClient, "message">,
  threadId: string,
  count: number,
  /** The newest message to count from; messages written after it are left out. */
  upToId?: string,
): Promise<{ id: string; blocks: MessageBlock[] }[]> {
  const recent = await prisma.message.findMany({
    where: { threadId, role: "user", botId: null },
    orderBy: { seq: "desc" },
    take: 10 + count,
    select: {
      id: true,
      role: true,
      botId: true,
      clientNonce: true,
      blocks: true,
      externalTranscriptFor: { select: { id: true } },
    },
  });
  const own = recent.flatMap((message) => {
    const blocks = message.externalTranscriptFor ? undefined : recruiterBlocks(message);
    return blocks ? [{ id: message.id, blocks }] : [];
  });
  const from = upToId ? own.findIndex((message) => message.id === upToId) : 0;
  return own.slice(Math.max(0, from)).slice(0, count);
}

/** The recruiter's latest own message in a conversation. */
async function latestRecruiterMessage(
  prisma: Pick<PrismaClient, "message">,
  threadId: string,
): Promise<{ id: string; blocks: MessageBlock[] } | undefined> {
  return (await recruiterMessages(prisma, threadId, 1))[0];
}

/**
 * The files of the recruiter's latest own message, by saved id: a child job receives only what its
 * request holds (Claude Code subagents: "include any file paths ... directly in that prompt").
 */
export async function latestRecruiterFiles(
  prisma: Pick<PrismaClient, "message">,
  threadId: string,
): Promise<string[]> {
  return ((await latestRecruiterMessage(prisma, threadId))?.blocks ?? []).flatMap((block) =>
    block.kind === "file" || block.kind === "image"
      ? [`${block.name} (artifact ${block.artifactId})`]
      : [],
  );
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
  input: {
    spaceId: string;
    userId: string;
    threadId: string;
    title: string;
    fallback: string;
    /** The recruiter's latest message, when the caller already read it. */
    asked?: { id: string } | null;
  },
): Promise<string> {
  const asked =
    input.asked === undefined ? await latestRecruiterMessage(prisma, input.threadId) : input.asked;
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
  input: {
    spaceId: string;
    userId: string;
    threadId: string;
    title: string;
    /** The recruiter's latest message, when the caller already read it. */
    asked?: { id: string } | null;
  },
): Promise<{ groupId: string; title: string } | undefined> {
  const asked = await prisma.message.findMany({
    where: { threadId: input.threadId, role: "user", botId: null },
    orderBy: { seq: "desc" },
    take: 20,
    select: { id: true },
  });
  const latest =
    input.asked === undefined ? await latestRecruiterMessage(prisma, input.threadId) : input.asked;
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

/** Model-facing: a new role refused because this role is already open. */
export const roleAlreadyOpenNote = (role: { groupId: string; title: string }) =>
  `Not opened: "${role.title}" is already open (group_id "${role.groupId}"), with its people and the recruiter's earlier requirements. A second call opens a second role with the same title.`;

/**
 * Open (or find) the role conversation for one new role (delegate_work new_role). The key is chosen under the
 * space's content lock, so roles asked for in parallel see each other. Staging 11-16: three
 * parallel calls for Java, Android and Data Engineer each found no role yet, all took the
 * message's first-role key, and only "Java" was opened while Kruit said all three were.
 *
 * The recruiter's latest message is read once here, and the already-open check, the key and the
 * words the role starts from all use that one reading. Staging 11-26: a second message arrived
 * between the check and the key, so a role already open from the JD was opened again under the
 * new message and started with only 「对了，远程也可以」, no JD.
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
    /** Roles this turn was already told are open; asking again opens a second one. */
    overruled: ReadonlySet<string>;
  },
) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockSpaceForContentCreation(tx, input);
      const asked = (await latestRecruiterMessage(tx, input.threadId)) ?? null;
      const openHere = await roleAlreadyOpenedHere(tx, { ...input, asked });
      if (openHere && !input.overruled.has(openHere.groupId)) return { openHere };
      const roleKey = await roleStartKey(tx, { ...input, asked });
      const group = await createGroupInTransaction(
        tx,
        { spaceId: input.spaceId, userId: input.userId, email: "", isDeploymentOwner: false },
        { id: roleGroupId(roleKey), name: input.title.slice(0, 120), botIds: input.botIds },
      );
      return { roleKey, group, askedMessageId: asked?.id };
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
 * Copy the recruiter's own message from the global conversation into a new role's conversation,
 * so the same words (and files) appear there as theirs. The role team is then asked through
 * message_bot like any delegated request, and its final result returns the same way. Returns the
 * request to send, or undefined when the source is not a message the recruiter wrote.
 */
export async function copyRecruiterMessageToRole(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: { spaceId: string; threadId: string; sourceMessageId?: string | null },
  role: {
    threadId: string;
    botId: string;
    deliveryKey: string;
    /** The role this conversation is for, named when the recruiter's words don't. */
    title?: string;
    /**
     * How many of the recruiter's messages before the latest also belong to this role, as Kruit
     * counted them. They are copied with the latest one, oldest first. Staging 11-26: after
     * Stop the recruiter wrote 「继续吧」 and the role opened with only those words, no JD.
     */
    earlierMessages?: number;
    /** The recruiter message the role was opened from; later messages are not copied. */
    askedMessageId?: string;
  },
): Promise<string | undefined> {
  if (!run.sourceMessageId) return undefined;
  // The recruiter's latest message here: a turn resumed by answering a card keeps the
  // card's original message as its source, but the role was asked for in the answer.
  const blocks = (
    await recruiterMessages(
      deps.prisma,
      run.threadId,
      1 + (role.earlierMessages ?? 0),
      role.askedMessageId,
    )
  )
    .reverse()
    .flatMap((message) => message.blocks);
  if (!blocks.length) return undefined;
  // A JD sent only as a file still starts the role; its team reads the file.
  const text = blocks
    .flatMap((block) =>
      block.kind === "text" ? [block.text] : block.kind === "file" ? [block.name] : [],
    )
    .join("\n")
    .trim();
  if (!text) return undefined;
  // Staging 11-16: 「没有就直接帮我建这三个」 opened three roles with the same words, so the
  // Java team asked what the other two are called and Data Engineer asked what 「三个」 means;
  // 「Java、Android、data engineer 三个」 names them all, and Java still set up all three.
  const title = role.title?.trim();
  // A delegated agent receives only what its request holds (Claude Code subagents: "include any file
  // paths ... directly in that prompt"), so the files go in by their saved ids.
  const files = blocks.flatMap((block) =>
    block.kind === "file" || block.kind === "image"
      ? [`${block.name} (artifact ${block.artifactId})`]
      : [],
  );
  const request = [
    `New role${title ? `: ${title}` : ""}. The recruiter's message above, copied from the main conversation, is the request${title ? "; any other roles it mentions have their own conversations" : ""}.`,
    ...(files.length ? [`Files the recruiter attached: ${files.join(", ")}.`] : []),
  ].join("\n\n");
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
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: role.threadId,
        botId: role.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "user", blocks, runIds: [] },
      });
      return { eventSeq: event.seq };
    }),
  );
  if (committed)
    await deps.events.notify(role.threadId, committed.eventSeq).catch((error) => {
      getLogger().error("role start realtime notification", error);
    });
  return request;
}
