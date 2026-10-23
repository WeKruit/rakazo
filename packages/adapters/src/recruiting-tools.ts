import { createHash } from "node:crypto";
import type {
  AdapterContext,
  ArtifactStore,
  ConnectorCall,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { recruitingResearchPollJob } from "@rakazo/adapter-kit";
import type { Actor, RecruitingResearchToolInput } from "@rakazo/contracts";
import {
  RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
  RecruitingResearchReadArtifactSchema,
  RecruitingResearchToolInputSchema,
  RecruitingRoleToolInputSchema,
} from "@rakazo/contracts";
import { boundDirectApprovalDetails, catalogApprovalDetails, parseCsv } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type {
  Prisma,
  PrismaClient,
  RecruitingResearchArtifactInput,
  RecruitingRoleMaterialContext,
  RecruitingRoleMutationContext,
  RecruitingRoleToolResult,
} from "@rakazo/db";
import {
  admitRecruitingResearchAction,
  bindRecruitingResearchReadEffect,
  executeRecruitingRoleMutation,
  getRecruitingWorkspace,
  IsolationError,
  listUnmappedRecruitingResearchReads,
  prepareRecruitingResearchAction,
  RecruitingConflictError,
  readNativeRecruitingCandidatePage,
  readRecruitingResearchContext,
  reconcileRecruitingResearchAction,
  recordRecruitingResearchObservation,
  recruitingCsvImportReceipt,
  recruitingResearchSnapshot,
  saveNativeRecruitingCandidatePage,
  saveRecruitingCandidateCsvImport,
  scoped,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

import { readActorArtifact } from "./artifact-read.js";
import type { LoadedRecruitingRunContext } from "./recruiting-context.js";
import type { RecruitingResearchRequest } from "./recruiting-research.js";
import {
  buildRecruitingResearchRequest,
  classifyRecruitingResearchResult,
  readRecruitingResearchRequest,
} from "./recruiting-research.js";
import {
  RECRUITING_RESEARCH_BACKGROUND_NOTICE,
  RECRUITING_RESEARCH_FOREGROUND_WAIT_SECONDS,
  recruitingResearchPollDelay,
} from "./recruiting-research-poll.js";

export async function executeRecruitingRoleTool(
  prisma: PrismaClient,
  context: {
    actor: Actor;
    runId: string;
    sourceMessageId: string | null;
    mutation?: Omit<RecruitingRoleMutationContext, "runId" | "sourceMessageId">;
  },
  untrusted: unknown,
  material?: RecruitingRoleMaterialContext,
): Promise<RecruitingRoleToolResult> {
  const input = RecruitingRoleToolInputSchema.parse(untrusted);
  const { actor, runId, sourceMessageId } = context;
  if (input.operation !== "read") {
    if (!context.mutation) throw new IsolationError();
    return executeRecruitingRoleMutation(
      prisma,
      actor,
      { ...context.mutation, runId, sourceMessageId },
      input,
      material,
    );
  }
  const run = scoped(
    actor,
    await prisma.run.findFirst({
      where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
      select: {
        spaceId: true,
        userId: true,
        threadId: true,
        bot: { select: { spaceId: true, userId: true } },
      },
    }),
  );
  scoped(actor, run.bot);
  const workspace = await getRecruitingWorkspace(prisma, actor, { threadId: run.threadId });
  return { status: "current", workspace, source: null, changed: false };
}

type ResearchPreparation = Extract<
  RecruitingResearchToolInput,
  { operation: "prepare" | "continue" }
>;
type ResearchContext = Awaited<ReturnType<typeof readRecruitingResearchContext>>;
type ResearchDeps = {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  /** When present, a task still working after a call is polled in the background. */
  jobs?: Pick<JobPublisher, "enqueue">;
};
type ResearchActor = { actor: Actor; runId: string; sourceMessageId: string | null };

async function frozenResearchRequest(
  deps: ResearchDeps,
  saved: ResearchContext,
  context: AdapterContext,
) {
  const { action, task, requestArtifact } = saved;
  if (!action || !task || !requestArtifact) throw new IsolationError();
  const manifest = readRecruitingResearchRequest(
    await deps.artifacts.get(requestArtifact.storageKey, context),
    action.requestArtifactHash,
  );
  if (
    manifest.version !== 3 ||
    manifest.candidateOutputSchema !== action.candidateOutputSchema ||
    manifest.purpose !== action.purpose ||
    manifest.approvalEffectId !== action.approvalEffectId ||
    manifest.roleId !== task.roleId ||
    manifest.roleRevisionId !== action.roleRevisionId ||
    manifest.operation !== action.kind ||
    manifest.route.resourceId !== task.mcpServerId ||
    manifest.route.resourceRevision !== task.serverRevision ||
    manifest.contextArtifact.artifactId !== action.contextArtifactId ||
    manifest.contextArtifact.sha256 !== action.contextArtifactHash ||
    manifest.source.anchor.kind !== "message" ||
    manifest.source.anchor.messageId !== action.sourceMessageId ||
    (manifest.operation === "continue" && manifest.args.task_id !== task.providerTaskId)
  )
    throw new IsolationError();
  return manifest;
}

export async function prepareRecruitingResearchTool(
  deps: ResearchDeps,
  trusted: ResearchActor,
  untrusted: ResearchPreparation,
  context: AdapterContext,
  loadContext: (
    sourceMessageId: string,
    recallScope: string | null,
  ) => Promise<LoadedRecruitingRunContext | undefined>,
) {
  const input = RecruitingResearchToolInputSchema.parse(untrusted);
  if (input.operation !== "prepare" && input.operation !== "continue") throw new IsolationError();
  if (
    context.runId !== trusted.runId ||
    context.spaceId !== trusted.actor.spaceId ||
    context.userId !== trusted.actor.userId
  )
    throw new IsolationError();
  const selector =
    input.operation === "prepare"
      ? { mcpServerId: input.mcpServerId }
      : {
          ...(input.taskId ? { taskId: input.taskId } : {}),
          toolName: "reply" as const,
          purpose: input.purpose,
          approvalEffectId: input.approvalEffectId,
        };
  const cached = await readRecruitingResearchContext(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    ...selector,
    clientNonce: input.clientNonce,
  });
  if (cached.action && cached.task) {
    const manifest = await frozenResearchRequest(deps, cached, context);
    if (
      manifest.instructions !== input.instructions ||
      manifest.purpose !== input.purpose ||
      manifest.approvalEffectId !== input.approvalEffectId ||
      manifest.output !== input.output ||
      manifest.recallScope !== input.recallScope ||
      manifest.roleRevision !== input.expectedRoleRevision ||
      manifest.intent.basis !== input.intent.basis ||
      manifest.intent.quote !== input.intent.quote ||
      manifest.operation !== (input.operation === "prepare" ? "create" : "continue")
    )
      throw new RecruitingConflictError();
    return {
      status: cached.action.deliveryState,
      ...recruitingResearchSnapshot(cached.task, cached.action),
      source: manifest.source,
      request: manifest.args,
    };
  }
  const saved = await readRecruitingResearchContext(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    sourceMessageId: trusted.sourceMessageId,
    intent: input.intent,
    expectedRoleRevision: input.expectedRoleRevision,
    ...selector,
  });
  const { source, server } = saved;
  if (source?.anchor.kind !== "message" || !server) throw new IsolationError();
  if (input.intent.basis === "inferred") return { status: "needs_clarification" as const, source };
  context.signal.throwIfAborted();
  const adopted = await loadContext(source.anchor.messageId, input.recallScope);
  if (!adopted) throw new IsolationError();
  const route = {
    connectorId: "mcp" as const,
    resourceId: server.id,
    resourceRevision: server.revision,
    toolName: input.operation === "prepare" ? ("research" as const) : ("reply" as const),
  };
  const request = buildRecruitingResearchRequest({
    context: adopted,
    source,
    intent: input.intent,
    purpose: input.purpose,
    approvalEffectId: input.approvalEffectId,
    route,
    instructions: input.instructions,
    output: input.output,
    recallScope: input.recallScope,
    ...(input.operation === "prepare"
      ? { operation: "create" as const }
      : {
          operation: "continue" as const,
          providerTaskId:
            saved.task?.providerTaskId ?? saved.nativeResearchTarget?.providerTaskId ?? "",
        }),
  });
  const name = `recruiting-request-${request.sha256}.json`;
  const blob = await deps.artifacts.put(
    { name, mimeType: "application/json", bytes: request.bytes },
    context,
  );
  const result = await prepareRecruitingResearchAction(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    sourceMessageId: source.anchor.messageId,
    intent: input.intent,
    expectedRoleRevision: input.expectedRoleRevision,
    purpose: input.purpose,
    approvalEffectId: input.approvalEffectId,
    mcpServerId: server.id,
    serverRevision: server.revision,
    ...(input.operation === "continue" && input.taskId ? { taskId: input.taskId } : {}),
    ...(request.manifest.operation === "continue"
      ? { providerTaskId: request.manifest.args.task_id }
      : {}),
    kind: request.manifest.operation,
    clientNonce: input.clientNonce,
    recallScope: input.recallScope,
    candidateOutputSchema: RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
    requestArtifact: {
      name,
      mimeType: "application/json",
      size: request.bytes.byteLength,
      hash: request.sha256,
      storageKey: blob.id,
      clientNonce: `recruiting-request:${input.clientNonce}`,
    },
    contextArtifact: adopted.contextArtifact,
  });
  return {
    status: result.action.deliveryState,
    ...recruitingResearchSnapshot(result.task, result.action),
    source,
    request: request.manifest.args,
    roleContext: adopted.text,
    contextArtifact: adopted.contextArtifact,
  };
}

export async function resolveRecruitingResearchTool(
  deps: ResearchDeps,
  trusted: ResearchActor,
  untrusted: Extract<RecruitingResearchToolInput, { operation: "start" | "status" | "rows" }>,
  context: AdapterContext,
) {
  const input = RecruitingResearchToolInputSchema.parse(untrusted);
  if (input.operation !== "start" && input.operation !== "status" && input.operation !== "rows")
    throw new IsolationError();
  const saved = await readRecruitingResearchContext(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    historical: true,
    ...(input.operation === "start"
      ? { actionId: input.actionId }
      : {
          taskId: input.taskId,
          toolName: input.operation === "status" ? "get_task" : "get_rows",
        }),
  });
  if (!saved.task || !saved.server) throw new IsolationError();
  if (input.operation === "start") {
    const manifest = await frozenResearchRequest(deps, saved, context);
    return {
      route: manifest.route,
      args: manifest.args,
      actionId: input.actionId,
      taskId: saved.task.id,
      operation: manifest.operation,
      recoveredResult: undefined,
      recoveryEffectKind:
        saved.effect &&
        ["completed", "executing", "uncertain", "denied"].includes(saved.effect.status)
          ? saved.effect.kind
          : undefined,
    };
  }
  if (!saved.task.providerTaskId) throw new RecruitingConflictError();
  const call = {
    route: {
      connectorId: "mcp",
      resourceId: saved.server.id,
      resourceRevision: saved.task.serverRevision,
      toolName: input.operation === "status" ? "get_task" : "get_rows",
    },
    args:
      input.operation === "status"
        ? {
            task_id: saved.task.providerTaskId,
            wait_seconds: RECRUITING_RESEARCH_FOREGROUND_WAIT_SECONDS,
          }
        : {
            task_id: saved.task.providerTaskId,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          },
    taskId: saved.task.id,
    operation: input.operation,
  };
  const recoveredResult = await recoverRecruitingResearchReads(
    deps,
    trusted,
    saved.task.id,
    call,
    context,
  );
  if (!recoveredResult)
    await readRecruitingResearchContext(deps.prisma, trusted.actor, {
      runId: trusted.runId,
      taskId: saved.task.id,
      toolName: input.operation === "status" ? "get_task" : "get_rows",
    });
  return { ...call, recoveredResult };
}

type ResearchDispatchActor = ResearchActor & { leaseOwner: string; leaseFence: number };
type ResearchMutationAdmission = Awaited<ReturnType<typeof admitRecruitingResearchAction>> & {
  kind: "mutation";
  operation: "create" | "continue";
  manifest: Extract<RecruitingResearchRequest, { version: 3 }>;
};
type ResearchReadAdmission = {
  kind: "read";
  operation: "status" | "rows";
  saved: ResearchContext;
  call: ConnectorCall;
  recoveredResult?: object;
};
export type RecruitingResearchCallAdmission = ResearchMutationAdmission | ResearchReadAdmission;

export async function bindRecruitingResearchReadCall(
  deps: Pick<ResearchDeps, "prisma">,
  trusted: ResearchDispatchActor,
  admitted: ResearchReadAdmission,
  effect: { id: string; request: unknown },
): Promise<ResearchReadAdmission> {
  if (!admitted.saved.action) throw new IsolationError();
  const bound = await bindRecruitingResearchReadEffect(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    leaseOwner: trusted.leaseOwner,
    leaseFence: trusted.leaseFence,
    actionId: admitted.saved.action.id,
    effectId: effect.id,
    request: effect.request as Prisma.InputJsonValue,
  });
  const direct = boundDirectApprovalDetails(effect.request, "__rakazoCatalogTool");
  const catalog = catalogApprovalDetails(effect.request, "__rakazoCatalogTool");
  const route = direct?.route ?? catalog?.route;
  const args = direct?.args ?? catalog?.args.arguments;
  if (!route || !args || typeof args !== "object" || Array.isArray(args))
    throw new IsolationError();
  return {
    ...admitted,
    saved: bound.saved,
    operation: route.toolName === "get_task" ? "status" : "rows",
    call: { ...admitted.call, route, args: args as Record<string, unknown> },
  };
}

async function recoverRecruitingResearchReads(
  deps: ResearchDeps,
  trusted: ResearchActor,
  taskId: string,
  requested: Pick<ConnectorCall, "route" | "args">,
  context: AdapterContext,
) {
  const pending = await listUnmappedRecruitingResearchReads(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    taskId,
  });
  const receipts = [];
  for (const read of pending) {
    const result = await completeRecruitingResearchCall(
      deps,
      trusted,
      {
        kind: "read",
        operation: read.toolName === "get_task" ? "status" : "rows",
        saved: read.saved,
        call: {
          tool: read.effect.kind,
          executionId: read.effect.id,
          route: read.route,
          args: read.args,
        },
      },
      read.effect.result,
      context,
      {
        effectId: read.effect.id,
        request: read.effect.request,
        historicalBackfill: true,
        ...("outputArtifact" in read ? { outputArtifact: read.outputArtifact } : {}),
      },
    );
    if (
      stableJsonValue(read.route) === stableJsonValue(requested.route) &&
      stableJsonValue(read.args) === stableJsonValue(requested.args)
    )
      receipts.push(result);
  }
  return receipts.length ? { status: "recovered" as const, receipts } : undefined;
}

export async function admitRecruitingResearchCall(
  deps: { prisma: PrismaClient; artifacts?: ArtifactStore },
  trusted: ResearchDispatchActor,
  call: ConnectorCall,
  context: AdapterContext,
  options: { actionId?: string; taskId?: string; frozenRequest: unknown },
): Promise<RecruitingResearchCallAdmission | undefined> {
  const route = call.route;
  if (
    route?.connectorId !== "mcp" ||
    !route.resourceId ||
    !["research", "reply", "get_task", "get_rows"].includes(route.toolName)
  )
    return undefined;
  const read = route.toolName === "get_task" || route.toolName === "get_rows";
  // Native MCP mutations use the harness's own permissions, effects and recovery.
  // Domain admission applies only to explicitly selected recruiting actions.
  if (!read && !options.actionId && !options.taskId) return undefined;
  const run = await deps.prisma.run.findFirst({
    where: { id: trusted.runId, spaceId: trusted.actor.spaceId, userId: trusted.actor.userId },
    select: { thread: { select: { activeRecruitingRoleId: true } } },
  });
  if (!run) throw new IsolationError();
  const task = read
    ? options.taskId
      ? { id: options.taskId }
      : await deps.prisma.recruitingResearchTask.findFirst({
          where: {
            role: { spaceId: trusted.actor.spaceId, userId: trusted.actor.userId },
            mcpServerId: route.resourceId,
            serverRevision: Number(route.resourceRevision),
            providerTaskId: String(call.args.task_id ?? ""),
          },
          select: { id: true },
        })
    : null;
  if (read && !task) return undefined;
  if (!deps.artifacts) throw new Error("Recruiting research requires artifact storage");
  const researchDeps = { prisma: deps.prisma, artifacts: deps.artifacts };
  if (read && task) {
    const historical = await readRecruitingResearchContext(deps.prisma, trusted.actor, {
      runId: trusted.runId,
      taskId: task.id,
      historical: true,
    });
    if (
      !historical.action ||
      !historical.task ||
      historical.task.providerTaskId !== call.args.task_id ||
      historical.task.mcpServerId !== route.resourceId ||
      historical.task.serverRevision !== route.resourceRevision
    )
      throw new IsolationError();
    const recoveredResult = await recoverRecruitingResearchReads(
      researchDeps,
      trusted,
      task.id,
      call,
      context,
    );
    const saved = recoveredResult
      ? historical
      : await readRecruitingResearchContext(deps.prisma, trusted.actor, {
          runId: trusted.runId,
          taskId: task.id,
          toolName: route.toolName as "get_task" | "get_rows",
        });
    return {
      kind: "read",
      operation: route.toolName === "get_task" ? "status" : "rows",
      saved,
      call,
      recoveredResult,
    };
  }
  if (!options.actionId) throw new IsolationError();
  const saved = await readRecruitingResearchContext(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    actionId: options.actionId,
    historical: true,
  });
  const manifest = await frozenResearchRequest(researchDeps, saved, context);
  if (
    manifest.route.resourceId !== route.resourceId ||
    manifest.route.resourceRevision !== route.resourceRevision ||
    manifest.route.toolName !== route.toolName ||
    stableJsonValue(manifest.args) !== stableJsonValue(call.args)
  )
    throw new IsolationError();
  const admitted = await admitRecruitingResearchAction(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    leaseOwner: trusted.leaseOwner,
    leaseFence: trusted.leaseFence,
    actionId: saved.action!.id,
    purpose: manifest.purpose,
    approvalEffectId: manifest.approvalEffectId,
    requestArtifact: {
      artifactId: saved.action!.requestArtifactId,
      sha256: saved.action!.requestArtifactHash,
    },
    contextArtifact: manifest.contextArtifact,
    frozenRequest: options.frozenRequest as Prisma.InputJsonValue,
    effectKind: saved.effect?.kind ?? call.tool,
  });
  return { ...admitted, kind: "mutation", operation: manifest.operation, manifest };
}

async function uploadResearchReceipt(
  deps: ResearchDeps,
  context: AdapterContext,
  value: unknown,
  prefix: string,
  readEffectId?: string,
): Promise<RecruitingResearchArtifactInput> {
  const bytes = Buffer.from(readEffectId ? stableJsonValue(value) : JSON.stringify(value), "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const name = `${prefix}-${hash}.json`;
  const stored = await deps.artifacts.put({ name, mimeType: "application/json", bytes }, context);
  // ponytail: retain duplicate uploads; the existing ArtifactStore can share content-addressed blobs.
  // Remove them only through an exclusive-put or native garbage-collection contract.
  return {
    name,
    mimeType: "application/json",
    size: bytes.byteLength,
    hash,
    storageKey: stored.id,
    clientNonce: readEffectId
      ? `recruiting-observation:${readEffectId}`
      : `${prefix}:${context.runId}:${hash}`,
  };
}

export class RecruitingCandidateOutputError extends Error {}

/** Optional local projection after native MCP; it does not prepare or dispatch research. */
export async function saveNativeRecruitingCandidateResults(
  deps: ResearchDeps,
  trusted: ResearchActor & {
    leaseOwner: string;
    leaseFence: number;
    effectId: string;
    effectRequest: unknown;
  },
  input: Extract<RecruitingResearchToolInput, { operation: "save_results" }>,
  context: AdapterContext,
) {
  const started = performance.now();
  const wallMs = { readTX: 0, serializeArtifactPut: 0, atomicWriteTX: 0 };
  let phase: keyof typeof wallMs | "validation" = "validation";
  let phaseStarted = started;
  let succeeded = false;
  let rowCount: number | null = null;
  let bytes: number | null = null;
  try {
    if (
      context.runId !== trusted.runId ||
      context.spaceId !== trusted.actor.spaceId ||
      context.userId !== trusted.actor.userId
    )
      throw new IsolationError();
    phase = "readTX";
    phaseStarted = performance.now();
    const source = await readNativeRecruitingCandidatePage(
      deps.prisma,
      trusted.actor,
      trusted.runId,
      input,
    );
    wallMs.readTX = performance.now() - phaseStarted;
    phase = "validation";
    const observation = classifyRecruitingResearchResult(source.effect.result, {
      operation: "rows",
      providerTaskId: input.providerTaskId,
    });
    rowCount = observation.rows?.length ?? null;
    if (
      observation.rows === undefined ||
      (observation.rows.length > 0 &&
        !observation.rows.some(
          (row) =>
            row !== null &&
            typeof row === "object" &&
            !Array.isArray(row) &&
            Object.hasOwn(row, "name") &&
            Object.hasOwn(row, "linkedin_url"),
        ))
    )
      throw new RecruitingCandidateOutputError(
        "Candidate results need name and linkedin_url columns. Company/JD evidence and unstructured results are not candidate pages. Preserve missing values as null; reread an existing candidate page rather than starting new research.",
      );
    phase = "serializeArtifactPut";
    phaseStarted = performance.now();
    const outputArtifact = await uploadResearchReceipt(
      deps,
      context,
      source.snapshot,
      "recruiting-candidates",
      source.effect.id,
    );
    wallMs.serializeArtifactPut = performance.now() - phaseStarted;
    bytes = outputArtifact.size;
    phase = "atomicWriteTX";
    phaseStarted = performance.now();
    const result = await saveNativeRecruitingCandidatePage(
      deps.prisma,
      trusted.actor,
      trusted,
      input,
      {
        sourceEffectId: source.effect.id,
        rows: observation.rows,
        outputId: observation.outputId,
        outputArtifact,
      },
    );
    succeeded = true;
    return result;
  } finally {
    const finished = performance.now();
    if (phase !== "validation") wallMs[phase] = finished - phaseStarted;
    getLogger().info("recruiting.candidates.save.timing", {
      outcome: succeeded ? "succeeded" : "error",
      failedPhase: succeeded ? null : phase,
      durationMs: Math.round(finished - started),
      readTXWallMs: Math.round(wallMs.readTX),
      serializeArtifactPutWallMs: Math.round(wallMs.serializeArtifactPut),
      atomicWriteTXWallMs: Math.round(wallMs.atomicWriteTX),
      rowCount,
      bytes,
    });
  }
}

export class RecruitingCsvImportError extends Error {}

const CSV_IMPORT_FIELDS = {
  name: "name",
  linkedinUrl: "linkedin_url",
  company: "current_company",
  title: "current_title",
  location: "location",
  resumeUrl: "resume_url",
} as const;

/** Save a recruiter-supplied text/csv artifact as one unassessed candidate page on the role. */
export async function importRecruitingCandidateCsv(
  deps: ResearchDeps,
  trusted: ResearchActor & {
    leaseOwner: string;
    leaseFence: number;
    effectId: string;
    effectRequest: unknown;
  },
  input: Extract<RecruitingResearchToolInput, { operation: "import_csv" }>,
  context: AdapterContext,
) {
  if (
    context.runId !== trusted.runId ||
    context.spaceId !== trusted.actor.spaceId ||
    context.userId !== trusted.actor.userId
  )
    throw new IsolationError();
  // Same owner/internal-family isolation and hash verification as artifact_read.
  let saved: Awaited<ReturnType<typeof readActorArtifact>>;
  try {
    saved = await readActorArtifact(deps, trusted.actor, {
      artifactId: input.artifactId,
      fromTool: true,
    });
  } catch (error) {
    if (error instanceof IsolationError) throw error;
    throw new RecruitingCsvImportError("Saved artifact could not be read or verified.");
  }
  if (saved.row.mimeType.split(";", 1)[0]?.trim().toLowerCase() !== "text/csv")
    throw new RecruitingCsvImportError("import_csv requires a text/csv artifact.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(saved.bytes);
  } catch {
    throw new RecruitingCsvImportError("This artifact is not valid UTF-8 text.");
  }
  const csv = parseCsv(text);
  const columns: Array<[string, number]> = [];
  for (const [field, column] of Object.entries(input.mapping)) {
    if (column === undefined) continue;
    const index = csv.header.indexOf(column);
    if (index < 0)
      throw new RecruitingCsvImportError(
        `Column "${column}" is not in the CSV header: ${JSON.stringify(csv.header)}.`,
      );
    columns.push([CSV_IMPORT_FIELDS[field as keyof typeof CSV_IMPORT_FIELDS], index]);
  }
  const rows: Array<{ rowIndex: number; csvRowIndex: number; row: Record<string, string> }> = [];
  const skipped: Array<{ csvRowIndex: number; reason: string }> = [];
  for (const [csvRowIndex, cells] of csv.rows.entries()) {
    const row: Record<string, string> = {};
    for (const [key, index] of columns) {
      const value = cells[index]?.trim();
      if (value) row[key] = value;
    }
    if (!row.name && !row.linkedin_url)
      skipped.push({ csvRowIndex, reason: "missing_name_and_linkedin_url" });
    else rows.push({ rowIndex: rows.length, csvRowIndex, row });
  }
  const captured = {
    artifactSha256: saved.row.hash,
    header: csv.header,
    rows,
    skipped,
    truncated: csv.truncated,
  };
  const bytes = Buffer.from(stableJsonValue(recruitingCsvImportReceipt(input, captured)), "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const name = `recruiting-csv-import-${hash}.json`;
  const stored = await deps.artifacts.put({ name, mimeType: "application/json", bytes }, context);
  return saveRecruitingCandidateCsvImport(deps.prisma, trusted.actor, trusted, input, {
    ...captured,
    outputArtifact: {
      name,
      mimeType: "application/json",
      size: bytes.byteLength,
      hash,
      storageKey: stored.id,
      clientNonce: `recruiting-csv-import:${trusted.effectId}`,
    },
  });
}

export async function completeRecruitingResearchCall(
  deps: ResearchDeps,
  trusted: ResearchActor,
  admitted: RecruitingResearchCallAdmission,
  result: unknown,
  context: AdapterContext,
  receiptIdentity?: {
    effectId: string;
    request: unknown;
    historicalBackfill?: boolean;
    outputArtifact?: RecruitingResearchArtifactInput;
  },
) {
  if (
    context.runId !== trusted.runId ||
    context.spaceId !== trusted.actor.spaceId ||
    context.userId !== trusted.actor.userId
  )
    throw new IsolationError();
  const saved = admitted.kind === "read" ? admitted.saved : admitted;
  if (!saved.task || !saved.action) throw new IsolationError();
  const { task, action } = saved;
  if (admitted.kind === "read" && !receiptIdentity) throw new IsolationError();
  const envelope =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as {
          providerResult?: unknown;
          recruitingReceipt?: { version?: number; actionId?: string };
        })
      : undefined;
  const recorded = Boolean(
    action.receiptArtifactId &&
      envelope?.recruitingReceipt?.version === 1 &&
      envelope.recruitingReceipt.actionId === action.id &&
      Object.hasOwn(envelope, "providerResult"),
  );
  const raw = admitted.kind === "mutation" && recorded ? envelope!.providerResult : result;
  const observation = classifyRecruitingResearchResult(raw, {
    operation: admitted.operation,
    ...(task.providerTaskId ? { providerTaskId: task.providerTaskId } : {}),
  });
  if (admitted.kind === "mutation" && recorded)
    return {
      status: action.deliveryState,
      ...recruitingResearchSnapshot(task, action),
      observation,
      providerResult: raw,
    };
  const snapshot = {
    version: 1,
    taskId: task.id,
    actionId: action.id,
    operation: admitted.operation,
    ...(admitted.kind === "read"
      ? { effectId: receiptIdentity!.effectId, request: admitted.call.args }
      : {
          requestArtifact: {
            artifactId: action.requestArtifactId,
            sha256: action.requestArtifactHash,
          },
        }),
    providerResult: raw,
    observation,
  };
  const file =
    receiptIdentity?.outputArtifact ??
    (await uploadResearchReceipt(
      deps,
      context,
      admitted.kind === "read" ? RecruitingResearchReadArtifactSchema.parse(snapshot) : snapshot,
      `recruiting-${admitted.kind === "read" ? "observation" : "receipt"}-${action.id}`,
      admitted.kind === "read" ? receiptIdentity!.effectId : undefined,
    ));
  const taskState =
    observation.observedProviderState === "completed" && observation.done === true
      ? ("completed" as const)
      : observation.deliveryState === "accepted" &&
          (admitted.kind === "mutation" || observation.done === false)
        ? ("active" as const)
        : undefined;
  const observed = {
    ...(observation.observedProviderState === null
      ? {}
      : { observedProviderState: observation.observedProviderState }),
    ...(observation.usage === null || (admitted.kind === "read" && !action.receiptArtifactId)
      ? {}
      : { usage: observation.usage }),
    ...(taskState ? { taskState } : {}),
  };
  const persisted =
    admitted.kind === "mutation"
      ? await reconcileRecruitingResearchAction(deps.prisma, trusted.actor, {
          runId: trusted.runId,
          actionId: action.id,
          effectId: admitted.effect!.id,
          rawResult: raw as Prisma.InputJsonValue,
          receiptArtifact: file,
          deliveryState: observation.deliveryState,
          ...(observation.providerTaskId ? { providerTaskId: observation.providerTaskId } : {}),
          ...observed,
          providerApplicationConfirmed: observation.providerApplicationConfirmed,
          ...(observation.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: observation.retryAfterSeconds }),
          ...(observation.refusalCode === undefined
            ? {}
            : { refusalCode: observation.refusalCode }),
        })
      : await recordRecruitingResearchObservation(deps.prisma, trusted.actor, {
          runId: trusted.runId,
          actionId: action.id,
          effectId: receiptIdentity!.effectId,
          request: receiptIdentity!.request as Prisma.InputJsonValue,
          rawResult: raw as Prisma.InputJsonValue,
          ...(receiptIdentity!.historicalBackfill ? { historicalBackfill: true } : {}),
          toolName: admitted.operation === "status" ? "get_task" : "get_rows",
          outputArtifact: file,
          ...(observation.rows === undefined ? {} : { rows: observation.rows }),
          ...(observation.outputId === undefined ? {} : { outputId: observation.outputId }),
          ...observed,
          ...(observation.nextCursor === undefined ? {} : { cursor: observation.nextCursor }),
        });
  // The provider is still working after the foreground wait: hand off to the poll job, which
  // wakes this thread once, and tell the model not to spin on status.
  const background =
    taskState === "active" &&
    admitted.operation !== "rows" &&
    deps.jobs &&
    !receiptIdentity?.historicalBackfill;
  if (background)
    await deps.jobs!.enqueue(
      recruitingResearchPollJob({ taskId: task.id }, recruitingResearchPollDelay(0)),
    );
  return {
    status: observation.deliveryState,
    ...recruitingResearchSnapshot(persisted.task, persisted.action),
    ...(admitted.kind === "read" && "candidateRows" in persisted
      ? { candidateRows: persisted.candidateRows }
      : {}),
    observation,
    providerResult: raw,
    ...(background ? { background: RECRUITING_RESEARCH_BACKGROUND_NOTICE } : {}),
  };
}
