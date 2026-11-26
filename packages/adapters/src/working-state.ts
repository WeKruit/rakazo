import type { MessageBlock } from "@rakazo/contracts";
import type { ReplyLanguage } from "@rakazo/core";
import {
  GMAIL_MCP_ENDPOINT,
  REPLY_LANGUAGE_NAME,
  recruiterLanguage,
  runWorkSteps,
  workActivityLabel,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { BRIEF_CONFIRMATION_TEXT, recruitingHomeGroupId } from "@rakazo/db";
import { ownMailboxSendingAllowed } from "./instantly-senders.js";
import { openRecruitingRoles } from "./open-recruiting-roles.js";
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
const ROLE_MESSAGES = 8;
/** Recruiter messages read for their language and the role they name. */
const RECRUITER_MESSAGES = 8;
const REPORT_CHARS = 300;
/** What this conversation asked a team, and each team message since, on the card. */
const HANDOFF_CHARS = 240;
const SINCE_CHARS = 400;
const SINCE_MESSAGES = 3;
const QUESTION_CHARS = 180;
const RECEIPT_WINDOW_MS = 24 * 3_600_000;
/** How far back the account's own sends are counted: long enough for "did you send it yesterday". */
const SEND_WINDOW_DAYS = 7;
const RECEIPTS_SHOWN = 8;
const ROLES_FOR_REFERENCE = 500;
/** Calls in this conversation read for the role it last handed work to. */
const HANDOFF_CALLS = 30;

type StatePrisma = Pick<
  PrismaClient,
  | "chatGroup"
  | "recruitingRole"
  | "message"
  | "bot"
  | "run"
  | "event"
  | "externalEffect"
  | "user"
  | "mcpServer"
  | "connection"
  | "recruitingCalibrationRound"
>;

/**
 * An account that sends from the recruiter's own Gmail, with none connected: nothing can go out,
 * so no line may read as going ahead with a send (gate ecebc59b: a going-ahead line after
 * 「直接发吧」, then the Connect card 22 s later). Gate 8856cf75 (mobile-first-look): asked where replies show
 * up, Kruit named the Inbox but not that it stays empty until Gmail is connected.
 */
async function ownGmailLine(prisma: StatePrisma, scope: { spaceId: string; userId: string }) {
  // deny-then-change-and-send 11-16: with no line on how this account sends, Kruit blamed a
  // missing Gmail and a role run with no mail tools loaded said it had no email connection.
  if (!(await ownMailboxSendingAllowed(prisma, scope)))
    return "- How this account's emails go out: from the outreach mailbox the product runs for it, not the recruiter's Gmail, so Gmail is never needed for a send nor the reason one cannot happen. A role's emails go out on their Send card; its sending tools are found with connectors_search_tools group \"instantly\".";
  const gmail = await prisma.mcpServer.findFirst({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      enabled: true,
      secretId: { not: null },
      OR: [{ slug: "gmail" }, { endpoint: GMAIL_MCP_ENDPOINT }],
    },
    select: { id: true },
  });
  return gmail
    ? undefined
    : "- Recruiter's own Gmail: not connected, so no email can go out yet. Writing one needs no mailbox: show it in the reply now; it goes out once they press Connect on the connect card and then Send on its card. Asked where to connect: the Connect button on that card in this chat, or later the menu under their name at the bottom left, then Integrations (集成); no other place exists. Their Inbox page shows only \"No emails yet\" and a Connect Gmail button until then: candidates' replies show there once Gmail is connected and an email has gone out from it.";
}

/** Calendar connectors the product books interviews through (request_connection's catalog). */
const CALENDAR_SLUGS = ["google-calendar", "cal-com"];
const CALENDAR_ENDPOINTS = ["https://calendarmcp.googleapis.com/mcp/v1", "https://mcp.cal.com/mcp"];

/**
 * No calendar connected: no interview can be booked (team-stuck 11-16: Kruit said "checking" and
 * handed the booking to the team, which found the missing calendar two minutes later).
 */
async function calendarLine(prisma: StatePrisma, scope: { spaceId: string; userId: string }) {
  const [server, linked] = await Promise.all([
    prisma.mcpServer.findFirst({
      where: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        enabled: true,
        secretId: { not: null },
        OR: [{ slug: { in: CALENDAR_SLUGS } }, { endpoint: { in: CALENDAR_ENDPOINTS } }],
      },
      select: { id: true },
    }),
    // A calendar linked through a connector platform counts too, whatever its sync state.
    prisma.connection.findFirst({
      where: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        provider: { contains: "calendar", mode: "insensitive" },
        status: { not: "revoked" },
      },
      select: { id: true },
    }),
  ]);
  return server || linked
    ? undefined
    : "- Recruiter's calendar: none connected, so you cannot see when they are free or busy (saved interviews are not their calendar), and no interview can be booked or invited yet. Asked about their time or schedule, say first that you can't see their calendar because it isn't connected; when they ask for that or a booking, show the calendar Connect card (request_connection) in that same reply rather than handing the booking to a team. Asked how or where to connect: press Connect on that card in this chat, or later the menu under their name at the bottom left, then Integrations (集成); no other place exists.";
}

/** A role's latest calibration round, as the recruiter sees it. */
function roundLine(
  round: { round: number; status: string; statusAt: Date; approvedAt: Date | null } | undefined,
  now: number,
) {
  if (!round) return undefined;
  if (round.approvedAt) return `round ${round.round} approved`;
  return `round ${round.round} shown in the role team's chat ${ago(round.statusAt, now)}`;
}

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

type RecruiterRow = { blocks: unknown; clientNonce: string | null; own?: boolean };

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
  ]).then(([own, account]) => [...own.map((row) => ({ ...row, own: true })), ...account]);
}

/** Only the recruiter's own words: never relayed teammate messages, and role-opening copies only when nothing else is. */
function recruiterWords(rows: readonly RecruiterRow[]): string[] {
  const words = (copies: boolean) =>
    rows.flatMap((row) => {
      if (Boolean(row.clientNonce?.startsWith(ROLE_START_NONCE)) !== copies) return [];
      const blocks = (row.blocks ?? []) as MessageBlock[];
      if (blocks.some((block) => block.kind === "bot_message_received")) return [];
      const text = blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join(" ");
      // The brief confirmation is posted as the recruiter's, in English (fosp 11-23, d6c65687).
      return text.trim() && !BRIEF_CONFIRMATION_TEXT.test(text.trim()) ? [text] : [];
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
  const gmailLine = ownGmailLine(prisma, scope).catch(() => undefined);
  const calendarRead = calendarLine(prisma, scope).catch(() => undefined);
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
  // Every send in the product runs only after its card is confirmed and leaves this receipt,
  // so the account's own sends are a definite count, not an unknown.
  const sendsRead = prisma.event
    .findMany({
      where: {
        spaceId: scope.spaceId,
        type: "agent.tool.completed",
        createdAt: { gte: new Date(now - SEND_WINDOW_DAYS * 86_400_000) },
        thread: { userId: scope.userId },
        payload: { path: ["work"], equals: "sent" },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { threadId: true, payload: true, createdAt: true },
    })
    .catch(() => undefined);
  const teamRoleIds = groups.flatMap((group) =>
    group.thread?.activeRecruitingRoleId ? [group.thread.activeRecruitingRoleId] : [],
  );
  const roundsRead = teamRoleIds.length
    ? prisma.recruitingCalibrationRound
        .findMany({
          where: { roleId: { in: teamRoleIds } },
          orderBy: [{ roleId: "asc" }, { round: "desc" }],
          distinct: ["roleId"],
          select: { roleId: true, round: true, status: true, statusAt: true, approvedAt: true },
        })
        .catch(() => [])
    : Promise.resolve([]);
  const [recruiterRows, roles, recent, runs, completed, handoffs, roleTotal] = await Promise.all([
    recruiterLanguageRows(prisma, thread.id, accountThreadIds),
    global
      ? prisma.recruitingRole.findMany({
          where: openRecruitingRoles(scope),
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
          select: { role: true, botId: true, blocks: true, createdAt: true, clientNonce: true },
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
    global ? prisma.recruitingRole.count({ where: openRecruitingRoles(scope) }) : 0,
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
    let focusId: string | undefined;
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
    else {
      // A short follow-up ("发了吗", "重试") names no role; the role is the one this conversation
      // named last, never one found by a person's name (staging 11-14: a retry answered for
      // another role that held the same two people).
      const earlier = recruiterWords(recruiterRows.filter((row) => row.own))
        .map((text) => referredRole([text], roles))
        .find((found) => found?.kind === "saved");
      lines.push(
        earlier?.kind === "saved"
          ? `- Role in focus: "${earlier.role.title}" (roleId ${earlier.role.id}), the role the recruiter last named in this conversation (${earlier.by}); the same person can be in several roles, so a person's name never picks the role.`
          : "- Role in focus: none named yet.",
      );
      if (earlier?.kind === "saved") focusId = earlier.role.id;
    }
    if (reference?.kind === "saved") focusId = reference.role.id;
    else if (reference?.kind !== "new" && lastHanded) focusId = lastHanded;
    // Feedback-round 11-16: Kruit spent 30 s resolving the people the recruiter turned down
    // before handing off, though the team gets only the recruiter's words while a round waits.
    const waiting = focusId
      ? await prisma.recruitingCalibrationRound
          .findFirst({
            where: { roleId: focusId },
            orderBy: { round: "desc" },
            select: { round: true, approvedAt: true },
          })
          .catch(() => null)
      : null;
    if (waiting && !waiting.approvedAt)
      lines.push(
        `  Its round ${waiting.round} waits on the recruiter's answer. A change to who is searched (turning people down, more like the rest, the next ten) reaches its team as their own words only and the team resolves the people itself: hand it with delegate_to_role as your first call, before reading or resolving anyone. A question about the people shown (any repeats, whether they fit what was asked, how many, which are checked) is a read you answer yourself in this reply from recruiting_candidates round or list with this roleId, never handed to the team.`,
      );
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
    // Send-at-night 11-16: with no id here Kruit's main chat read another role's old campaign.
    const people = `Campaign (campaign_id ${campaign.id}): ${campaign.people} ${campaign.people === 1 ? "person" : "people"} in it${campaign.waiting ? `, ${campaign.waiting} more added and not in it until a confirmed send` : ""}`;
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
  // An email shown only in chat is in no role or mailbox (staging 11-14: "草稿保留着" with no role,
  // no mailbox and nothing saved). It is still the email above, which the Gmail send card takes up:
  // gate df83586a, "kept nowhere" made Kruit retract "the draft is kept" after the Connect card.
  if (![...records.values()].some((record) => record.savedEmail))
    lines.push(
      `- Saved emails: none on record${global ? " for the roles below" : " for this role"}. An email written only in chat stays in this conversation as the email above (the one a send card takes up), but is in no role, campaign or mailbox draft until a save tool returns it.`,
    );

  // A campaign started outside any role has no role card: without its id here, a later "stop it"
  // or "who got it" had nothing to read or pause (gate 9e15e896, stop-after-approve).
  const oneOff = await prisma.externalEffect
    .findMany({
      where: {
        spaceId: scope.spaceId,
        run: { userId: scope.userId, spaceId: scope.spaceId, threadId: thread.id },
        kind: "instantly_role_campaign",
        status: "completed",
        request: { path: ["direct"], equals: true },
        createdAt: { gte: new Date(now - 7 * 86_400_000) },
      },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { idempotencyKey: true, result: true, createdAt: true },
    })
    .catch(() => []);
  for (const effect of oneOff) {
    const result = (effect.result ?? {}) as { campaignId?: unknown; campaignName?: unknown };
    if (
      !effect.idempotencyKey?.startsWith("instantly-direct-campaign:") ||
      typeof result.campaignId !== "string"
    )
      continue;
    lines.push(
      `- Campaign started in this conversation outside any role, ${ago(effect.createdAt, now)}: ${typeof result.campaignName === "string" ? `"${flat(result.campaignName, 80)}" ` : ""}(campaign_id ${result.campaignId}). Who it emailed or still holds is known only from get_campaign with that campaign_id; to stop or hold it, pause_campaign with that campaign_id.`,
    );
  }

  const gmail = await gmailLine;
  if (gmail) lines.push(gmail);
  const calendar = await calendarRead;
  if (calendar) lines.push(calendar);

  const sendRows = await sendsRead;
  const sent = (sendRows ?? []).filter((event) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    return payload.outcome === "succeeded" && payload.work === "sent";
  });
  if (sendRows)
    lines.push(
      sent.length
        ? `- Emails sent from this account through the product in the last ${SEND_WINDOW_DAYS} days: ${sent.length >= 50 ? "50 or more sends" : `${sent.length} send${sent.length === 1 ? "" : "s"}`} (latest ${ago(sent[0]!.createdAt, now)}), each confirmed on its card. A campaign send queues its emails: who has received one is known from get_campaign.`
        : `- Emails sent from this account through the product in the last ${SEND_WINDOW_DAYS} days: none. Every send needs its card and leaves a record, so this is a definite none: nothing was sent from here and nothing is waiting to go out, whatever earlier chat or the recruiter remembers. A mailbox or CRM that is not connected, or a mailbox read that fails, does not make it unknown; only a campaign imported from another tool sends outside this record, and get_campaign reads it.`,
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
    const roundOf = new Map((await roundsRead).map((round) => [round.roleId, round]));
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
          roundLine(roleId ? roundOf.get(roleId) : undefined, now),
          teamState(latestRun.get(threadId), now),
        ]
          .filter(Boolean)
          .join(" · ")}`,
      );
      const messages = recent[index] ?? [];
      // A card the recruiter wrote past (newest first) is not what the team waits on: feedback-
      // round 11-16, an open next-step card read as "waiting on your choice" after their feedback.
      const answered = messages.findIndex((m) => m.role === "user");
      const open = answered === -1 ? messages : messages.slice(0, answered);
      for (const block of open.flatMap((m) => m.blocks as MessageBlock[]))
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
      // Work this conversation handed the team, as a parent sees its job: what it asked, the step
      // the team is on now and everything the team posted since (gap analysis 11-16; gate 44c1ad44
      // team-has-no-email: Kruit answered from its own read with another person than the team's,
      // then said it had asked the team again). A role is opened from this conversation with the
      // recruiter's message (start_role), and later work reaches it as this conversation's brief
      // (delegate_to_role); the recruiter's answers to the team's cards keep the same job going.
      const briefOf = (m: (typeof messages)[number]) =>
        m.role !== "user"
          ? undefined
          : m.clientNonce?.startsWith(ROLE_START_NONCE)
            ? (m.blocks as MessageBlock[]).map(blockText).filter(Boolean).join(" ")
            : (m.blocks as MessageBlock[]).flatMap((block) =>
                block.kind === "bot_message_received" && block.returnThreadId === thread.id
                  ? [block.text]
                  : [],
              )[0];
      const handIndex = messages.findIndex((m) => briefOf(m)?.trim());
      const handed = handIndex === -1 ? undefined : messages[handIndex]!;
      const brief = handed ? briefOf(handed) : undefined;
      if (handed && brief?.trim()) {
        lines.push(
          `  You handed this team work ${ago(handed.createdAt, now)}: "${flat(brief, HANDOFF_CHARS)}"`,
        );
        const since = messages.slice(0, handIndex).filter((m) => m.botId && m.role !== "user");
        const live = latestRun.get(threadId);
        if (live && ["queued", "leased", "running"].includes(live.status)) {
          const steps = runWorkSteps({ blocks: (since[0]?.blocks ?? []) as MessageBlock[] });
          const last = steps.done.at(-1);
          const activity = steps.current ?? (typeof last === "string" ? last : last?.activity);
          lines.push(
            `  Doing now: ${activity ? workActivityLabel(activity).toLowerCase() : "starting"}${steps.done.length ? ` (${steps.done.length} step${steps.done.length === 1 ? "" : "s"} done this run)` : ""}.`,
          );
        }
        // Once the round is shown, the round line above is current: a team message from before
        // that is stale (staging 2a781497 feedback-round: main relayed it while the round's ten
        // were on the page).
        const settledAt = (roleId ? roundOf.get(roleId) : undefined)?.statusAt;
        const current = settledAt ? since.filter((m) => m.createdAt > settledAt) : since;
        const posted = current
          .slice(0, SINCE_MESSAGES)
          .reverse()
          .flatMap((m) => {
            const said = (m.blocks as MessageBlock[]).map(blockText).filter(Boolean).join(" ");
            return said.trim()
              ? [
                  `  Team posted since (${botName.get(m.botId ?? "") ?? "Team"}, ${ago(m.createdAt, now)}): "${flat(said, SINCE_CHARS)}"`,
                ]
              : [];
          });
        lines.push(
          ...(posted.length
            ? posted
            : [
                current.length < since.length
                  ? "  Team posted since the round line above: nothing."
                  : "  Team posted since: nothing yet.",
              ]),
          "  Asked how this work is going, answer from these lines in this reply: never say you asked or will ask the team, and never name a person or count the team has not posted or the records above do not show.",
        );
        return;
      }
      // The team's newest message is its report, as a worker's report summary.
      // A run still working posts steps first: its report is the newest message with words.
      const report = messages.find(
        (m) =>
          m.botId &&
          m.role !== "user" &&
          (m.blocks as MessageBlock[]).some((block) => blockText(block)?.trim()),
      );
      const said = report
        ? (report.blocks as MessageBlock[]).map(blockText).filter(Boolean).join(" ")
        : "";
      if (said.trim())
        lines.push(
          `  Team's last report (${botName.get(report?.botId ?? "") ?? "Team"}${report?.createdAt ? `, ${ago(report.createdAt, now)}` : ""}; its counts may be older than the ones above, which are read now): "${flat(said, REPORT_CHARS)}"`,
        );
    });
  } else if (global && roleTotal === 0) {
    // Every role opened here is saved to this account, so no roles is a definite none, not an
    // unknown (honest-limits 8a002815: with nothing said, 「不对啊，我昨天建了三个」 got an apology).
    const archived = await prisma.recruitingRole
      .count({
        // None is open, so every role left is archived itself or in an archived chat.
        where: { spaceId: scope.spaceId, userId: scope.userId },
      })
      .catch(() => 0);
    lines.push(
      `- Role teams: ${archived ? `none active; ${archived} archived` : "none"}. Every role opened in this product is saved to this account, so this is read now and definite, whatever earlier chat or the recruiter remembers.`,
    );
  }

  return { text: redact(lines.join("\n")), language };
}
