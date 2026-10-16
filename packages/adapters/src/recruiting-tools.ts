import { createHash } from "node:crypto";
import type { AdapterContext, ArtifactStore, ConnectorCall } from "@rakazo/adapter-kit";
import type { Actor, RecruitingResearchToolInput } from "@rakazo/contracts";
import {
  RecruitingResearchToolInputSchema,
  RecruitingRoleToolInputSchema,
} from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type {
  Prisma,
  PrismaClient,
  RecruitingResearchArtifactInput,
  RecruitingRoleToolResult,
} from "@rakazo/db";
import {
  admitRecruitingResearchAction,
  executeRecruitingRoleMutation,
  getRecruitingWorkspace,
  IsolationError,
  prepareRecruitingResearchAction,
  RecruitingConflictError,
  readRecruitingResearchContext,
  reconcileRecruitingResearchAction,
  recordRecruitingResearchObservation,
  recruitingResearchSnapshot,
  scoped,
} from "@rakazo/db";
import type { LoadedRecruitingRunContext } from "./recruiting-context.js";
import type { RecruitingResearchRequest } from "./recruiting-research.js";
import {
  buildRecruitingResearchRequest,
  classifyRecruitingResearchResult,
  readRecruitingResearchRequest,
} from "./recruiting-research.js";

export async function executeRecruitingRoleTool(
  prisma: PrismaClient,
  context: { actor: Actor; runId: string; sourceMessageId: string | null },
  untrusted: unknown,
): Promise<RecruitingRoleToolResult> {
  const input = RecruitingRoleToolInputSchema.parse(untrusted);
  const { actor, runId, sourceMessageId } = context;
  if (input.operation !== "read")
    return executeRecruitingRoleMutation(prisma, actor, { runId, sourceMessageId }, input);
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
type ResearchDeps = { prisma: PrismaClient; artifacts: ArtifactStore };
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
    input.operation === "prepare" ? { mcpServerId: input.mcpServerId } : { taskId: input.taskId };
  const cached = await readRecruitingResearchContext(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    ...selector,
    clientNonce: input.clientNonce,
  });
  if (cached.action && cached.task) {
    const manifest = await frozenResearchRequest(deps, cached, context);
    if (
      manifest.instructions !== input.instructions ||
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
    route,
    instructions: input.instructions,
    output: input.output,
    recallScope: input.recallScope,
    ...(input.operation === "prepare"
      ? { operation: "create" as const }
      : {
          operation: "continue" as const,
          providerTaskId: saved.task?.providerTaskId ?? "",
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
    mcpServerId: server.id,
    serverRevision: server.revision,
    ...(input.operation === "continue" ? { taskId: input.taskId } : {}),
    kind: request.manifest.operation,
    clientNonce: input.clientNonce,
    recallScope: input.recallScope,
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
  if (input.operation === "prepare" || input.operation === "continue") throw new IsolationError();
  const saved = await readRecruitingResearchContext(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    ...(input.operation === "start"
      ? { actionId: input.actionId, historical: true }
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
      recoveryEffectKind:
        saved.effect &&
        ["completed", "executing", "uncertain", "denied"].includes(saved.effect.status)
          ? saved.effect.kind
          : undefined,
    };
  }
  if (!saved.task.providerTaskId) throw new RecruitingConflictError();
  return {
    route: {
      connectorId: "mcp",
      resourceId: saved.server.id,
      resourceRevision: saved.task.serverRevision,
      toolName: input.operation === "status" ? "get_task" : "get_rows",
    },
    args:
      input.operation === "status"
        ? { task_id: saved.task.providerTaskId, wait_seconds: 0 }
        : {
            task_id: saved.task.providerTaskId,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          },
    taskId: saved.task.id,
    operation: input.operation,
  };
}

type ResearchDispatchActor = ResearchActor & { leaseOwner: string; leaseFence: number };
type ResearchMutationAdmission = Awaited<ReturnType<typeof admitRecruitingResearchAction>> & {
  kind: "mutation";
  operation: "create" | "continue";
  manifest: RecruitingResearchRequest;
};
type ResearchReadAdmission = {
  kind: "read";
  operation: "status" | "rows";
  saved: ResearchContext;
  call: ConnectorCall;
};
export type RecruitingResearchCallAdmission = ResearchMutationAdmission | ResearchReadAdmission;

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
  const run = await deps.prisma.run.findFirst({
    where: { id: trusted.runId, spaceId: trusted.actor.spaceId, userId: trusted.actor.userId },
    select: { thread: { select: { activeRecruitingRoleId: true } } },
  });
  if (!run) throw new IsolationError();
  if (!run.thread.activeRecruitingRoleId && !options.actionId && !options.taskId) return undefined;
  if (!options.actionId && !options.taskId) {
    const linked = await deps.prisma.recruitingResearchTask.findFirst({
      where: {
        mcpServerId: route.resourceId,
        role: { spaceId: trusted.actor.spaceId, userId: trusted.actor.userId },
      },
      select: { id: true },
    });
    if (!linked) {
      const server = await deps.prisma.mcpServer.findFirst({
        where: {
          id: route.resourceId,
          spaceId: trusted.actor.spaceId,
          userId: trusted.actor.userId,
        },
        select: { endpoint: true },
      });
      const endpoint = server?.endpoint ? URL.parse(server.endpoint) : null;
      if (
        endpoint?.origin !== "https://api.autumn.ai" ||
        !["/mcp", "/mcp/"].includes(endpoint.pathname)
      )
        return undefined;
    }
  }
  if (!deps.artifacts) throw new Error("Recruiting research requires artifact storage");
  const researchDeps = { prisma: deps.prisma, artifacts: deps.artifacts };
  if (route.toolName === "get_task" || route.toolName === "get_rows") {
    const task = options.taskId
      ? { id: options.taskId }
      : await deps.prisma.recruitingResearchTask.findFirst({
          where: {
            roleId: run.thread.activeRecruitingRoleId!,
            mcpServerId: route.resourceId,
            serverRevision: Number(route.resourceRevision),
            providerTaskId: String(call.args.task_id ?? ""),
          },
          select: { id: true },
        });
    if (!task) return undefined;
    const saved = await readRecruitingResearchContext(deps.prisma, trusted.actor, {
      runId: trusted.runId,
      taskId: task.id,
      toolName: route.toolName,
    });
    if (
      !saved.action ||
      !saved.task ||
      saved.task.providerTaskId !== call.args.task_id ||
      saved.task.mcpServerId !== route.resourceId ||
      saved.task.serverRevision !== route.resourceRevision
    )
      throw new IsolationError();
    return {
      kind: "read",
      operation: route.toolName === "get_task" ? "status" : "rows",
      saved,
      call,
    };
  }
  const candidates = options.actionId
    ? [{ id: options.actionId }]
    : await deps.prisma.recruitingResearchAction.findMany({
        where: {
          kind: route.toolName === "research" ? "create" : "continue",
          task: { roleId: run.thread.activeRecruitingRoleId!, mcpServerId: route.resourceId },
          OR: [
            { pendingFor: { isNot: null } },
            { effect: { request: { equals: options.frozenRequest as Prisma.InputJsonValue } } },
          ],
        },
        select: { id: true },
      });
  const matches: { saved: ResearchContext; manifest: RecruitingResearchRequest }[] = [];
  for (const candidate of candidates) {
    const saved = await readRecruitingResearchContext(deps.prisma, trusted.actor, {
      runId: trusted.runId,
      actionId: candidate.id,
      historical: true,
    });
    const manifest = await frozenResearchRequest(researchDeps, saved, context);
    if (
      manifest.route.resourceId === route.resourceId &&
      manifest.route.resourceRevision === route.resourceRevision &&
      manifest.route.toolName === route.toolName &&
      stableJsonValue(manifest.args) === stableJsonValue(call.args)
    )
      matches.push({ saved, manifest });
  }
  const pending = matches.filter(({ saved }) => saved.task?.pendingActionId === saved.action?.id);
  const selected =
    pending.length === 1 ? pending[0] : matches.length === 1 ? matches[0] : undefined;
  if (!selected?.saved.action || !selected.saved.task)
    throw new Error(
      "Use recruiting_research to prepare this exact request, then start its actionId.",
    );
  const { saved, manifest } = selected;
  const admitted = await admitRecruitingResearchAction(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    leaseOwner: trusted.leaseOwner,
    leaseFence: trusted.leaseFence,
    actionId: saved.action!.id,
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
): Promise<RecruitingResearchArtifactInput> {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
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
    clientNonce: `${prefix}:${context.runId}:${hash}`,
  };
}

export async function completeRecruitingResearchCall(
  deps: ResearchDeps,
  trusted: ResearchActor,
  admitted: RecruitingResearchCallAdmission,
  result: unknown,
  context: AdapterContext,
  receiptIdentity?: { effectId: string; request: unknown },
) {
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
  const file = await uploadResearchReceipt(
    deps,
    context,
    {
      version: 1,
      taskId: task.id,
      actionId: action.id,
      operation: admitted.operation,
      ...(admitted.kind === "read"
        ? { request: admitted.call.args }
        : {
            requestArtifact: {
              artifactId: action.requestArtifactId,
              sha256: action.requestArtifactHash,
            },
          }),
      providerResult: raw,
      observation,
    },
    `recruiting-${admitted.kind === "read" ? "observation" : "receipt"}-${action.id}`,
  );
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
          toolName: admitted.operation === "status" ? "get_task" : "get_rows",
          outputArtifact: file,
          ...observed,
          ...(observation.nextCursor === undefined ? {} : { cursor: observation.nextCursor }),
        });
  return {
    status: observation.deliveryState,
    ...recruitingResearchSnapshot(persisted.task, persisted.action),
    observation,
    providerResult: raw,
  };
}
