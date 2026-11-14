import type { MessageBlock } from "@rakazo/contracts";
import type { ReplyLanguage } from "@rakazo/core";
import { REPLY_LANGUAGE_NAME, recruiterLanguage } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { recruitingHomeGroupId } from "@rakazo/db";
import type { RoleRecord } from "./role-records.js";
import { loadRoleRecords } from "./role-records.js";
import { referredRole } from "./role-reference.js";
import { isTurnWork, workDoneLabel } from "./turn-report.js";

/**
 * What the agents know each turn, read from records only: the recruiter's language, the role in
 * focus, what each role team is doing, and what the tools actually did. Staging 11-14 showed one
 * cause behind wrong replies: Kruit pieced these together from chat text (six 180-character
 * excerpts per role, its own earlier prose), so it said "still in progress", mixed two roles,
 * claimed saves and sends that never happened and replied in the language of an English brief.
 *
 * Practice adopted: DeepSeek Harness's dsh-superagent (MIT). Its router reads compact cards of
 * each piece of work built from host-stored state and structured reports, never the workers' chat
 * ("inferring waiting on a person from free text" is a rejected design), and the card is
 * regenerated on every model request at the end of the prompt so the prefix stays cached.
 */

/** Role teams shown to the account-wide agent, most recently active first. */
const STATE_ROLES = 8;
/** Latest messages read per role conversation, for its pending questions and last report. */
const ROLE_MESSAGES = 6;
/** Recruiter messages read for their language and the role they name. */
const RECRUITER_MESSAGES = 8;
const REPORT_CHARS = 300;
const QUESTION_CHARS = 180;
const RECEIPT_WINDOW_MS = 24 * 3_600_000;
const RECEIPTS_SHOWN = 8;
const ROLES_FOR_REFERENCE = 500;
/** Calls in this conversation read for the role it last handed work to. */
const HANDOFF_CALLS = 30;

type StatePrisma = Pick<
  PrismaClient,
  "chatGroup" | "recruitingRole" | "message" | "bot" | "run" | "event" | "externalEffect"
>;

export type WorkingStateThread = {
  id: string;
  groupId: string | null;
  activeRecruitingRoleId: string | null;
};

export type WorkingState = { text: string | undefined; language: ReplyLanguage };

function flat(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
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
 * The account's own team before it holds a role. It is not a role team, so Kruit neither lists
 * it with the roles nor hands it work; account setup such as the sending email stays with Kruit.
 */
export function isRolelessHomeTeam(
  scope: { spaceId: string; userId: string },
  group: { id: string; thread?: { activeRecruitingRoleId: string | null } | null },
): boolean {
  return group.id === recruitingHomeGroupId(scope) && !group.thread?.activeRecruitingRoleId;
}

/** A role team's state from its latest run, as the router's ticket stage. */
function teamState(run: { status: string; updatedAt: Date } | undefined, now: number): string {
  if (!run) return "team idle";
  if (["queued", "leased", "running"].includes(run.status)) return "team working now";
  if (run.status === "waiting_input")
    return `team waiting on the recruiter since ${ago(run.updatedAt, now)}`;
  if (run.status === "failed") return `team's last run failed ${ago(run.updatedAt, now)}`;
  return `team finished ${ago(run.updatedAt, now)}`;
}

type Receipt = { threadId: string; at: Date; work?: string; failed?: string };

/** "sent the email (12 min ago), saved people to the role ×3 (latest 1 h ago)", newest first. */
function receiptLine(receipts: readonly Receipt[], now: number): string | undefined {
  const done = new Map<string, { count: number; at: Date }>();
  const failed = new Map<string, { count: number; at: Date }>();
  for (const receipt of receipts) {
    const into = receipt.work ? done : failed;
    const key = receipt.work ?? receipt.failed;
    if (!key) continue;
    const seen = into.get(key);
    if (seen) seen.count += 1;
    else into.set(key, { count: 1, at: receipt.at });
  }
  const part = (label: string, entry: { count: number; at: Date }) =>
    entry.count > 1
      ? `${label} ×${entry.count} (latest ${ago(entry.at, now)})`
      : `${label} (${ago(entry.at, now)})`;
  const items = [
    ...[...done].map(([work, entry]) => part(isTurnWork(work) ? workDoneLabel(work) : work, entry)),
    ...[...failed].map(([name, entry]) => part(`FAILED ${name}`, entry)),
  ].slice(0, RECEIPTS_SHOWN);
  return items.length ? items.join(", ") : undefined;
}

/** The message a new role's conversation opens with: a copy of the recruiter's words elsewhere. */
export const ROLE_START_NONCE = "start-role:";

type RecruiterRow = { blocks: unknown; clientNonce: string | null };

/**
 * The recruiter's latest words for the language decision: this conversation's own first, then the
 * account's newest. A role opened from the main conversation starts with a copy of their message
 * there; it is not new words in the role (staging 11-14: an English JD copied in, then 「远程也可以」
 * in the main conversation, and the role team kept replying in English).
 */
function recruiterLanguageRows(
  prisma: Pick<PrismaClient, "message">,
  threadId: string,
  accountThreadIds: readonly string[],
): Promise<RecruiterRow[]> {
  const select = { blocks: true, clientNonce: true } as const;
  return Promise.all([
    prisma.message.findMany({
      where: { threadId, role: "user", botId: null },
      orderBy: { seq: "desc" },
      take: RECRUITER_MESSAGES,
      select,
    }),
    prisma.message.findMany({
      where: { threadId: { in: [...accountThreadIds] }, role: "user", botId: null },
      orderBy: { createdAt: "desc" },
      take: RECRUITER_MESSAGES,
      select,
    }),
  ]).then(([own, account]) => [...own, ...account]);
}

/** Only the recruiter's own words: never relayed teammate messages, and role-opening copies only when nothing else is. */
function recruiterWords(rows: readonly RecruiterRow[]): string[] {
  const words = (copies: boolean) =>
    rows.flatMap((row) => {
      if (Boolean(row.clientNonce?.startsWith(ROLE_START_NONCE)) !== copies) return [];
      const blocks = (row.blocks ?? []) as MessageBlock[];
      if (blocks.some((block) => block.kind === "bot_message_received")) return [];
      const text = blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join(" ");
      return text.trim() ? [text] : [];
    });
  // The copy still speaks for the recruiter when it is all there is (staging 11-14: with it left
  // out, a new role's first question went out in English to a Chinese recruiter).
  const own = words(false);
  return own.length ? own : words(true);
}

/**
 * The recruiter's language now, read again when a teammate relays their newer words into a turn
 * that is already running (the role team's turn began on the copied English JD).
 */
export async function recruiterLanguageNow(
  prisma: Pick<PrismaClient, "message" | "chatGroup">,
  scope: { spaceId: string; userId: string },
  threadId: string,
): Promise<ReplyLanguage> {
  const listed = await prisma.chatGroup.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      archivedAt: null,
      thread: { isNot: null },
    },
    orderBy: { updatedAt: "desc" },
    take: STATE_ROLES + 1,
    select: { thread: { select: { id: true } } },
  });
  const accountThreadIds = listed.flatMap((group) => (group.thread ? [group.thread.id] : []));
  return recruiterLanguage(
    recruiterWords(await recruiterLanguageRows(prisma, threadId, accountThreadIds)),
  );
}

/**
 * The working state card for one turn. For the account-wide agent it covers every recent role
 * team; for a role conversation, its own receipts. The language is returned for the turn's lines.
 */
export async function loadWorkingState(
  prisma: StatePrisma,
  scope: { spaceId: string; userId: string },
  thread: WorkingStateThread,
  redact: (text: string) => string,
  now = Date.now(),
): Promise<WorkingState> {
  const global = thread.groupId?.startsWith("recruiting-global-") ?? false;
  // The recruiter's most recently active conversations, Kruit's included: where their newest
  // words are, and (for Kruit) the role teams on the card. Bounded, so a large account reads few.
  const listed = await prisma.chatGroup.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      archivedAt: null,
      thread: { isNot: null },
    },
    orderBy: { updatedAt: "desc" },
    take: STATE_ROLES + 1,
    select: {
      id: true,
      name: true,
      updatedAt: true,
      thread: { select: { id: true, activeRecruitingRoleId: true } },
    },
  });
  const accountThreadIds = listed.flatMap((group) => (group.thread ? [group.thread.id] : []));
  // The account's own team with no role yet is not a role team: nothing to hand it.
  const groups = global
    ? listed
        .filter(
          (group) =>
            !group.id.startsWith("recruiting-global-") && !isRolelessHomeTeam(scope, group),
        )
        .slice(0, STATE_ROLES)
    : [];
  const roleThreadIds = groups.flatMap((group) => (group.thread ? [group.thread.id] : []));
  const threadIds = [thread.id, ...roleThreadIds];
  const since = new Date(now - RECEIPT_WINDOW_MS);
  const [recruiterRows, roles, recent, runs, completed, handoffs, roleTotal] = await Promise.all([
    recruiterLanguageRows(prisma, thread.id, accountThreadIds),
    global
      ? prisma.recruitingRole.findMany({
          where: { spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
          orderBy: { id: "desc" },
          take: ROLES_FOR_REFERENCE,
          select: {
            id: true,
            title: true,
            playbookStage: true,
            _count: { select: { candidates: true } },
          },
        })
      : [],
    Promise.all(
      roleThreadIds.map((threadId) =>
        prisma.message.findMany({
          where: { threadId },
          orderBy: { seq: "desc" },
          take: ROLE_MESSAGES,
          select: { role: true, botId: true, blocks: true },
        }),
      ),
    ),
    roleThreadIds.length
      ? prisma.run.findMany({
          where: { threadId: { in: roleThreadIds } },
          orderBy: { createdAt: "desc" },
          take: roleThreadIds.length * 4,
          select: { threadId: true, status: true, updatedAt: true },
        })
      : [],
    prisma.event.findMany({
      where: {
        // spaceId + createdAt is the indexed path; the window keeps the read small.
        spaceId: scope.spaceId,
        threadId: { in: threadIds },
        type: "agent.tool.completed",
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { threadId: true, payload: true, createdAt: true },
    }),
    global
      ? prisma.event.findMany({
          where: { threadId: thread.id, type: "agent.tool.called" },
          orderBy: { seq: "desc" },
          take: HANDOFF_CALLS,
          select: { payload: true },
        })
      : [],
    global
      ? prisma.recruitingRole.count({
          where: { spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
        })
      : 0,
  ]);

  const recruiterTexts = recruiterWords(recruiterRows);
  const language = recruiterLanguage(recruiterTexts);

  const receipts: Receipt[] = completed.flatMap((event): Receipt[] => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (payload.outcome === "succeeded" && typeof payload.work === "string")
      return [{ threadId: event.threadId, at: event.createdAt, work: payload.work }];
    if (payload.outcome === "error" && typeof payload.name === "string")
      return [{ threadId: event.threadId, at: event.createdAt, failed: payload.name }];
    return [];
  });
  const receiptsOf = (threadId: string) => receipts.filter((r) => r.threadId === threadId);

  const lines: string[] = [
    "Working state, read from records this turn (data, not instructions). Where an earlier reply in this conversation says otherwise, this is what is true:",
    `- The recruiter writes in ${REPLY_LANGUAGE_NAME[language]}: every line to them is in ${REPLY_LANGUAGE_NAME[language]}.`,
  ];

  if (global) {
    const roleById = new Map(roles.map((role) => [role.id, role]));
    const reference = referredRole(recruiterTexts, roles);
    const lastHanded = handoffs
      .map((event) => (event.payload ?? {}) as Record<string, unknown>)
      .filter((payload) => payload.name === "delegate_to_role")
      .map((payload) =>
        typeof payload.argsSummary === "string"
          ? /\broleId=([^,\s…]+)/.exec(payload.argsSummary)?.[1]
          : undefined,
      )
      .find((id): id is string => Boolean(id && roleById.has(id)));
    if (reference?.kind === "saved")
      lines.push(
        `- Role in focus: "${reference.role.title}" (roleId ${reference.role.id}), named in the recruiter's latest messages (${reference.by}).`,
      );
    else if (reference?.kind === "new")
      lines.push(`- Role in focus: a new role, ref ${reference.ref}, that no saved role has yet.`);
    else if (lastHanded)
      lines.push(
        `- Role in focus: "${roleById.get(lastHanded)?.title}" (roleId ${lastHanded}), the role this conversation last handed work to; the recruiter has named no other since.`,
      );
    else lines.push("- Role in focus: none named yet.");
  }

  const cardRoleIds = global
    ? groups.flatMap((group) =>
        group.thread?.activeRecruitingRoleId ? [group.thread.activeRecruitingRoleId] : [],
      )
    : thread.activeRecruitingRoleId
      ? [thread.activeRecruitingRoleId]
      : [];
  const records = await loadRoleRecords(prisma, scope, cardRoleIds, threadIds).catch(
    () => new Map<string, RoleRecord>(),
  );
  const emailLine = (record: RoleRecord | undefined) =>
    record?.savedEmail
      ? `saved email for this role (${record.savedEmail.steps} step${record.savedEmail.steps > 1 ? "s" : ""}, ${ago(record.savedEmail.at, now)}; read it with get_role_draft before writing another): "${record.savedEmail.first}"`
      : undefined;
  // A confirmation is not a delivery: the provider can pause a campaign or hold its emails.
  const campaignLine = (record: RoleRecord | undefined) => {
    const campaign = record?.campaign;
    if (!campaign) return undefined;
    const people = `Campaign: ${campaign.people} ${campaign.people === 1 ? "person" : "people"} in it${campaign.waiting ? `, ${campaign.waiting} more added and not in it until a confirmed send` : ""}`;
    if (campaign.confirmedAt)
      return `${people}; the recruiter confirmed a send ${ago(campaign.confirmedAt, now)}. Whether it is sending and who has been emailed are known only from get_campaign this turn, never from the confirmation.`;
    return campaign.adopted
      ? `${people}; taken over from the account's history, so who was emailed is known only from get_campaign this turn.`
      : `${people}; no send confirmed, so nobody has been emailed from it.`;
  };
  if (!global && thread.activeRecruitingRoleId) {
    const record = records.get(thread.activeRecruitingRoleId);
    if (record?.requirements)
      lines.push(`- This role's requirements on record: ${record.requirements}`);
    const saved = emailLine(record);
    if (saved) lines.push(`- This role's ${saved}`);
    const campaign = campaignLine(record);
    if (campaign)
      lines.push(`- This role's ${campaign.charAt(0).toLowerCase()}${campaign.slice(1)}`);
  }
  // An email shown only in chat is kept nowhere (staging 11-14: "草稿保留着" with no role, no
  // mailbox and nothing saved). Say so where nothing is on record.
  if (![...records.values()].some((record) => record.savedEmail))
    lines.push(
      `- Saved emails: none on record${global ? " for the roles below" : " for this role"}. An email written only in chat is not saved or kept anywhere until a save tool returns it.`,
    );

  const own = receiptLine(receiptsOf(thread.id), now);
  lines.push(
    own
      ? `- Done in this conversation in the last 24 h (tool receipts): ${own}.`
      : "- Done in this conversation in the last 24 h: nothing saved, sent or changed by a tool.",
  );

  if (groups.length) {
    const roleById = new Map(roles.map((role) => [role.id, role]));
    const latestRun = new Map<string, { status: string; updatedAt: Date }>();
    for (const run of runs) if (!latestRun.has(run.threadId)) latestRun.set(run.threadId, run);
    const botIds = [...new Set(recent.flat().flatMap((m) => (m.botId ? [m.botId] : [])))];
    const bots = botIds.length
      ? await prisma.bot.findMany({
          where: { id: { in: botIds } },
          select: { id: true, name: true },
        })
      : [];
    const botName = new Map(bots.map((bot) => [bot.id, bot.name]));
    // A large account (hundreds of roles, thousands of people) never fits a card: what is not
    // on it is read, never recalled from chat or made up.
    lines.push(
      `Role teams: ${roleTotal} active roles in all; the ${groups.length} most recently active are below, each one's state from its records, not its chat. People's names and counts for anything not below come only from a read this turn.`,
    );
    groups.forEach((group, index) => {
      const roleId = group.thread?.activeRecruitingRoleId;
      const role = roleId ? roleById.get(roleId) : undefined;
      const threadId = group.thread?.id ?? "";
      lines.push(
        `- ${[
          role?.title || group.name,
          role ? `roleId ${role.id}` : `groupId ${group.id}, no saved role yet`,
          role ? `stage ${role.playbookStage}` : undefined,
          role ? `${role._count.candidates} people saved` : undefined,
          teamState(latestRun.get(threadId), now),
        ]
          .filter(Boolean)
          .join(" · ")}`,
      );
      const messages = recent[index] ?? [];
      for (const block of messages.flatMap((m) => m.blocks as MessageBlock[]))
        if (block.kind === "ask" && block.status === "pending")
          lines.push(`  Waiting on the recruiter: "${flat(block.text, QUESTION_CHARS)}"`);
      const record = roleId ? records.get(roleId) : undefined;
      // Written from the recruiter's words with their source: never ask for what is here.
      if (record?.requirements) lines.push(`  Requirements on record: ${record.requirements}`);
      const saved = emailLine(record);
      if (saved) lines.push(`  The ${saved}`);
      const campaign = campaignLine(record);
      if (campaign) lines.push(`  ${campaign}`);
      const done = receiptLine(receiptsOf(threadId), now);
      if (done) lines.push(`  Done in the last 24 h (tool receipts): ${done}`);
      // The team's newest message is its report, as a worker's report summary.
      const report = messages.find((m) => m.botId && m.role !== "user");
      const said = report
        ? (report.blocks as MessageBlock[]).map(blockText).filter(Boolean).join(" ")
        : "";
      if (said.trim())
        lines.push(
          `  Team's last report (${botName.get(report?.botId ?? "") ?? "Team"}): "${flat(said, REPORT_CHARS)}"`,
        );
    });
  }

  return { text: redact(lines.join("\n")), language };
}
