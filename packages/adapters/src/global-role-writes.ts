import type { PrismaClient } from "@rakazo/db";

/** Instantly writes that change what a role's campaign sends: they belong to that role's team. */
const ROLE_CAMPAIGN_WRITES = new Set([
  "native_instantly_activate_campaign",
  "native_instantly_pause_campaign",
  "native_instantly_ensure_role_campaign",
  "native_instantly_update_role_draft",
  "native_instantly_clone_role_draft",
  "native_instantly_add_leads",
  "native_instantly_add_shortlist_leads",
]);

/**
 * In Kruit's account-wide conversation, a write to a role's campaign goes to that role's team,
 * which holds the role's email and is the one working on it. Staging 11-14: global Kruit paused a
 * role's confirmed send twice on its own, and once rewrote and re-sent it while the role's team
 * fixed the same campaign, so a mistyped address reached the card. Reads, one-off campaigns that
 * belong to no role, and account setup stay with Kruit. Returns the model-facing refusal.
 */
export async function globalRoleWriteRefusal(
  prisma: Pick<PrismaClient, "externalEffect" | "recruitingRole">,
  actor: { spaceId: string; userId: string },
  call: { toolName: string; args: Record<string, unknown> },
): Promise<string | undefined> {
  if (!ROLE_CAMPAIGN_WRITES.has(call.toolName)) return undefined;
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
  if (!roleId) return undefined;
  const role = await prisma.recruitingRole.findFirst({
    where: { id: roleId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, title: true },
  });
  if (!role) return undefined;
  return `Not done: this changes the email of "${role.title}", which that role's team holds and works on. Hand the recruiter's request to that team with delegate_to_role, role_id "${role.id}", in their own words. In the same reply, answer what they asked from what you have already read (for example why nothing has gone out yet, from the queue time a read gave, as minutes from now), and say in one line that the team is doing the rest.`;
}

/**
 * What Kruit's handoff of the recruiter's turn tells a role's team. Staging 11-15: "3 and 10
 * aren't a fit, find more like the rest" reached the team as Kruit's brief "find the next 20
 * people", so it scaled out and the next round was never built. The recruiter's own words go
 * first, exactly as written; while a round waits on their answer they are the whole request, so
 * the team reads the feedback itself.
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
  if (round && !round.approvedAt) return quoted;
  return input.brief.trim() ? `${quoted}\n\nKruit's brief:\n${input.brief}` : quoted;
}
