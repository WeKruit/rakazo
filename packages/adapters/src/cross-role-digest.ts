import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/** Roles shown to the global agent, most recently active first. */
const DIGEST_ROLES = 8;
/** Latest messages read per role conversation. */
const DIGEST_MESSAGES = 6;
const EXCERPT_CHARS = 180;

type DigestPrisma = Pick<PrismaClient, "chatGroup" | "recruitingRole" | "message" | "bot">;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

function blockText(block: MessageBlock): string | undefined {
  if (block.kind === "text" || block.kind === "bot_message_received") return block.text;
  if (block.kind === "ask") return block.text;
  if (block.kind === "choice" || block.kind === "poll") return block.question;
  return undefined;
}

function ago(date: Date, now: number): string {
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/**
 * A bounded, read-only picture of what each role team did and discussed lately, for the
 * account-wide agent. Built from this user's own role conversations only; details stay in
 * the role's records and conversation.
 */
export async function loadCrossRoleDigest(
  prisma: DigestPrisma,
  scope: { spaceId: string; userId: string },
  redact: (text: string) => string,
  now = Date.now(),
): Promise<string | undefined> {
  const groups = await prisma.chatGroup.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      archivedAt: null,
      NOT: { id: { startsWith: "recruiting-global-" } },
      thread: { isNot: null },
    },
    orderBy: { updatedAt: "desc" },
    take: DIGEST_ROLES,
    select: {
      id: true,
      name: true,
      updatedAt: true,
      thread: { select: { id: true, activeRecruitingRoleId: true } },
    },
  });
  if (!groups.length) return undefined;
  const roleIds = groups.flatMap((group) =>
    group.thread?.activeRecruitingRoleId ? [group.thread.activeRecruitingRoleId] : [],
  );
  const [roles, recent] = await Promise.all([
    roleIds.length
      ? prisma.recruitingRole.findMany({
          where: { id: { in: roleIds }, spaceId: scope.spaceId, userId: scope.userId },
          select: {
            id: true,
            title: true,
            playbookStage: true,
            _count: { select: { candidates: true } },
          },
        })
      : [],
    Promise.all(
      groups.map((group) =>
        group.thread
          ? prisma.message.findMany({
              where: { threadId: group.thread.id },
              orderBy: { seq: "desc" },
              take: DIGEST_MESSAGES,
              select: { role: true, botId: true, blocks: true },
            })
          : [],
      ),
    ),
  ]);
  const botIds = [...new Set(recent.flat().flatMap((m) => (m.botId ? [m.botId] : [])))];
  const bots = botIds.length
    ? await prisma.bot.findMany({ where: { id: { in: botIds } }, select: { id: true, name: true } })
    : [];
  const botName = new Map(bots.map((bot) => [bot.id, bot.name]));
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const lines = groups.map((group, index) => {
    const role = group.thread?.activeRecruitingRoleId
      ? roleById.get(group.thread.activeRecruitingRoleId)
      : undefined;
    const head = [
      role?.title || group.name,
      role ? `roleId ${role.id}` : "no role record yet",
      role ? `stage ${role.playbookStage}` : undefined,
      role ? `${role._count.candidates} people saved` : undefined,
      `last activity ${ago(group.updatedAt, now)}`,
    ]
      .filter(Boolean)
      .join(" · ");
    const messages = [...(recent[index] ?? [])].reverse();
    const waiting = messages
      .flatMap((m) => m.blocks as MessageBlock[])
      .filter((block) => block.kind === "ask" && block.status === "pending")
      .map((block) => (block.kind === "ask" ? excerpt(block.text) : ""))
      .filter(Boolean);
    const said = messages.flatMap((m) => {
      const text = (m.blocks as MessageBlock[]).map(blockText).filter(Boolean).join(" ");
      if (!text.trim()) return [];
      const who =
        m.role === "user" && !m.botId ? "Recruiter" : (botName.get(m.botId ?? "") ?? "Team");
      return [`${who}: "${excerpt(text)}"`];
    });
    return [
      `- ${head}`,
      ...waiting.map((question) => `  Waiting on the recruiter: "${question}"`),
      ...(said.length ? [`  Recent: ${said.join(" / ")}`] : []),
    ].join("\n");
  });
  return redact(
    [
      "Across the recruiter's role teams (latest first; a summary of each role's own conversation, not its full records):",
      ...lines,
    ].join("\n"),
  );
}
