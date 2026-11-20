import { createHash } from "node:crypto";
import type {
  AdapterContext,
  ArtifactStore,
  ConnectorProvider,
  WebFetchResult,
} from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  RecruitingArtifactRefSchema,
  RecruitingAssessmentToolInputSchema,
  RecruitingCandidatesToolInputSchema,
  RecruitingMaterialReadPayloadSchema,
} from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type {
  PrismaClient,
  RecruitingAssessmentArtifactBytes,
  RecruitingAssessmentSaveContext,
  ThreadEvents,
} from "@rakazo/db";
import {
  getRecruitingAssessment,
  getRecruitingQuestion,
  getRecruitingWorkspace,
  getRecruitingWorkspaceRoleId,
  IsolationError,
  listRecruitingCandidateSources,
  listRecruitingCandidates,
  listRecruitingContacts,
  readRecruiterSeen,
  readRecruitingActivity,
  readRecruitingCalibrationRound,
  recordRecruitingWebMaterial,
  saveRecruitingAssessment,
  scoped,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { inputPausedToolResult } from "./approval-effect.js";
import { readRecruitingAccountView } from "./recruiting-account.js";
import { linkedinPersonKey } from "./recruiting-profiles.js";
import {
  bestLookedUpEmail,
  createRecruitingCandidateReportReader,
  lookedUpContacts,
} from "./recruiting-research.js";
import {
  feedbackBeforeRound,
  listedBeforeRound,
  ROUND_REPEATS,
  roundListedNotRecorded,
  roundRepeats,
} from "./recruiting-round-check.js";
import {
  rememberResolvedContactEmails,
  resolveRecruitingContact,
  resolveRecruitingContactAcrossRoles,
} from "./recruiting-tools.js";

type RecruitingRunContext = { actor: Actor; runId: string; threadId: string; botId: string };
/** A missing record never stops work the recruiter's own words already describe. */
/**
 * What a role's status numbers mean. Staging 44c1ad44 (what-happened): Kruit said 153 people
 * where the shortlist page showed 0, and read a check in the role's chat at 07:38 as new activity
 * after saying nothing was new since yesterday.
 */
const ROLE_STATUS_NOTE =
  "status.savedPeople counts everyone saved in the role's Results; status.shortlisted counts only the shortlist page's people, so name which one you give. status.lastActivityAt is the last message in the role's chat (a check or a question counts), not a new person, send or reply: for what is new since a time, read operation activity.";

export const NOTHING_SAVED_IS_NO_BLOCKER =
  "Nothing saved is not a blocker: when the recruiter's own words describe the work (an email to a person they name, a role they describe), do it now from those words, and ask only the one missing fact the result still needs (such as the address to send to) beside it.";
/** Role sequences are all this read covers; a one-off email's reply lives only in the mailbox. */
export const ONE_OFF_REPLIES_NOTE =
  "Covers replies to role email sequences only. For a reply to an email sent outside a role (a one-off email), read the mailbox with search_contact_emails on that person's address before saying there is no reply.";

/**
 * An account with no open role: the roles it closed, so an empty list is known to be the whole
 * record. Simulated 11-16 (push-back-on-correct-answer, 6/10 twice): "I made three yesterday"
 * got "you're right, I was wrong" and "maybe another account" on an account that never had one.
 */
async function noOpenRoles(prisma: Pick<PrismaClient, "recruitingRole">, actor: Actor) {
  const closed = await prisma.recruitingRole.findMany({
    where: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      OR: [
        { archivedAt: { not: null } },
        { sourceThread: { group: { archivedAt: { not: null } } } },
        { sourceThread: { bot: { archivedAt: { not: null } } } },
      ],
    },
    orderBy: { id: "desc" },
    take: 10,
    select: { title: true, archivedAt: true },
  });
  return {
    closedRoles: closed.map((role) => ({
      title: role.title,
      closedAt: role.archivedAt?.toISOString() ?? null,
    })),
    note: closed.length
      ? "No open roles. closedRoles are the account's closed roles, newest first: name them when the recruiter says a role is missing, and offer to reopen it as a new role."
      : "No open or closed roles: this account has never had a role, so this is its whole record. Say so plainly, keep that answer when the recruiter insists they made some, and offer to open the roles they name now.",
  };
}

export type RecruitingAssessmentToolContext = RecruitingRunContext & {
  save?: Omit<RecruitingAssessmentSaveContext, "runId" | "threadId" | "botId">;
  attemptId?: string;
  redactText?: (text: string) => string;
};

async function requireRecruitingRun(
  prisma: PrismaClient,
  trusted: RecruitingRunContext,
  context: AdapterContext,
) {
  if (
    context.spaceId !== trusted.actor.spaceId ||
    context.userId !== trusted.actor.userId ||
    context.runId !== trusted.runId ||
    context.botId !== trusted.botId
  )
    throw new IsolationError();
  context.signal.throwIfAborted();
  const run = scoped(
    trusted.actor,
    await prisma.run.findFirst({
      where: { id: trusted.runId, spaceId: trusted.actor.spaceId, userId: trusted.actor.userId },
      select: {
        spaceId: true,
        userId: true,
        threadId: true,
        botId: true,
        bot: { select: { spaceId: true, userId: true } },
      },
    }),
  );
  scoped(trusted.actor, run.bot);
  if (run.threadId !== trusted.threadId || run.botId !== trusted.botId) throw new IsolationError();
}

/** People per numbered page of a candidate list read. */
const PAGE_SIZE = 10;

/** The fields of a listed person that say what the recruiter already saw of them. */
export type RecruiterListItem = {
  candidateKey?: unknown;
  location?: string | null;
  shownInRound?: number;
  /** What the recruiter saw of them, in words; absent for someone new. */
  alreadySeen?: string;
  recruiterVerdict?: "good_example" | "not_fit";
  decision?: string | null;
};

/**
 * Who a page of a role's people shows the recruiter: never anyone turned down, shown in a round,
 * already listed in this reply or, for a local role, living beyond commuting distance. `inRounds`
 * and `farAway` count the people left out because a round already showed them or they live too far.
 */
export function peopleToShow<T extends RecruiterListItem>(
  items: readonly T[],
  input: {
    size: number;
    listed: ReadonlySet<string>;
    beyond?: (location: string) => boolean;
  },
): { shown: T[]; inRounds: number; farAway: number } {
  const page = items.slice(0, input.size);
  const far = (item: T) => Boolean(item.location && input.beyond?.(item.location));
  const shown = page.filter(
    (item) =>
      item.recruiterVerdict !== "not_fit" &&
      item.decision !== "pass" &&
      item.shownInRound === undefined &&
      !far(item) &&
      !(typeof item.candidateKey === "string" && input.listed.has(item.candidateKey)),
  );
  return {
    shown,
    inRounds: page.filter((item) => item.shownInRound !== undefined).length,
    farAway: page.filter((item) => item.shownInRound === undefined && far(item)).length,
  };
}

/** About 10k tokens: a whole account read stays one tool result the model can still answer from. */
const ACCOUNT_PAGE_CHARS = 40_000;

/**
 * Ends a page of account roles at the last role that fits, paging on from it as the reader's own
 * cursor does (roles after that id). Staging 11-20: 20 roles of sequences, each with its stored
 * mail, did not fit the model's context and the turn failed with nothing said.
 */
function fitAccountPage(result: {
  items: { roleId: string }[];
  nextCursor: string | null;
}): void {
  let used = 0;
  const kept = result.items.findIndex((item, index) => {
    used += JSON.stringify(item).length;
    return index > 0 && used > ACCOUNT_PAGE_CHARS;
  });
  if (kept < 0) return;
  result.items = result.items.slice(0, kept);
  result.nextCursor = result.items.at(-1)!.roleId;
}

export async function executeRecruitingCandidatesTool(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    connector?: Pick<ConnectorProvider, "execute">;
  },
  trusted: RecruitingRunContext,
  untrusted: unknown,
  context: AdapterContext,
) {
  const input = RecruitingCandidatesToolInputSchema.parse(untrusted);
  const started = performance.now();
  let succeeded = false;
  // Phase split for the existing timing line: authorization, database page, saved reports.
  let authorizeMs: number | null = null;
  let queryMs: number | null = null;
  let reportReadMs: number | null = null;
  let itemCount: number | null = null;
  try {
    await requireRecruitingRun(deps.prisma, trusted, context);
    const roleId = await getRecruitingWorkspaceRoleId(deps.prisma, trusted.actor, {
      threadId: trusted.threadId,
    });
    authorizeMs = Math.round(performance.now() - started);
    const queryStarted = performance.now();
    // A chat with no role of its own (Kruit) names the role by roleId. Hand back the open
    // roles so the next call reads the right one, instead of a dead end the model routes around.
    const noCurrentRole = async () => ({
      status: "no_current_role" as const,
      roles: await deps.prisma.recruitingRole.findMany({
        where: {
          userId: trusted.actor.userId,
          spaceId: trusted.actor.spaceId,
          archivedAt: null,
          sourceThread: { OR: [{ group: { archivedAt: null } }, { bot: { archivedAt: null } }] },
        },
        orderBy: { id: "desc" },
        take: 30,
        select: { id: true, title: true },
      }),
      // Gate 71a2cac2 (one-off-email): with no fintech role saved, "直接发" became a request for the
      // role's title or JD instead of the send.
      next: `If one of these roles is the one the recruiter named, call again with its roleId. ${NOTHING_SAVED_IS_NO_BLOCKER}`,
    });
    if (input.operation === "resolve") {
      // A role conversation resolves in its own role; elsewhere a named role narrows it.
      const resolveRoleId = roleId ?? input.roleId;
      const result = resolveRoleId
        ? await resolveRecruitingContact(
            deps,
            trusted.actor,
            { roleId: resolveRoleId, nameOrEmail: input.nameOrEmail },
            context,
          )
        : await resolveRecruitingContactAcrossRoles(
            deps,
            trusted.actor,
            input.nameOrEmail,
            context,
          );
      itemCount = result.matches.length;
      succeeded = true;
      // Branch x5 61eaccec (one-off-email): no saved match for "给 Wei Zhang 写封邮件" became a
      // request for the role's JD instead of the email.
      return result.status === "not_found"
        ? { ...result, next: NOTHING_SAVED_IS_NO_BLOCKER }
        : result;
    }
    if (input.operation === "activity") {
      // Simulated 11-16 (what-happened-since-yesterday, 1/10): "what's new on each role since
      // yesterday" had no read that answers it, so Kruit talked about an open card instead.
      const until = input.until ?? new Date().toISOString();
      const activityRoleId = input.roleId ?? roleId;
      const result = await readRecruitingActivity(deps.prisma, trusted.actor, {
        since: input.since,
        until,
        ...(activityRoleId ? { roleId: activityRoleId } : {}),
      });
      itemCount = result.roles.length;
      succeeded = true;
      return {
        operation: input.operation,
        since: input.since,
        until,
        ...result,
        note: `Roles not listed had nothing new (quietRoles counts them): say so plainly. emailedPeople and repliedPeople come from the role's stored email; mail "none_stored" means those two are unknown for that role, not zero. ${ONE_OFF_REPLIES_NOTE}`,
      };
    }
    if (input.operation === "contacts") {
      // Simulated 11-14: "which roles have people not emailed yet" got "cannot verify" on an
      // account with 985 roles. The Contacts page's own read answers it, newest people first.
      const page = await listRecruitingContacts(deps.prisma, trusted.actor, {
        filters: {
          ...((input.roleId ?? roleId) ? { roleIds: [(input.roleId ?? roleId)!] } : {}),
          ...(input.contacted !== undefined ? { contacted: input.contacted } : {}),
          ...(input.replied !== undefined ? { replied: input.replied } : {}),
        },
        sort: "added",
        cursor: input.cursor,
        limit: Math.min(input.limit ?? 25, 50),
      });
      itemCount = page.items.length;
      succeeded = true;
      return {
        operation: input.operation,
        total: page.total,
        nextCursor: page.nextCursor,
        items: page.items.map((person) => ({
          name: person.name,
          title: person.title,
          company: person.company,
          email: person.email,
          roles: person.roles.map((role) => ({ roleId: role.id, title: role.title })),
          lastContactedAt: person.lastContactedAt,
          lastRepliedAt: person.lastRepliedAt,
        })),
      };
    }
    if (
      input.operation === "roles" ||
      input.operation === "interviews" ||
      input.operation === "shortlist" ||
      input.operation === "replies" ||
      input.operation === "sequences"
    ) {
      const views = {
        roles: "roles",
        interviews: "interview",
        shortlist: "shortlist",
        replies: "inbox",
        sequences: "sequence",
      } as const;
      const operation = input.operation as keyof typeof views;
      if (!deps.connector) throw new Error("Recruiting records require a connected tool host");
      const result = await readRecruitingAccountView(
        {
          ...deps,
          connectors: deps.connector,
          signal: context.signal,
          stillAuthorized: async () => {
            await requireRecruitingRun(deps.prisma, trusted, context);
            return true;
          },
        },
        trusted.actor,
        {
          view: views[operation],
          roleId: ("roleId" in input ? input.roleId : undefined) ?? roleId ?? undefined,
          since: "since" in input ? input.since : undefined,
          cursor: input.cursor,
          itemCursor: input.itemCursor,
          campaignId: input.campaignId,
          campaignServerId: input.campaignServerId,
          campaignLeadCursor: input.campaignLeadCursor,
          // One call covers every role for an account-wide interview question.
          limit: Math.min(input.limit ?? (operation === "interviews" ? 50 : 20), 50),
        },
      );
      fitAccountPage(result);
      const unknownReplyDirections =
        operation === "replies"
          ? result.items.reduce(
              (total, item) =>
                total +
                (item.correspondence?.emails.filter(
                  (email) => (email.direction ?? email.crm?.direction) == null,
                ).length ?? 0),
              0,
            )
          : 0;
      if (operation === "replies") {
        for (const item of result.items) {
          if (item.correspondence)
            item.correspondence.emails = item.correspondence.emails.filter(
              (email) => (email.direction ?? email.crm?.direction) === "received",
            );
        }
      }
      itemCount = result.items.length;
      succeeded = true;
      // The page's own roles only: on a large account the full role list is hundreds of rows the
      // agent re-reads every turn; total and nextCursor still page through the rest.
      const listed = new Set(result.items.map((item) => item.roleId));
      const paged = { ...result, roles: result.roles.filter((role) => listed.has(role.id)) };
      if (operation === "roles" && !result.roles.length && !input.cursor)
        return { ...paged, ...(await noOpenRoles(deps.prisma, trusted.actor)) };
      if (operation === "roles") return { ...paged, note: ROLE_STATUS_NOTE };
      return operation === "replies"
        ? {
            ...paged,
            note: ONE_OFF_REPLIES_NOTE,
            counts: {
              messages: result.items.reduce(
                (total, item) => total + (item.correspondence?.emails.length ?? 0),
                0,
              ),
              people: new Set(
                result.items.flatMap(
                  (item) =>
                    item.correspondence?.emails.map((email) => email.sender).filter(Boolean) ?? [],
                ),
              ).size,
              complete:
                result.nextCursor === null &&
                unknownReplyDirections === 0 &&
                result.items.every(
                  (item) =>
                    (item.correspondence?.status === "ready" ||
                      item.correspondence?.status === "empty") &&
                    !item.correspondence.connectionChanged &&
                    item.correspondence.connections.every(
                      (connection) => connection.status === "configured" && !connection.checkIssue,
                    ) &&
                    !item.correspondence.partial &&
                    !item.correspondence.nextCursor,
                ),
            },
          }
        : paged;
    }
    if (input.operation === "list") {
      const { operation: _operation, roleId: namedRoleId, page, ...query } = input;
      const listRoleId = roleId ?? namedRoleId;
      if (page !== undefined && query.cursor === undefined) {
        query.limit ??= PAGE_SIZE;
        Object.assign(query, { offset: (page - 1) * query.limit });
      }
      if (!listRoleId) {
        succeeded = true;
        return noCurrentRole();
      }
      const result = await listRecruitingCandidates(deps.prisma, trusted.actor, {
        roleId: listRoleId,
        ...query,
      });
      queryMs = Math.round(performance.now() - queryStarted);
      itemCount = result.items.length;
      // Every agent sees the emails earlier contact lookups saved, in any later turn.
      const lookups = result.items.length
        ? await lookedUpContacts(deps.prisma, trusted.actor)
        : { emails: new Map(), searched: new Map() };
      const found = lookups.emails;
      const enriched = found.size
        ? result.items.flatMap((item) => {
            const email = bestLookedUpEmail(found, item.linkedinUrl, item.candidateKey);
            return email ? [{ item, email }] : [];
          })
        : [];
      if (context.runId && enriched.length)
        rememberResolvedContactEmails(
          context.runId,
          enriched.map(({ item, email }) => ({
            name: item.name ?? null,
            email: email.address,
            linkedinUrl: item.linkedinUrl ?? null,
            sources: ["saved_pool" as const],
            crmCandidateId: null,
            candidateKey: item.candidateKey,
            stage: null,
            outreachStatus: null,
          })),
        );
      succeeded = true;
      // The query only filters people; a role name passed as one matches no one. Gates eec6adf0,
      // 386f6a46, 808f4f31 (one-off-email): "nothing saved" read as a blocker, and a draft for a
      // named person turned into a request for a role title and profile link.
      if (!result.items.length && query.query?.trim())
        return {
          ...result,
          next: `No saved person matched this query. To list the role's people, call again without query. ${NOTHING_SAVED_IS_NO_BLOCKER}`,
        };
      const emails = new Map(enriched.map(({ item, email }) => [item, email]));
      // Every list carries what the recruiter already saw of each person, from the one record.
      const seen = await readRecruiterSeen(deps.prisma, trusted.actor, {
        roleId: listRoleId,
        candidateKeys: result.items.map((item) => item.candidateKey),
      });
      const anySeen = [...seen.people.values()].some(
        (person) => person.round !== undefined || person.seenBeforeLatestRound || person.verdict,
      );
      // Team-has-no-email (245ab70b, 2/10): "who has no email" had only a missing field to go on.
      const noEmail = (item: (typeof result.items)[number]) =>
        [linkedinPersonKey(item.linkedinUrl), item.candidateKey].some(
          (key) => key && lookups.searched.has(key),
        )
          ? ("none_found" as const)
          : ("not_looked_up" as const);
      if (!enriched.length && !anySeen && !seen.latestRound)
        return {
          ...result,
          items: result.items.map((item) => ({ ...item, email: noEmail(item) })),
        };
      return {
        ...result,
        ...(seen.latestRound
          ? {
              latestRound: {
                round: seen.latestRound.round,
                recordedAt: seen.latestRound.recordedAt.toISOString(),
                people: seen.latestRound.people,
                accepted: seen.latestRound.accepted,
              },
            }
          : {}),
        items: result.items.map((item) => {
          const email = emails.get(item);
          const person = seen.people.get(item.candidateKey);
          return {
            ...item,
            email: email
              ? { address: email.address, type: email.type, status: email.status }
              : noEmail(item),
            ...(person?.round !== undefined ? { shownInRound: person.round } : {}),
            // A later round may not show people a round showed. Said in words, so a person only
            // found (who a later round may show) is never called a repeat of a round.
            // Staging 11-15: "shown in round 2" on round 2's own people read as repeats.
            ...(person?.round !== undefined
              ? {
                  alreadySeen:
                    person.round > 1 && person.round === seen.latestRound?.round
                      ? `in round ${person.round}, the latest round, and in no earlier round: not a repeat`
                      : `shown in round ${person.round}`,
                }
              : person?.seenBeforeLatestRound
                ? {
                    alreadySeen: `found before round ${seen.latestRound?.round ?? 1} and never shown in a round: not a repeat of any round`,
                  }
                : {}),
            ...(person?.verdict ? { recruiterVerdict: person.verdict } : {}),
          };
        }),
      };
    }
    if (input.operation === "round") {
      if (!roleId && !input.roleId) {
        succeeded = true;
        return { status: "no_current_role" as const };
      }
      const { roleId: roundRoleId, round } = await readRecruitingCalibrationRound(
        deps.prisma,
        trusted.actor,
        {
          threadId: trusted.threadId,
          roleId: input.roleId,
        },
      );
      itemCount = round?.candidates.length ?? 0;
      succeeded = true;
      // Staging 11-15: the role's chat showed the new ten 23 s before their record was written;
      // Kruit read the older round in between, reposted it and said the new one was not ready.
      const listedRoleId = roundRoleId ?? input.roleId;
      const listedNext = listedRoleId
        ? await roundListedNotRecorded(deps.prisma, {
            roleId: listedRoleId,
            after: round?.createdAt ?? new Date(0).toISOString(),
          }).catch(() => null)
        : null;
      const nextListed = listedNext
        ? {
            nextRoundBeingPosted: `Round ${(round?.round ?? 0) + 1} is being posted right now and is not the round below. Read round again in a moment and show its people; never call it not ready, never mention records, never send the recruiter to another chat, and never show the round below as the new one.`,
          }
        : {};
      if (!round) return { status: "no_round" as const, ...nextListed };
      // Staging 11-15: asked about repeats and their feedback, global Kruit read round labels
      // wrong and could not find what the recruiter said in the role's chat.
      const feedback = await feedbackBeforeRound(deps.prisma, {
        spaceId: trusted.actor.spaceId,
        roleId: roundRoleId ?? input.roleId ?? "",
        round: round.round,
        createdAt: round.createdAt,
      }).catch(() => []);
      // Staging 11-15: Kruit listed saved people while the round was prepared, the round then
      // picked four of them, and Kruit called them repeats of round 1 and had them dropped.
      const listed = await listedBeforeRound(deps.prisma, {
        threadId: trusted.threadId,
        roleId: roundRoleId ?? input.roleId ?? "",
        round: round.round,
        createdAt: round.createdAt,
        candidates: round.candidates,
      }).catch(() => []);
      return {
        status: "found" as const,
        round: {
          ...round,
          repeats: await roundRepeats(deps.prisma, {
            roleId: roundRoleId ?? input.roleId ?? "",
            round: round.round,
            candidates: round.candidates,
          }).catch(() => ROUND_REPEATS),
          ...nextListed,
          ...(feedback.length ? { feedbackBeforeThisRound: feedback } : {}),
          ...(listed.length
            ? {
                listedInThisChatBeforeTheRound: `${listed.join(", ")}: listed in this chat before round ${round.round} as saved, unreviewed results, never in an earlier round. Say exactly that; they are not repeats of any round.`,
              }
            : {}),
        },
      };
    }
    const { operation: _operation, roleId: namedSourceRoleId, ...query } = input;
    const sourceRoleId = roleId ?? namedSourceRoleId;
    if (!sourceRoleId) {
      succeeded = true;
      return noCurrentRole();
    }
    if (!deps.artifacts) throw new IsolationError();
    const result = await listRecruitingCandidateSources(deps.prisma, trusted.actor, {
      roleId: sourceRoleId,
      ...query,
    });
    queryMs = Math.round(performance.now() - queryStarted);
    itemCount = result.items.length;
    const reportsStarted = performance.now();
    const readReport = createRecruitingCandidateReportReader(deps, trusted.actor, sourceRoleId, {
      fromTool: true,
    });
    // Read distinct saved pages together; sources sharing a page stay sequential so the
    // reader's per-request cache verifies and decodes that page once.
    const byArtifact = new Map<string, number[]>();
    result.items.forEach((source, index) => {
      const key = source.artifactRef.artifactId;
      byArtifact.set(key, [...(byArtifact.get(key) ?? []), index]);
    });
    const reports: Awaited<ReturnType<typeof readReport>>["report"][] = [];
    await Promise.all(
      [...byArtifact.values()].map(async (indexes) => {
        for (const index of indexes)
          reports[index] = (await readReport(result.items[index]!)).report;
      }),
    );
    const items = result.items.map((source, index) => ({ ...source, report: reports[index] }));
    reportReadMs = Math.round(performance.now() - reportsStarted);
    succeeded = true;
    return { ...result, items };
  } finally {
    getLogger().info("recruiting.candidates.read.timing", {
      operation: input.operation,
      limit: "limit" in input ? (input.limit ?? null) : null,
      hasCursor: "cursor" in input && input.cursor !== undefined,
      durationMs: Math.round(performance.now() - started),
      authorizeMs,
      queryMs,
      reportReadMs,
      itemCount,
      outcome: succeeded ? "succeeded" : "error",
    });
  }
}

export async function executeRecruitingAssessmentTool(
  deps: {
    prisma: PrismaClient;
    artifacts?: ArtifactStore;
    events?: Pick<ThreadEvents, "pauseRunForInput">;
  },
  trusted: RecruitingAssessmentToolContext,
  untrusted: unknown,
  context: AdapterContext,
) {
  const input = RecruitingAssessmentToolInputSchema.parse(untrusted);
  await requireRecruitingRun(deps.prisma, trusted, context);
  const { actor, runId, threadId, botId } = trusted;
  if (input.operation === "read") {
    const workspace = await getRecruitingWorkspace(deps.prisma, actor, { threadId });
    const assessment = workspace
      ? await getRecruitingAssessment(deps.prisma, actor, {
          roleId: workspace.role.id,
          candidateKey: input.candidateKey,
        })
      : null;
    return { status: "current" as const, workspace, assessment };
  }
  const save = trusted.save;
  if (
    !deps.artifacts ||
    !save?.leaseOwner ||
    !Number.isInteger(save.leaseFence) ||
    save.leaseFence < 0 ||
    !save.effectId ||
    save.effectRequest === undefined
  )
    throw new IsolationError();
  const contextArtifact = save.contextArtifact
    ? RecruitingArtifactRefSchema.parse(save.contextArtifact)
    : undefined;
  const references = new Map<string, string>();
  if (contextArtifact) references.set(contextArtifact.artifactId, contextArtifact.sha256);
  for (const source of input.operation === "ask" ? [] : input.sourceRefs) {
    if (source.readState !== "read" || source.anchor.kind !== "artifact") continue;
    const { artifactId, sha256 } = source.anchor.artifact;
    const previous = references.get(artifactId);
    if (previous !== undefined && previous !== sha256) throw new IsolationError();
    references.set(artifactId, sha256);
  }
  const rows = await deps.prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [...references].map(([id, hash]) => ({ id, hash })),
    },
    select: { id: true, spaceId: true, userId: true, hash: true, storageKey: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const authorized = [...references].map(([id, hash]) => {
    const row = scoped(actor, byId.get(id) ?? null);
    if (row.hash !== hash) throw new IsolationError();
    return row;
  });
  const bytes: RecruitingAssessmentArtifactBytes[] = [];
  for (const row of authorized) {
    context.signal.throwIfAborted();
    bytes.push({ artifactId: row.id, bytes: await deps.artifacts.get(row.storageKey, context) });
  }
  context.signal.throwIfAborted();
  if (input.operation === "ask") {
    if (!deps.events || !trusted.attemptId) throw new IsolationError();
    const actions = input.options.map((label, index) => ({ id: `choice-${index + 1}`, label }));
    const redact = trusted.redactText ?? ((text: string) => text);
    const paused = await deps.events.pauseRunForInput({
      spaceId: actor.spaceId,
      threadId,
      botId,
      runId,
      attemptId: trusted.attemptId,
      leaseOwner: save.leaseOwner,
      leaseFence: save.leaseFence,
      blocks: [
        {
          kind: "ask",
          text: redact(input.question),
          status: "pending",
          actions: actions.map(({ id, label }) => ({ id, label: redact(label) })),
          ...(input.multiple ? { multiple: true } : {}),
        },
      ],
      offeredActions: actions,
      recruitingQuestion: {
        actor,
        effectId: save.effectId,
        effectRequest: save.effectRequest,
        ...(contextArtifact ? { contextArtifact } : {}),
        artifacts: bytes,
      },
    });
    if (!paused) throw new Error("Could not pause this run for the recruiting question");
    const question = await getRecruitingQuestion(deps.prisma, actor, {
      threadId,
      roleId: input.roleId,
      effectId: save.effectId,
    });
    if (!question) throw new IsolationError();
    return question.canAnswer && question.runStatus === "waiting_input"
      ? inputPausedToolResult()
      : { question };
  }
  const { operation: _operation, ...assessment } = input;
  return saveRecruitingAssessment(
    deps.prisma,
    actor,
    { runId, threadId, botId, ...save, ...(contextArtifact ? { contextArtifact } : {}) },
    assessment,
    bytes,
  );
}

/** The existing native reader supplies actual fetched content, never model-authored proof. */
export async function retainRecruitingWebMaterial(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  trusted: RecruitingRunContext &
    Pick<RecruitingAssessmentSaveContext, "leaseOwner" | "leaseFence">,
  result: WebFetchResult,
  context: AdapterContext,
) {
  await requireRecruitingRun(deps.prisma, trusted, context);
  if (!result.text.trim()) return undefined;
  const material = {
    url: result.url,
    title: result.title,
    text: result.text,
    truncated: result.truncated,
  };
  const bytes = Buffer.from(stableJsonValue(material), "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const name = `recruiting-material-${hash}.json`;
  context.signal.throwIfAborted();
  const stored = await deps.artifacts.put({ name, mimeType: "application/json", bytes }, context);
  // ponytail: retain failed/repeated uploads; ArtifactStore.put may reuse a content-addressed blob.
  // Delete only through an exclusive-put or native garbage-collection contract.
  context.signal.throwIfAborted();
  const { actor, runId, threadId, botId, leaseOwner, leaseFence } = trusted;
  const saved = await recordRecruitingWebMaterial(
    deps.prisma,
    actor,
    { runId, threadId, botId, leaseOwner, leaseFence },
    {
      artifact: {
        name,
        mimeType: "application/json",
        size: bytes.byteLength,
        hash,
        storageKey: stored.id,
        clientNonce: `recruiting-material:${runId}:${hash}`,
      },
      reader: "web_fetch",
      url: result.url,
      readAt: new Date().toISOString(),
    },
  );
  const receipt = RecruitingMaterialReadPayloadSchema.parse(saved.event.payload);
  return { artifact: receipt.artifact, url: receipt.url, readAt: receipt.readAt };
}
