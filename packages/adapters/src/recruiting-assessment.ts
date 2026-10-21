import { createHash } from "node:crypto";
import type { AdapterContext, ArtifactStore, WebFetchResult } from "@rakazo/adapter-kit";
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
  IsolationError,
  listRecruitingCandidateSources,
  listRecruitingCandidates,
  recordRecruitingWebMaterial,
  saveRecruitingAssessment,
  scoped,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { inputPausedToolResult } from "./approval-effect.js";

type RecruitingRunContext = { actor: Actor; runId: string; threadId: string; botId: string };
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

export async function executeRecruitingCandidatesTool(
  deps: { prisma: PrismaClient },
  trusted: RecruitingRunContext,
  untrusted: unknown,
  context: AdapterContext,
) {
  const input = RecruitingCandidatesToolInputSchema.parse(untrusted);
  const started = performance.now();
  let succeeded = false;
  try {
    await requireRecruitingRun(deps.prisma, trusted, context);
    const workspace = await getRecruitingWorkspace(deps.prisma, trusted.actor, {
      threadId: trusted.threadId,
    });
    if (!workspace) {
      succeeded = true;
      return { status: "no_current_role" as const };
    }
    if (input.operation === "list") {
      const { operation: _operation, ...query } = input;
      const result = await listRecruitingCandidates(deps.prisma, trusted.actor, {
        roleId: workspace.role.id,
        ...query,
      });
      succeeded = true;
      return result;
    }
    const { operation: _operation, ...query } = input;
    const result = await listRecruitingCandidateSources(deps.prisma, trusted.actor, {
      roleId: workspace.role.id,
      ...query,
    });
    succeeded = true;
    return result;
  } finally {
    getLogger().info("recruiting.candidates.read.timing", {
      operation: input.operation,
      limit: input.limit ?? null,
      hasCursor: input.cursor !== undefined,
      durationMs: Math.round(performance.now() - started),
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
