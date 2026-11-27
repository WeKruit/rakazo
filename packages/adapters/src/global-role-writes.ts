import type { PrismaClient } from "@rakazo/db";

/** Instantly writes that change what a role's campaign sends: they belong to that role's own conversation. */
const ROLE_CAMPAIGN_WRITES = new Set([
  "native_instantly_activate_campaign",
  "native_instantly_pause_campaign",
  "native_instantly_ensure_role_campaign",
  "native_instantly_update_role_draft",
  "native_instantly_clone_role_draft",
  "native_instantly_add_leads",
  "native_instantly_add_shortlist_leads",
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
 * What Kruit's handoff of the recruiter's turn tells a role's team. Staging 11-15: "3 and 10
 * aren't a fit, find more like the rest" reached the team as Kruit's brief "find the next 20
 * people", so it scaled out and the next round was never built. The recruiter's own words go
 * first, exactly as written; while a round waits on their answer they are the whole request (Kruit's
 * note after them only says who it is about), so the team reads the feedback itself.
 */
export async function roleRequestMessage(
  prisma: Pick<PrismaClient, "recruitingCalibrationRound">,
  input: {
    roleId?: string;
    recruiterWords: string;
    brief: string;
    /** A stage handed on inside a role's conversation: the brief only says who and what. */
    noteOnly?: boolean;
  },
): Promise<string> {
  const words = input.recruiterWords.trim();
  if (!words) return input.brief;
  const quoted = `The recruiter wrote, word for word:\n"${words}"`;
  const round =
    input.roleId && !input.noteOnly
      ? await prisma.recruitingCalibrationRound.findFirst({
          where: { roleId: input.roleId },
          orderBy: { round: "desc" },
          select: { approvedAt: true },
        })
      : null;
  // team-has-no-email 11-16: with the brief dropped, 「没存的话现在怎么办？」 reached the team
  // without the person Kruit named, and it answered about someone else.
  if (input.noteOnly || (round && !round.approvedAt))
    return input.brief.trim()
      ? `${quoted}\n\nKruit's note (not the recruiter's words):\n${input.brief}`
      : quoted;
  return input.brief.trim() ? `${quoted}\n\nKruit's brief:\n${input.brief}` : quoted;
}

/**
 * The recruiter's newest words in a conversation, as they wrote them: their latest message, the
 * words a request from Kruit's conversation carried, or their latest answer to a card there,
 * whichever came last. Read from the records (who wrote it,
 * when), never from what the words say. Play s165 11-27: a turn-down came as the answer to a
 * card in the run that opened the role, so the lead's hand-off quoted the opening "找10人" as
 * the request and the team searched for ten more.
 */
export async function newestRecruiterWords(
  prisma: Pick<PrismaClient, "message">,
  threadId: string,
): Promise<string> {
  const recent = await prisma.message.findMany({
    where: { threadId },
    orderBy: { seq: "desc" },
    take: 30,
    select: { role: true, blocks: true, createdAt: true, updatedAt: true },
  });
  let newest: { at: number; text: string } | undefined;
  const consider = (at: Date, text: string | undefined) => {
    const words = text?.trim();
    if (words && (!newest || at.getTime() > newest.at)) newest = { at: at.getTime(), text: words };
  };
  for (const message of recent) {
    const blocks = Array.isArray(message.blocks)
      ? (message.blocks as Array<Record<string, unknown>>)
      : [];
    if (message.role === "user")
      consider(
        message.createdAt,
        blocks
          .map((block) =>
            block?.kind === "text" && typeof block.text === "string"
              ? block.text
              : // A request handed over from Kruit's conversation carries the recruiter's words.
                block?.kind === "bot_message_received" && typeof block.recruiterWords === "string"
                ? block.recruiterWords
                : "",
          )
          .filter(Boolean)
          .join("\n"),
      );
    else
      for (const block of blocks)
        if (
          block?.kind === "ask" &&
          block.status === "answered" &&
          typeof block.answer === "string"
        )
          consider(message.updatedAt, block.answer);
  }
  return newest?.text ?? "";
}
