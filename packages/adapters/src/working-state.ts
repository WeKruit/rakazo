import type { MessageBlock } from "@rakazo/contracts";
import type { ReplyLanguage } from "@rakazo/core";
import { GMAIL_MCP_ENDPOINT, screenLanguage } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { recruitingHomeGroupId } from "@rakazo/db";
import { ownMailboxSendingAllowed } from "./instantly-senders.js";
import { openRecruitingRoles } from "./open-recruiting-roles.js";
import { shownCount } from "./recruiting-round-check.js";
import type { RoleRecord } from "./role-records.js";
import { loadRoleRecords } from "./role-records.js";
import { isTurnWork, SEND_WORK, workDoneLabel } from "./turn-report.js";

/**
 * What the agents know each turn, read from records only: the role in focus, what each role team is doing, and what the tools actually did. Staging 11-14 showed one
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
/** Latest messages read per role conversation, for its pending questions. */
const ROLE_MESSAGES = 8;
const QUESTION_CHARS = 180;
const RECEIPT_WINDOW_MS = 24 * 3_600_000;
/** How far back the account's own sends are counted: long enough for "did you send it yesterday". */
const SEND_WINDOW_DAYS = 7;
const RECEIPTS_SHOWN = 8;
const ROLES_FOR_REFERENCE = 500;
/** Calls in this conversation read for the role it last handed work to. */
/** Kruit's own newest messages read for the role card it last showed. */
const ROLE_CARD_MESSAGES = 30;

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
  | "recruitingCandidateOccurrence"
  | "recruitingCandidate"
  | "$queryRaw"
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
    return "- How this account's emails go out: from the outreach mailbox the product runs for it, not the recruiter's Gmail; a role's emails go out on their Send card (sending tools: connectors_search_tools group \"instantly\").";
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
    : "- Recruiter's own Gmail: not connected, so no email can go out yet; one goes out after they press Connect on a connect card and then Send on its card. Connecting is on that card, or under their name at the bottom left, then Integrations (集成). Their Inbox page stays empty until Gmail is connected and an email has gone out from it.";
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
    : "- Recruiter's calendar: none connected, so their free or busy times are not visible (saved interviews are not their calendar), and no interview can be booked or invited yet. Connecting is on a calendar connect card (request_connection), or under their name at the bottom left, then Integrations (集成).";
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

export type WorkingState = { text: string | undefined };

function flat(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
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

/**
 * The role this conversation last pointed the recruiter to: the card that opens it, which
 * start_role, delegate_to_role and a role read's show each post. Stage 3a3ee156
 * (stressed-point-few-meet): with no record of the role just opened, Kruit handed "3 more" to an
 * older role of the same title. A message that shows several roles' cards names no one role.
 */
async function lastRoleCard(
  prisma: StatePrisma,
  scope: { spaceId: string; userId: string },
  messages: { blocks: unknown }[],
): Promise<{ groupId: string; name: string; roleId?: string } | undefined> {
  for (const message of messages) {
    const blocks = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
    const cards = blocks.filter((block) => block.kind === "role_link");
    if (!cards.length) continue;
    const [card] = cards;
    if (cards.length > 1 || !card || card.kind !== "role_link") return undefined;
    const group = await prisma.chatGroup
      .findFirst({
        where: { id: card.groupId, spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
        select: { name: true, thread: { select: { activeRecruitingRoleId: true } } },
      })
      .catch(() => null);
    if (!group) return undefined;
    const roleId = group.thread?.activeRecruitingRoleId ?? undefined;
    return { groupId: card.groupId, name: group.name, ...(roleId ? { roleId } : {}) };
  }
  return undefined;
}

/**
 * The working state card for one turn. For the account-wide agent it covers every recent role
 * team; for a role conversation, its own receipts.
 */
export async function loadWorkingState(
  prisma: StatePrisma,
  scope: { spaceId: string; userId: string },
  thread: WorkingStateThread,
  redact: (text: string) => string,
  now = Date.now(),
): Promise<WorkingState> {
  const global = thread.groupId?.startsWith("recruiting-global-") ?? false;
  // How mail goes out and whether a calendar is connected are for the conversation that sends and
  // books: a role's. Kruit's own conversation hands that work over, and the role asks for what it
  // needs (replay handoff4 11-27: told here to write the email now and show a Connect card it is
  // not offered, Kruit drafted in the main chat and said the calendar was not connected).
  const gmailLine = global
    ? Promise.resolve(undefined)
    : ownGmailLine(prisma, scope).catch(() => undefined);
  const calendarRead = global
    ? Promise.resolve(undefined)
    : calendarLine(prisma, scope).catch(() => undefined);
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
        OR: SEND_WORK.map((work) => ({ payload: { path: ["work"], equals: work } })),
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
          select: {
            roleId: true,
            round: true,
            status: true,
            statusAt: true,
            approvedAt: true,
            candidateKeys: true,
          },
        })
        .catch(() => [])
    : Promise.resolve([]);
  // P5: the one count, the same as the round tool's: people shown less those turned down.
  const countsRead = Promise.all(
    teamRoleIds.map((roleId) =>
      shownCount(prisma, { roleId, ...scope })
        .then((count) => [roleId, count.counted] as const)
        .catch(() => [roleId, undefined] as const),
    ),
  );
  const [roles, recent, runs, completed, ownBotMessages, roleTotal] = await Promise.all([
    global
      ? prisma.recruitingRole.findMany({
          where: openRecruitingRoles(scope),
          orderBy: { id: "desc" },
          take: ROLES_FOR_REFERENCE,
          select: {
            id: true,
            title: true,
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
      ? prisma.message.findMany({
          where: { threadId: thread.id, role: "bot" },
          orderBy: { seq: "desc" },
          take: ROLE_CARD_MESSAGES,
          select: { blocks: true },
        })
      : [],
    global ? prisma.recruitingRole.count({ where: openRecruitingRoles(scope) }) : 0,
  ]);

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
  ];

  if (global) {
    let focusId: string | undefined;
    const focus = await lastRoleCard(prisma, scope, ownBotMessages);
    if (focus) {
      lines.push(
        `- This conversation last opened, or handed work to, "${focus.name}" (${focus.roleId ? `roleId ${focus.roleId}` : `groupId ${focus.groupId}, no saved role yet`}).`,
      );
      focusId = focus.roleId;
    }
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
        `  Its round ${waiting.round} waits on the recruiter's answer.`,
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
      return `${people}; the recruiter confirmed a send ${ago(campaign.confirmedAt, now)}. Whether it is sending and who has been emailed are known from get_campaign, not from the confirmation.`;
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
      `- Campaign started in this conversation outside any role, ${ago(effect.createdAt, now)}: ${typeof result.campaignName === "string" ? `"${flat(result.campaignName, 80)}" ` : ""}(campaign_id ${result.campaignId}). Who it emailed or still holds is known only from get_campaign with that campaign_id; pause_campaign with that campaign_id stops or holds it.`,
    );
  }

  const gmail = await gmailLine;
  if (gmail) lines.push(gmail);
  const calendar = await calendarRead;
  if (calendar) lines.push(calendar);

  const sendRows = await sendsRead;
  const sent = (sendRows ?? []).filter((event) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    return (
      payload.outcome === "succeeded" && SEND_WORK.some((work) => work === payload.work)
    );
  });
  if (sendRows)
    lines.push(
      sent.length
        ? `- Emails sent from this account through the product in the last ${SEND_WINDOW_DAYS} days: ${sent.length >= 50 ? "50 or more sends" : `${sent.length} send${sent.length === 1 ? "" : "s"}`} (latest ${ago(sent[0]!.createdAt, now)}), each confirmed on its card. A campaign send queues its emails: who has received one is known from get_campaign.`
        : `- Emails sent from this account through the product in the last ${SEND_WINDOW_DAYS} days: none. Every send needs its card and leaves a record, so this is a definite none: nothing was sent from here and nothing is waiting to go out. Only a campaign imported from another tool sends outside this record (get_campaign reads it).`,
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
    const roundOf = new Map((await roundsRead).map((round) => [round.roleId, round]));
    const countOf = new Map(await countsRead);
    // Who the latest round showed, per role, from the round's own records: when the recruiter
    // names people without naming the role, the role is on this card. Staging 11-26: Kruit read
    // saved people seven times to find the role of three named people before its first line.
    const shown = [...roundOf.values()].filter((round) => round.candidateKeys.length);
    const shownRows = shown.length
      ? await prisma.recruitingCandidateOccurrence
          .findMany({
            where: {
              OR: shown.map((round) => ({
                roleId: round.roleId,
                candidateKey: { in: round.candidateKeys },
              })),
              name: { not: null },
            },
            distinct: ["roleId", "candidateKey"],
            select: { roleId: true, name: true },
          })
          .catch(() => [])
      : [];
    const shownNames = new Map<string, string[]>();
    for (const row of shownRows)
      if (row.name) shownNames.set(row.roleId, [...(shownNames.get(row.roleId) ?? []), row.name]);
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
          // The conversation's name, as the recruiter sees it: two roles' saved titles can be the same.
          group.name || role?.title,
          role ? `roleId ${role.id}` : `groupId ${group.id}, no saved role yet`,
          role && countOf.get(role.id) !== undefined
            ? `${countOf.get(role.id)} people shown to the recruiter (less any they turned down)`
            : undefined,
          roundLine(roleId ? roundOf.get(roleId) : undefined, now),
          teamState(latestRun.get(threadId), now),
        ]
          .filter(Boolean)
          .join(" · ")}`,
      );
      const people = roleId ? shownNames.get(roleId) : undefined;
      if (people?.length) lines.push(`  People in its latest round: ${people.join(", ")}`);
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
      // The team's steps stay in its own conversation; its result comes back here as a message
      // when it is done, as a Claude Code subagent's final message returns to its parent.
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

  return { text: redact(lines.join("\n")) };
}

/**
 * The language the recruiter's screen shows, from the UI locale the client sends with each of
 * their messages: the newest one in any of their conversations. A role conversation opened by a
 * hand-off holds none of their own messages.
 */
export async function recruiterScreenLanguage(
  prisma: Pick<PrismaClient, "message" | "chatGroup">,
  scope: { spaceId: string; userId: string },
): Promise<ReplyLanguage | undefined> {
  const listed = await prisma.chatGroup.findMany({
    where: { spaceId: scope.spaceId, userId: scope.userId, thread: { isNot: null } },
    orderBy: { updatedAt: "desc" },
    take: STATE_ROLES + 1,
    select: { thread: { select: { id: true } } },
  });
  const threadIds = listed.flatMap((group) => (group.thread ? [group.thread.id] : []));
  if (!threadIds.length) return undefined;
  const rows = await prisma.message.findMany({
    where: { threadId: { in: threadIds }, role: "user", botId: null },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { blocks: true },
  });
  for (const row of rows)
    for (const block of (Array.isArray(row.blocks) ? row.blocks : []) as MessageBlock[])
      if (block.kind === "text" && block.uiLocale) return screenLanguage(block.uiLocale);
  return undefined;
}
