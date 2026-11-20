import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** Instantly writes that change what a role's campaign sends: they belong to that role's conversation while it has a run open. */
const ROLE_CAMPAIGN_WRITES = new Set([
  "native_instantly_activate_campaign",
  "native_instantly_pause_campaign",
  "native_instantly_ensure_role_campaign",
  "native_instantly_update_role_draft",
  "native_instantly_clone_role_draft",
  "native_instantly_add_leads",
  "native_instantly_add_shortlist_leads",
]);

/** The people-search tools. */
export const PEOPLE_SEARCH_TOOLS: ReadonlySet<string> = new Set([
  "web_search_exa",
  "web_search_advanced_exa",
  "agent_run",
]);

/** The saved role a campaign write is for, by its role_id or the role its campaign is bound to. */
async function campaignRole(
  prisma: Pick<PrismaClient, "externalEffect" | "recruitingRole">,
  actor: { spaceId: string; userId: string },
  call: { toolName: string; args: Record<string, unknown> },
): Promise<{ id: string; title: string } | null> {
  if (!ROLE_CAMPAIGN_WRITES.has(call.toolName)) return null;
  let roleId = typeof call.args.role_id === "string" ? call.args.role_id : undefined;
  const campaignId = typeof call.args.campaign_id === "string" ? call.args.campaign_id : undefined;
  if (!roleId && campaignId) {
    const binding = await prisma.externalEffect.findFirst({
      where: {
        spaceId: actor.spaceId,
        kind: "instantly_role_campaign",
        status: "completed",
        result: { path: ["campaignId"], equals: campaignId },
      },
      select: { request: true },
    });
    const bound = (binding?.request as { roleId?: unknown } | null)?.roleId;
    roleId = typeof bound === "string" ? bound : undefined;
  }
  if (!roleId) return null;
  const role = await prisma.recruitingRole.findFirst({
    where: { id: roleId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, title: true },
  });
  return role;
}

/**
 * A role's conversation changes only its own role's campaigns. Simulated 11-20 (stop-after-approve):
 * 「全停掉」 in one role's conversation also paused two other roles' campaigns.
 */
export async function otherRoleWriteRefusal(
  prisma: Pick<PrismaClient, "externalEffect" | "recruitingRole">,
  actor: { spaceId: string; userId: string },
  activeRoleId: string,
  call: { toolName: string; args: Record<string, unknown> },
): Promise<string | undefined> {
  const role = await campaignRole(prisma, actor, call);
  if (!role || role.id === activeRoleId) return undefined;
  return `Not done: that campaign belongs to another role, "${role.title}". This conversation changes only its own role's emails; leave other roles' as they are and say in one line what you changed here.`;
}

/**
 * One owner per role's campaign: Kruit changes a role's campaign itself unless that role's own
 * conversation has a run open right now (working, or paused on the recruiter's card), which then
 * owns it. Staging 11-14: global Kruit paused a role's confirmed send while the role's team was
 * fixing the same campaign, so a mistyped address reached the card. Read from the run records, not
 * from which conversation asks. Returns the model-facing refusal.
 */
export async function globalRoleWriteRefusal(
  prisma: Pick<PrismaClient, "externalEffect" | "recruitingRole" | "run">,
  actor: { spaceId: string; userId: string; threadId: string },
  call: { toolName: string; args: Record<string, unknown> },
): Promise<string | undefined> {
  const role = await campaignRole(prisma, actor, call);
  if (!role) return undefined;
  const open = await prisma.run.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
      threadId: { not: actor.threadId },
      thread: { activeRecruitingRoleId: role.id },
    },
    select: { status: true },
  });
  if (!open) return undefined;
  const now =
    open.status === "waiting_input" ? "is waiting on the recruiter's card" : "is working on it now";
  return `Not done: the conversation of "${role.title}" ${now}, so it owns this change. Pass the recruiter's request to it with delegate_to_role, role_id "${role.id}", in their own words, instead of a second change here. In the same reply, answer what they asked from what you have already read.`;
}

/**
 * What Kruit's handoff of the recruiter's turn tells a role's team. Staging 11-15: "3 and 10
 * aren't a fit, find more like the rest" reached the team as Kruit's brief "find the next 20
 * people", so it scaled out and the next round was never built. The recruiter's own words go
 * first, exactly as written; while a round waits on their answer they are the whole request (Kruit's
 * note after them only says who it is about), so the team reads the feedback itself.
 */
export async function roleRequestMessage(
  prisma: Pick<PrismaClient, "recruitingCalibrationRound">,
  input: { roleId?: string; recruiterWords: string; brief: string },
): Promise<string> {
  const words = input.recruiterWords.trim();
  if (!words) return input.brief;
  const quoted = `The recruiter wrote, word for word:\n"${words}"`;
  const round = input.roleId
    ? await prisma.recruitingCalibrationRound.findFirst({
        where: { roleId: input.roleId },
        orderBy: { round: "desc" },
        select: { approvedAt: true },
      })
    : null;
  // team-has-no-email 11-16: with the brief dropped, 「没存的话现在怎么办？」 reached the team
  // without the person Kruit named, and it answered about someone else.
  if (round && !round.approvedAt)
    return input.brief.trim()
      ? `${quoted}\n\nKruit's note, only on who and what this refers to; the request is the recruiter's words above, never a number of people or a scale-out this note adds:\n${input.brief}`
      : quoted;
  return input.brief.trim() ? `${quoted}\n\nKruit's brief:\n${input.brief}` : quoted;
}
