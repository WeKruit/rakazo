import { RECRUITING_GLOBAL_AGENT_NAME } from "@rakazo/core";
import { roleReferents } from "@rakazo/db";
import { messageBot } from "./bot-messages.js";
import type { ExecutorDeps } from "./executor.js";
import { delegatedRequestMessage } from "./global-role-writes.js";
import {
  copyRecruiterMessageToRole,
  earlierRecruiterWords,
  isRolelessHomeTeam,
  latestRecruiterFiles,
  openRoleGroup,
  roleAlreadyOpenNote,
  roleOpenedFromLatestMessage,
} from "./role-start.js";

/**
 * The account-wide conversation's one way to give work out (harness step D, 11-28): a child job for
 * the agent that owns it, in that agent's own conversation, the way Workloop's `agent` tool starts a
 * child (PRD §1.6) and Claude Code names a subagent type. A role's work runs in the role's
 * conversation; work in no role runs in the named agent's own private conversation (nightly 11-28:
 * a follow-up template opened a role named after the template). The child's final answer comes
 * back once its conversation is idle (bot-messages.ts, returnBotMessageOutcome), and a card it waits
 * on is shown in the asking conversation (showDelegatedTeamCard).
 */
export type DelegateWorkArgs = {
  agent?: unknown;
  role_id?: unknown;
  group_id?: unknown;
  new_role?: unknown;
  earlier_messages?: unknown;
  people?: unknown;
  round?: unknown;
};

export type DelegateWorkContext = {
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">;
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  };
  bot: { id: string; name: string };
  groupId: string | null | undefined;
  /** The recruiter's own newest words this turn, which are the request. */
  words: string;
  deliveryKey: string;
  redact: (text: string) => string;
  /** Recruiter-facing text with supplier names hidden (role titles). */
  visible: (text: string) => string;
  showRoleCard: (role: { groupId: string; title: string }) => Promise<unknown>;
  /** Conversations already given this turn's request: one owner each. */
  given: Set<string>;
  /** Roles this turn was already told are open; naming one again opens a second. */
  overruled: Set<string>;
};

type Target = {
  threadId: string;
  /** The role conversation, when the work is a role's. */
  groupId?: string;
  title: string;
  roleId?: string;
  recipient: { id: string; name: string };
};

export async function delegateWork(
  ctx: DelegateWorkContext,
  args: DelegateWorkArgs,
): Promise<{ error: string } | ({ ok: true } & Record<string, unknown>)> {
  if (!ctx.groupId?.startsWith("recruiting-global-"))
    return { error: "delegate_work works only in the account-wide conversation." };
  const agent = String(args.agent ?? "").trim();
  const newRole = ctx.visible(ctx.redact(String(args.new_role ?? ""))).trim();
  const target = newRole
    ? await newRoleTarget(ctx, newRole, args)
    : args.role_id || args.group_id
      ? await roleTarget(ctx, args, agent)
      : agent
        ? await ownConversation(ctx, agent)
        : { error: "Pass agent for work in no role, or the role's roleId, groupId or new_role." };
  if ("error" in target) return target;
  if (
    !newRole &&
    target.groupId &&
    (await roleOpenedFromLatestMessage(ctx.deps.prisma, ctx.run.threadId, {
      groupId: target.groupId,
      title: target.title,
    }))
  )
    return {
      ok: true,
      given: target.title,
      note: "Already given: the role was opened from this same message; nothing more was sent.",
    };
  // Staging 426d09b9, stop-after-approve: two hand-offs of one request a second apart gave the role
  // two runs racing on the same send card.
  if (ctx.given.has(target.threadId))
    return {
      ok: true,
      given: target.title,
      note: "Already given in this turn; nothing more was sent.",
    };
  ctx.given.add(target.threadId);
  const words = ctx.words.trim();
  if (!words && !target.opening) {
    ctx.given.delete(target.threadId);
    return { error: "Not given: this turn has no recruiter words to hand over." };
  }
  // Only structured referents go with the recruiter's words; Kruit writes no brief (the user's
  // decision 11-27 08:36: 只传原话加指代). Play s174: a free brief added 「并继续做下一轮」.
  const refs = Array.isArray(args.people) ? args.people.map(String) : [];
  const referents =
    refs.length && target.roleId
      ? await roleReferents(ctx.deps.prisma, target.roleId, refs)
      : { people: [], unknown: refs };
  const round = Number.isInteger(args.round) ? Number(args.round) : undefined;
  const files = target.opening ? [] : await latestRecruiterFiles(ctx.deps.prisma, ctx.run.threadId);
  // Branch play 11-28 (step D): work in no role got only the recruiter's newest words, without the
  // email they referred to; the earlier messages go verbatim, counted as new_role counts them.
  const earlier = target.opening
    ? []
    : await earlierRecruiterWords(ctx.deps.prisma, ctx.run.threadId, earlierCount(args));
  const sent = await messageBot(ctx.deps, ctx.run, ctx.bot, {
    bot_id: target.recipient.id,
    thread_id: target.threadId,
    sender_label: RECRUITING_GLOBAL_AGENT_NAME,
    target_label: target.groupId ? `${target.title} team` : target.recipient.name,
    message: ctx.redact(
      target.opening ?? delegatedRequestMessage(words, referents.people, round, files, earlier),
    ),
    ...(words ? { recruiter_words: ctx.redact(words) } : {}),
    intent: "request",
    deliveryKey: target.deliveryKey ?? ctx.deliveryKey,
  });
  if (!sent.ok) {
    ctx.given.delete(target.threadId);
    return { error: sent.error };
  }
  // A role's card is what the recruiter opens while its team works (handoff8 11-27: a line written
  // before the work said "I've drafted a reply" though nothing was drafted). Work in no role has no
  // card of its own: its answer, or a card it waits on, comes back here.
  if (target.groupId) await ctx.showRoleCard({ groupId: target.groupId, title: target.title });
  return {
    ok: true,
    given: target.title,
    ...(referents.unknown.length ? { notSavedPeople: referents.unknown } : {}),
  };
}

const earlierCount = (args: DelegateWorkArgs) =>
  Math.min(10, Math.max(0, Math.trunc(Number(args.earlier_messages) || 0)));

type Resolved = (Target & { opening?: string; deliveryKey?: string }) | { error: string };

/** A teammate by name among a conversation's members, or its lead (the asking bot) by default. */
async function member(
  ctx: DelegateWorkContext,
  groupId: string,
  agent: string,
): Promise<{ id: string; name: string } | { error: string }> {
  if (!agent) return ctx.bot;
  const members = await ctx.deps.prisma.chatGroupMember.findMany({
    where: { groupId },
    select: { bot: { select: { id: true, name: true, archivedAt: true } } },
  });
  const live = members.filter((row) => !row.bot.archivedAt).map((row) => row.bot);
  const match = live.find((bot) => bot.name.toLowerCase() === agent.toLowerCase());
  return match
    ? { id: match.id, name: match.name }
    : { error: `No agent named ${agent} here. Agents: ${live.map((bot) => bot.name).join(", ")}.` };
}

async function roleTarget(
  ctx: DelegateWorkContext,
  args: DelegateWorkArgs,
  agent: string,
): Promise<Resolved> {
  const { prisma } = ctx.deps;
  const scope = { spaceId: ctx.run.spaceId, userId: ctx.run.userId, archivedAt: null };
  const role = args.role_id
    ? await prisma.recruitingRole.findFirst({
        where: { id: String(args.role_id), ...scope },
        select: { title: true, sourceThread: { select: { id: true, groupId: true } } },
      })
    : null;
  const group =
    role?.sourceThread.groupId ||
    !args.group_id ||
    String(args.group_id).startsWith("recruiting-global-")
      ? null
      : await prisma.chatGroup.findFirst({
          where: { id: String(args.group_id), ...scope },
          select: {
            id: true,
            name: true,
            thread: { select: { id: true, activeRecruitingRoleId: true } },
          },
        });
  if (group && isRolelessHomeTeam(ctx.run, group))
    return {
      error: "Not given: that conversation holds no role; for work in no role pass only agent.",
    };
  const found = role?.sourceThread.groupId
    ? {
        groupId: role.sourceThread.groupId,
        threadId: role.sourceThread.id,
        title: role.title ?? "",
        roleId: String(args.role_id),
      }
    : group?.thread
      ? {
          groupId: group.id,
          threadId: group.thread.id,
          title: group.name,
          roleId: group.thread.activeRecruitingRoleId ?? undefined,
        }
      : null;
  if (!found) return { error: "No active role with that roleId or groupId." };
  const recipient = await member(ctx, found.groupId, agent);
  if ("error" in recipient) return recipient;
  return { ...found, recipient };
}

/** Work in no role: the named agent's own private conversation (every bot has one). */
async function ownConversation(ctx: DelegateWorkContext, agent: string): Promise<Resolved> {
  const recipient = await member(ctx, ctx.groupId!, agent);
  if ("error" in recipient) return recipient;
  const own = await ctx.deps.prisma.thread.findFirst({
    where: {
      botId: recipient.id,
      spaceId: ctx.run.spaceId,
      userId: ctx.run.userId,
      bot: { archivedAt: null },
    },
    select: { id: true },
  });
  if (!own) return { error: `${recipient.name} has no conversation to work in.` };
  return { threadId: own.id, title: recipient.name, recipient };
}

/** A new role: open its conversation, copy the recruiter's message there, and give it to its lead. */
async function newRoleTarget(
  ctx: DelegateWorkContext,
  title: string,
  args: DelegateWorkArgs,
): Promise<Resolved> {
  const { prisma } = ctx.deps;
  const team = await prisma.chatGroupMember.findMany({
    where: { groupId: ctx.groupId! },
    select: { botId: true },
    orderBy: { createdAt: "asc" },
  });
  const opened = await openRoleGroup(prisma, {
    spaceId: ctx.run.spaceId,
    userId: ctx.run.userId,
    threadId: ctx.run.threadId,
    title,
    fallback: ctx.deliveryKey,
    botIds: team.map((row) => row.botId),
    overruled: ctx.overruled,
  });
  if (opened.openHere) {
    ctx.overruled.add(opened.openHere.groupId);
    return { error: roleAlreadyOpenNote(opened.openHere) };
  }
  const { roleKey, group, askedMessageId } = opened;
  if (!group.thread) return { error: "The role conversation could not be opened." };
  // Its conversation first shows the recruiter's own message, so the role starts from their words.
  const opening = await copyRecruiterMessageToRole(ctx.deps, ctx.run, {
    threadId: group.thread.id,
    botId: ctx.bot.id,
    deliveryKey: roleKey,
    title,
    earlierMessages: earlierCount(args),
    askedMessageId,
  });
  if (!opening)
    return { error: "Not opened: the recruiter's latest message has no request to hand over." };
  const recipient = await member(ctx, group.id, String(args.agent ?? "").trim());
  if ("error" in recipient) return recipient;
  return {
    groupId: group.id,
    threadId: group.thread.id,
    title,
    recipient,
    opening,
    deliveryKey: roleKey,
  };
}
