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
import { applyRecruitingPreferenceEdit, RECRUITING_SCALE_START } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  approveRecruitingCalibrationRoundFromMessage,
  executeNativeRecruitingCandidateDecision,
  readRecruitingFeedbackContext,
} from "@rakazo/db";

export class RecruitingFeedbackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecruitingFeedbackValidationError";
  }
}

export type RecruitingFeedbackResult = {
  feedback: RecruitingFeedbackInput;
  source: RecruitingSourceRef;
  workspace: { role: RecruitingRole; revision: RecruitingRoleRevision } | null;
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

export async function executeRecruitingFeedback(
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
  const feedback = RecruitingFeedbackInputSchema.parse(untrusted);
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
      next: RECRUITING_SCALE_START,
    };
  }
  if (feedback.target === "round" || feedback.target === "candidate")
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
  if (expected && expected.content !== edited.content)
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
