import type { AdapterContext, MemoryStore } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type {
  Actor,
  RecruitingCandidateFeedbackSelection,
  RecruitingFeedbackInput,
  RecruitingRole,
  RecruitingRoleRevision,
  RecruitingSourceRef,
} from "@rakazo/contracts";
import { RecruitingFeedbackInputSchema } from "@rakazo/contracts";
import { applyRecruitingPreferenceEdit, tidyPreferenceDocument } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  approveRecruitingCalibrationRoundFromMessage,
  executeNativeRecruitingCandidateDecision,
  Prisma,
  readRecruitingFeedbackContext,
} from "@rakazo/db";
import type { ZodError } from "zod";
import { criteriaAssessment } from "./recruiting-criteria-check.js";

/** Why a preference naming the chat's role is not saved to memory shared by every role. */
export const ROLE_PREFERENCE_ERROR =
  'Not saved: shared preferences apply to every role, so a requirement for one role goes on that role. Save it with recruiting_role update (or recruiting_feedback target:"role"), and keep only what the recruiter said for all roles as a preference.';

/** Why a pasted job description or new-role request is not saved as a shared preference. */
export const NEW_ROLE_PREFERENCE_ERROR =
  "Not saved: this is a role's job description or a new role, not a preference for every role. Open the role first (start_role in the recruiter's own chat, otherwise recruiting_role) and keep its requirements on that role; save a preference only for what the recruiter said applies to all roles.";

/** A job description or new-role request: a title or new-role label at the start, or a "Job Title:" line. */
const NEW_ROLE_TEXT =
  /^\s*(?:新(?:的)?(?:岗位|职位)|(?:岗位|职位)(?:名称)?|new (?:role|position|job|opening)|job title)\s*[:：]|(?:^|\n)\s*job title\s*[:：]/i;

/**
 * Round direction marks no one. fosp x5 11-20 (753783e2): "4、5、7不行…" and a turn-down naming three
 * people were saved as round scope with no people, so Results showed none of them as not a fit
 * until the recruiter complained. The result names the round's people by number so the agent can
 * mark the ones the recruiter's words were about.
 */
function roundDirectionNext(people: string[]) {
  return `Saved as direction for the next round; it marks no one on Results. The latest round as numbered for the recruiter: ${people.join("; ")}. If their words turned down or praised any of these people, by name or by number, record those people now with target "candidate", operation "review" and fit "not_fit" or "good_example" (one call per fit), using these keys.`;
}

/** The latest round the recruiter saw, as "1. Name = key" in the order its list numbers them. */
async function latestRoundPeople(prisma: PrismaClient, roleId: string): Promise<string[]> {
  return Promise.resolve()
    .then(async () => {
      const round = await prisma.recruitingCalibrationRound.findFirst({
        where: { roleId, status: "shown" },
        orderBy: { round: "desc" },
        select: { candidateKeys: true },
      });
      if (!round?.candidateKeys.length) return [];
      const names = new Map(
        (
          await prisma.recruitingCandidateOccurrence.findMany({
            where: { roleId, candidateKey: { in: round.candidateKeys }, name: { not: null } },
            select: { name: true, candidateKey: true },
            distinct: ["candidateKey"],
          })
        ).map((row) => [row.candidateKey, row.name]),
      );
      return round.candidateKeys.map(
        (key, index) => `${index + 1}. ${names.get(key) ?? "?"} = ${key}`,
      );
    })
    .catch(() => []);
}

export class RecruitingFeedbackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecruitingFeedbackValidationError";
  }
}

/**
 * A rejected recruiting_feedback call in plain words: what was not saved, each field that failed
 * and which target and operation fit which feedback, instead of the raw schema report.
 */
export function recruitingFeedbackInputError(error: ZodError): string {
  const fields = error.issues.flatMap((issue) => {
    const nested = (issue as { errors?: { message: string; path: PropertyKey[] }[][] }).errors;
    const issues = issue.code === "invalid_union" && nested?.length ? nested.flat() : [issue];
    return issues.map((item) => {
      const path = [...issue.path, ...(item === issue ? [] : item.path)].map(String).join(".");
      return `${path || "input"}: ${item.message}`;
    });
  });
  return [
    "Not recorded: nothing was saved, so never tell the recruiter it was recorded.",
    `${[...new Set(fields)].join("; ")}.`,
    'Fix these and call recruiting_feedback again. Targets: "round" with operation "scope" for feedback or a new direction for the next round, or "approve" only when the recruiter accepts the round; "candidate" with operation "review" and the keys of the people they named; "role" with operation "revise" for changed requirements.',
  ].join(" ");
}

export type RecruitingFeedbackResult = {
  feedback: RecruitingFeedbackInput;
  source: RecruitingSourceRef;
  workspace: { role: RecruitingRole; revision: RecruitingRoleRevision } | null;
  /** Per named person, how their profile was judged on each requirement of the role. */
  profilesShow?: Record<string, string>;
  profilesShowNote?: string;
} & (
  | { status: "needs_clarification" }
  | {
      status: "proposed";
      nextTool?: "recruiting_role";
    }
  | {
      status: "recorded" | "already_recorded";
      choice?: RecruitingCandidateFeedbackSelection["choice"];
      /** The calibration round an approval accepted. */
      round?: number;
      /** What to do in the same turn once a round is accepted. */
      next?: string;
    }
  | {
      status: "saved";
      document: {
        id: string;
        scope: "bot" | "user";
        path: string;
        revision: number;
        anchor: { start: number; end: number; quote: string } | null;
      };
    }
);

/**
 * A recruiter's reason for a decision on a person can differ from what the person's profile was
 * judged to show (a recruiter said "under five years" of someone judged to meet five years, and
 * the next search carried that reason, 11-26). The decision is theirs and is recorded as given;
 * its result carries the saved verdicts so the reply rests on them, not on the reason alone.
 */
export async function executeRecruitingFeedback(
  ...args: Parameters<typeof recordRecruitingFeedback>
): Promise<RecruitingFeedbackResult> {
  const result = await recordRecruitingFeedback(...args);
  const { feedback } = result;
  if (feedback.target !== "candidate") return result;
  const judged = await args[0].prisma.recruitingCandidateOccurrence.findMany({
    where: {
      roleId: feedback.roleId,
      candidateKey: { in: [...feedback.candidateKeys] },
      matchFields: { path: ["criteria"], not: Prisma.AnyNull },
    },
    orderBy: { page: { observedAt: "desc" } },
    select: { candidateKey: true, name: true, matchFields: true },
  });
  const profilesShow: Record<string, string> = {};
  for (const row of judged) {
    const criteria = (row.matchFields as { criteria?: Parameters<typeof criteriaAssessment>[0] })
      .criteria;
    const name = row.name ?? row.candidateKey;
    if (Array.isArray(criteria) && criteria.length && !(name in profilesShow))
      profilesShow[name] = criteriaAssessment(criteria);
  }
  return Object.keys(profilesShow).length
    ? { ...result, profilesShow, profilesShowNote: PROFILES_SHOW_NOTE }
    : result;
}

const PROFILES_SHOW_NOTE =
  "profilesShow is how each named person's profile was judged on the role's requirements. The recruiter's decision stands as recorded. Where their reason differs from it, say in one line what the profile shows, and leave that reason out of the next search.";

async function recordRecruitingFeedback(
  deps: { prisma: PrismaClient; memory: MemoryStore },
  trusted: { actor: Actor; runId: string; sourceMessageId: string | null },
  untrusted: unknown,
  context: AdapterContext,
  options?: {
    mutation?: {
      effectId: string;
      effectRequest: unknown;
      leaseOwner: string;
      leaseFence: number;
      threadId: string;
    };
    expectedMemory?: {
      scope: "bot" | "user";
      path: string;
      expectedRevision: number;
      content: string;
    };
  },
): Promise<RecruitingFeedbackResult> {
  const parsed = RecruitingFeedbackInputSchema.safeParse(untrusted);
  if (!parsed.success)
    throw new RecruitingFeedbackValidationError(recruitingFeedbackInputError(parsed.error));
  const feedback = parsed.data;
  const { actor, runId, sourceMessageId } = trusted;
  const botId = context.botId;
  if (
    !botId ||
    context.spaceId !== actor.spaceId ||
    context.userId !== actor.userId ||
    context.runId !== runId
  )
    throw new RecruitingFeedbackValidationError("Recruiting feedback does not belong to this run");
  context.signal.throwIfAborted();
  if (
    feedback.target === "candidate" &&
    feedback.operation !== "review" &&
    feedback.intent.basis === "direct"
  ) {
    if (!options?.mutation)
      throw new RecruitingFeedbackValidationError(
        "Candidate decisions require a native effect and live lease",
      );
    return executeNativeRecruitingCandidateDecision(
      deps.prisma,
      actor,
      { ...options.mutation, runId, sourceMessageId, botId },
      feedback,
    );
  }
  const {
    source,
    workspace,
    threadId,
    botId: runBotId,
    choice,
  } = await readRecruitingFeedbackContext(deps.prisma, actor, {
    runId,
    sourceMessageId,
    intent: feedback.intent,
    sourceRefs: feedback.sourceRefs,
    ...(feedback.target === "preference"
      ? {}
      : { roleId: feedback.roleId, expectedRoleRevision: feedback.expectedRoleRevision }),
    ...(feedback.target === "candidate" ? { candidateKeys: feedback.candidateKeys } : {}),
    ...(feedback.target === "round" && feedback.operation === "approve"
      ? { acceptEarlierQuote: true }
      : {}),
    ...((feedback.target === "round" && feedback.operation === "scope") ||
    (feedback.target === "candidate" && feedback.operation === "review")
      ? { recordKeeping: true }
      : {}),
  });
  if (runBotId !== botId)
    throw new RecruitingFeedbackValidationError("Recruiting feedback does not belong to this run");
  const result = { feedback, source, workspace };
  if (feedback.intent.basis === "inferred") return { ...result, status: "needs_clarification" };
  if (feedback.target === "round" && feedback.operation === "approve") {
    const approved = await approveRecruitingCalibrationRoundFromMessage(deps.prisma, actor, {
      runId,
      sourceMessageId,
      intent: feedback.intent,
      roleId: feedback.roleId,
      expectedRoleRevision: feedback.expectedRoleRevision,
    });
    return {
      ...result,
      status: approved.already ? "already_recorded" : "recorded",
      round: approved.round,
    };
  }
  if (feedback.target === "round") {
    const people = await latestRoundPeople(deps.prisma, feedback.roleId);
    return {
      ...result,
      status: choice ? "already_recorded" : "recorded",
      ...(choice ? { choice } : {}),
      ...(people.length ? { next: roundDirectionNext(people) } : {}),
    };
  }
  if (feedback.target === "candidate")
    return {
      ...result,
      status: choice ? "already_recorded" : "recorded",
      ...(choice ? { choice } : {}),
    };
  if (feedback.target === "role")
    return {
      ...result,
      status: "proposed",
      nextTool: "recruiting_role",
    };
  const expected = options?.expectedMemory;
  if (
    expected &&
    (expected.scope !== feedback.scope ||
      expected.path !== feedback.path ||
      expected.expectedRevision !== feedback.expectedRevision)
  )
    throw new RecruitingFeedbackValidationError(
      "Memory target does not match the recruiting preference proposal",
    );
  // Shared preferences apply to every role; a line naming this chat's role belongs on the role.
  if (feedback.operation !== "revoke") {
    if (NEW_ROLE_TEXT.test(feedback.content))
      throw new RecruitingFeedbackValidationError(NEW_ROLE_PREFERENCE_ERROR);
    const role = await deps.prisma.thread
      .findUnique({
        where: { id: threadId },
        select: { activeRecruitingRole: { select: { title: true } } },
      })
      .then((found) => found?.activeRecruitingRole?.title.trim());
    if (role && role.length >= 6 && feedback.content.toLowerCase().includes(role.toLowerCase()))
      throw new RecruitingFeedbackValidationError(
        `${ROLE_PREFERENCE_ERROR} This one names the role "${role}".`,
      );
  }
  const target = {
    scope: feedback.scope,
    path: feedback.path,
    ...(feedback.scope === "bot" ? { botId } : {}),
  };
  const snapshot = await deps.memory.read(target, context);
  const document = snapshot.documents[0];
  if ((document?.revision ?? 0) !== feedback.expectedRevision)
    throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
  let edited: ReturnType<typeof applyRecruitingPreferenceEdit>;
  try {
    edited = applyRecruitingPreferenceEdit(document?.content ?? "", feedback);
  } catch (error) {
    throw new RecruitingFeedbackValidationError(
      error instanceof Error ? error.message : "Invalid preference edit",
    );
  }
  if (
    feedback.operation === "add" &&
    edited.previousAnchor &&
    edited.content === tidyPreferenceDocument(document?.content ?? "")
  )
    return { ...result, status: "already_recorded" };
  if (
    expected &&
    tidyPreferenceDocument(expected.content) !== tidyPreferenceDocument(edited.content)
  )
    throw new RecruitingFeedbackValidationError(
      'Memory content does not match the recruiting preference edit. Nothing was written. Use recruiting_feedback with target:"preference", the loaded scope, path and expectedRevision, and the full exact edit: add appends content; replace changes only its exact anchor; revoke removes only that anchor. Do not substitute a summary for content. Correct and resubmit only the originally authorized edit; required approvals still apply.',
    );
  context.signal.throwIfAborted();
  const saved = await deps.memory.commit(
    {
      ...target,
      content: edited.content,
      expectedRevision: feedback.expectedRevision,
      sourceRunId: runId,
      sourceThreadId: threadId,
      recruiting: { sourceMessageId, feedback },
    },
    context,
  );
  return {
    ...result,
    status: "saved",
    document: {
      id: saved.id,
      scope: feedback.scope,
      path: saved.path,
      revision: saved.revision,
      anchor: edited.anchor,
    },
  };
}
