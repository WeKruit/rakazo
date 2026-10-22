import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type {
  Actor,
  RecruitingCandidateSource,
  RecruitingHumanIntent,
  RecruitingResearchObservation,
  RecruitingResearchPurpose,
  RecruitingSourceRef,
} from "@rakazo/contracts";
import {
  RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
  RecruitingArtifactRefSchema,
  RecruitingCandidateOutputSchemaId,
  RecruitingHumanIntentSchema,
  RecruitingId,
  RecruitingResearchPurposeSchema,
  RecruitingSourceRefSchema,
} from "@rakazo/contracts";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  projectRecruitingCandidateReport,
  RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS,
  readRecruitingResearchReadArtifact,
  requireRecruitingBriefConfirmation,
} from "@rakazo/core";
import { mcpObject } from "@rakazo/core/node/approval-effect-key";
import type { McpServer, PrismaClient } from "@rakazo/db";
import { IsolationError, listRecruitingResearch } from "@rakazo/db";
import { readActorArtifact } from "./artifact-read.js";

export { isRecruitingCandidateReportField, projectRecruitingCandidateReport } from "@rakazo/core";
export { mcpObject } from "@rakazo/core/node/approval-effect-key";

import { z } from "zod";
import type { LoadedRecruitingRunContext } from "./recruiting-context.js";

async function nativeMcpCreationReceipts(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
  server: Pick<McpServer, "id" | "revision">,
  toolName: string,
) {
  // ponytail: inspect only native creation receipts, never full saved candidate outputs.
  const effects = await prisma.externalEffect.findMany({
    where: {
      spaceId: actor.spaceId,
      status: "completed",
      run: { spaceId: actor.spaceId, userId: actor.userId },
      OR: [["2", "route"], ["3"]].map((path) => ({
        AND: [
          { request: { path: [...path, "connectorId"], equals: "mcp" } },
          { request: { path: [...path, "resourceId"], equals: server.id } },
          { request: { path: [...path, "resourceRevision"], equals: server.revision } },
          { request: { path: [...path, "toolName"], equals: toolName } },
        ],
      })),
    },
    select: { request: true, result: true },
  });
  const receipts: Array<{ args: Record<string, unknown>; result: unknown }> = [];
  for (const effect of effects) {
    const direct = boundDirectApprovalDetails(effect.request, "__rakazoCatalogTool");
    const catalog = catalogApprovalDetails(effect.request, "__rakazoCatalogTool");
    const route = direct?.route ?? catalog?.route;
    const requestArgs = direct?.args ?? record(catalog?.args.arguments);
    if (
      route?.connectorId !== "mcp" ||
      route.resourceId !== server.id ||
      route.resourceRevision !== server.revision ||
      route.toolName !== toolName ||
      !requestArgs ||
      (!direct &&
        (!catalog ||
          !["connectors_execute_tool", "mcp_execute_tool"].includes(catalog.toolName) ||
          catalog.args.id !== `${server.id}:${toolName}`))
    )
      continue;
    receipts.push({
      args: requestArgs,
      result: record(effect.result)?.providerResult ?? effect.result,
    });
  }
  return receipts;
}

/** A shared provider account never grants access to another product user's research. */
export async function requireAutumnTaskOwnership(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
  server: Pick<McpServer, "id" | "revision" | "transport" | "endpoint">,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (server.transport !== "streamable_http" || server.endpoint !== "https://api.autumn.ai/mcp")
    return;
  if (["research", "credits"].includes(toolName) && args.task_id === undefined) return;
  if (
    !["get_task", "get_rows", "reply", "stop_task", "continue_with_file"].includes(toolName) ||
    typeof args.task_id !== "string" ||
    !args.task_id.trim()
  )
    throw new IsolationError(
      "Use scoped research history or start new research in this conversation; account-wide Autumn access is unavailable.",
    );
  const task = await prisma.recruitingResearchTask.findFirst({
    where: {
      providerTaskId: args.task_id,
      mcpServerId: server.id,
      serverRevision: server.revision,
      role: { spaceId: actor.spaceId, userId: actor.userId },
      createdByRun: { spaceId: actor.spaceId, userId: actor.userId },
    },
    select: { id: true },
  });
  if (task) return;
  for (const receipt of await nativeMcpCreationReceipts(prisma, actor, server, "research")) {
    if (!nonblank(receipt.args.prompt) || receipt.args.task_id !== undefined) continue;
    const observation = classifyRecruitingResearchResult(receipt.result, { operation: "create" });
    if (observation.deliveryState === "accepted" && observation.providerTaskId === args.task_id)
      return;
  }
  throw new IsolationError(
    "This research is not available in your workspace. Use scoped research history or start new research in this conversation.",
  );
}

/** Shared contact-enrichment funding does not share another person's job history. */
export async function requireFullEnrichJobOwnership(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
  server: Pick<McpServer, "id" | "revision" | "transport" | "endpoint">,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (
    server.transport !== "streamable_http" ||
    server.endpoint !== "https://mcp.fullenrich.com/mcp"
  )
    return;
  if (toolName === "get_credits" && Object.keys(args).length === 0) return;
  if (toolName === "enrich_bulk" && args.enrichment_id === undefined) return;
  if (toolName === "get_enrichment_results" && nonblank(args.enrichment_id)) {
    for (const receipt of await nativeMcpCreationReceipts(prisma, actor, server, "enrich_bulk")) {
      if (
        !Array.isArray(receipt.args.contacts) ||
        !receipt.args.contacts.length ||
        receipt.args.enrichment_id !== undefined ||
        record(receipt.result)?.isError === true
      )
        continue;
      const body = mcpObject(receipt.result);
      if (body?.enrichment_id === args.enrichment_id && body.error === undefined) return;
    }
  }
  throw new IsolationError(
    "This contact lookup is not available in your workspace. Start a new lookup in this conversation.",
  );
}

const Text = z.string().refine((text) => text.trim().length > 0, "Text must not be blank");
const Route = z.strictObject({
  connectorId: z.literal("mcp"),
  resourceId: RecruitingId,
  resourceRevision: z.number().int().positive(),
  toolName: z.enum(["research", "reply"]),
  catalogGroup: Text.optional(),
});
const Request = {
  roleId: RecruitingId,
  roleRevisionId: RecruitingId,
  roleRevision: z.number().int().positive(),
  contextArtifact: RecruitingArtifactRefSchema,
  contextText: Text,
  source: RecruitingSourceRefSchema,
  intent: RecruitingHumanIntentSchema,
  instructions: Text,
  output: Text,
  recallScope: Text.nullable(),
  route: Route,
};
const BoundRequest = {
  ...Request,
  version: z.literal(2),
  purpose: RecruitingResearchPurposeSchema,
  approvalEffectId: RecruitingId,
};
export const RecruitingResearchRequestSchema = z
  .union([
    z.strictObject({
      ...Request,
      version: z.literal(1),
      operation: z.literal("create"),
      args: z.strictObject({ prompt: Text }),
    }),
    z.strictObject({
      ...Request,
      version: z.literal(1),
      operation: z.literal("continue"),
      args: z.strictObject({ task_id: RecruitingId, message: Text }),
    }),
    z.strictObject({
      ...BoundRequest,
      operation: z.literal("create"),
      args: z.strictObject({ prompt: Text }),
    }),
    z.strictObject({
      ...BoundRequest,
      operation: z.literal("continue"),
      args: z.strictObject({ task_id: RecruitingId, message: Text }),
    }),
    z.strictObject({
      ...BoundRequest,
      version: z.literal(3),
      candidateOutputSchema: RecruitingCandidateOutputSchemaId,
      operation: z.literal("create"),
      args: z.strictObject({ prompt: Text }),
    }),
    z.strictObject({
      ...BoundRequest,
      version: z.literal(3),
      candidateOutputSchema: RecruitingCandidateOutputSchemaId,
      operation: z.literal("continue"),
      args: z.strictObject({ task_id: RecruitingId, message: Text }),
    }),
  ])
  .superRefine((request, ctx) => {
    if (
      request.route.toolName !== (request.operation === "create" ? "research" : "reply") ||
      request.intent.basis !== "direct" ||
      request.source.kind !== "original_material" ||
      request.source.anchor.kind !== "message" ||
      request.source.readState !== "read" ||
      request.source.quote !== request.intent.quote ||
      (request.operation === "create" ? request.args.prompt : request.args.message) !==
        researchText(request)
    )
      ctx.addIssue({
        code: "custom",
        message: "Frozen recruiting request identity or text does not match",
      });
  });
export type RecruitingResearchRequest = z.infer<typeof RecruitingResearchRequestSchema>;
export type RecruitingResearchRoute = z.infer<typeof Route>;

type BuildRequest = {
  context: LoadedRecruitingRunContext;
  source: RecruitingSourceRef;
  intent: RecruitingHumanIntent;
  purpose: RecruitingResearchPurpose;
  approvalEffectId: string;
  route: RecruitingResearchRoute;
  instructions: string;
  output: string;
  recallScope: string | null;
} & (
  | { operation: "create"; providerTaskId?: never }
  | { operation: "continue"; providerTaskId: string }
);

export function buildRecruitingResearchRequest(input: BuildRequest): {
  manifest: RecruitingResearchRequest;
  bytes: Buffer;
  sha256: string;
} {
  const { context } = input;
  const { role, revision } = context.workspace;
  requireRecruitingBriefConfirmation(revision);
  if (
    role.currentRevisionId !== revision.id ||
    role.id !== revision.roleId ||
    role.revision !== revision.revision ||
    context.manifest.roleId !== role.id ||
    context.manifest.roleRevisionId !== revision.id ||
    context.manifest.roleRevision !== revision.revision ||
    context.text !== context.manifest.text ||
    !nonblank(context.manifest.roleText) ||
    !context.text.startsWith(context.manifest.roleText)
  )
    throw new Error("Recruiting context does not match the current role version");
  const text = researchText({
    contextText: context.text,
    instructions: input.instructions,
    output: input.output,
    recallScope: input.recallScope,
    purpose: input.purpose,
    candidateOutputSchema: RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
  });
  const manifest = RecruitingResearchRequestSchema.parse({
    version: 3,
    candidateOutputSchema: RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
    purpose: input.purpose,
    approvalEffectId: input.approvalEffectId,
    operation: input.operation,
    roleId: role.id,
    roleRevisionId: revision.id,
    roleRevision: revision.revision,
    contextArtifact: context.contextArtifact,
    contextText: context.text,
    source: input.source,
    intent: input.intent,
    instructions: input.instructions,
    output: input.output,
    recallScope: input.recallScope,
    route: input.route,
    args:
      input.operation === "create"
        ? { prompt: text }
        : { task_id: input.providerTaskId, message: text },
  });
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  return { manifest, bytes, sha256: hash(bytes) };
}

export function readRecruitingResearchRequest(
  bytes: Uint8Array,
  expectedSha256: string,
): RecruitingResearchRequest {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || hash(bytes) !== expectedSha256)
    throw new Error("Recruiting request artifact hash does not match its frozen bytes");
  return RecruitingResearchRequestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

function researchText(input: {
  contextText: string;
  instructions: string;
  output: string;
  recallScope: string | null;
  purpose?: RecruitingResearchPurpose;
  candidateOutputSchema?: string;
}): string {
  return [
    input.contextText,
    ...(input.purpose === undefined ? [] : [`Research purpose:\n${input.purpose}`]),
    `Research instructions:\n${input.instructions}`,
    `Requested output:\n${input.output}`,
    ...(input.recallScope === null ? [] : [`Recall scope for this round:\n${input.recallScope}`]),
    "The role criteria remain authoritative. Recall scope and output instructions do not change qualification. Preserve missing evidence as unknown; provider labels do not establish qualification.",
    ...(input.candidateOutputSchema === undefined
      ? []
      : [RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS]),
  ].join("\n\n");
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type { RecruitingResearchObservation } from "@rakazo/contracts";

const lifecycle = new Map([
  ["submitted", false],
  ["working", false],
  ["input-required", true],
  ["completed", true],
  ["canceled", true],
  ["failed", true],
]);
// These codes explicitly refuse admission in the public Task API ErrorResponse contract.
// Server/transport failures need task_created:false before they prove non-delivery.
const refusalCodes = new Set([
  "invalid_request",
  "unauthorized",
  "auth_unavailable",
  "out_of_credits",
  "task_not_found",
  "task_executing",
  "task_in_cron_mode",
  "task_exists",
]);
const serverErrorCodes = new Set([
  "service_unavailable",
  "at_capacity",
  "internal_error",
  "bad_gateway",
]);

export function classifyRecruitingResearchResult(
  raw: unknown,
  options: { operation: "create" | "continue" | "status" | "rows"; providerTaskId?: string },
): RecruitingResearchObservation {
  const observation: RecruitingResearchObservation = {
    deliveryState: "unknown",
    providerTaskId:
      options.operation !== "create" && nonblank(options.providerTaskId)
        ? options.providerTaskId
        : null,
    observedProviderState: null,
    done: null,
    providerApplicationConfirmed: false,
    automaticRetry: false,
    usage: null,
  };
  const body = mcpObject(raw);
  if (!body) return observation;
  if (body.task_id != null && !nonblank(body.task_id)) return observation;
  const taskId = nonblank(body.task_id) ? body.task_id : null;
  if (options.providerTaskId && taskId && options.providerTaskId !== taskId) return observation;
  if (typeof body.error === "string") {
    observation.refusalCode = body.error;
    if (
      typeof body.retry_after === "number" &&
      Number.isFinite(body.retry_after) &&
      body.retry_after >= 0
    )
      observation.retryAfterSeconds = body.retry_after;
    if (
      body.task_created !== true &&
      (refusalCodes.has(body.error) ||
        (options.operation === "create" &&
          !taskId &&
          body.task_created === false &&
          serverErrorCodes.has(body.error)))
    )
      observation.deliveryState = "rejected";
    return observation;
  }
  if (record(raw)?.isError === true || (body.error != null && body.state !== "failed"))
    return observation;
  if (options.operation === "create" && body.task_created === false) return observation;
  if (options.operation !== "create" && !nonblank(options.providerTaskId)) return observation;
  const state = nonblank(body.state) ? body.state : null;
  const queued = body.status === "accepted" || body.activity === "queued";
  if (queued && body.done === true) return observation;
  if (
    state &&
    lifecycle.has(state) &&
    typeof body.done === "boolean" &&
    body.done !== lifecycle.get(state)
  )
    return observation;
  observation.observedProviderState = state ?? (queued ? "queued" : null);
  observation.done = typeof body.done === "boolean" ? body.done : queued ? false : null;
  if (options.operation === "create") {
    if (!taskId) return observation;
  } else if (options.operation === "continue") {
    if (!taskId && !queued) return observation;
  } else if (options.operation === "status") {
    if (!state || !lifecycle.has(state) || typeof body.done !== "boolean") return observation;
  } else {
    if (!Array.isArray(body.rows)) return observation;
    if (
      body.next_cursor !== undefined &&
      body.next_cursor !== null &&
      typeof body.next_cursor !== "string"
    )
      return observation;
    const outputId = body.output_id ?? record(body.output)?.id;
    if (outputId != null && !nonblank(outputId)) return observation;
    if (
      body.output_id != null &&
      record(body.output)?.id != null &&
      body.output_id !== record(body.output)?.id
    )
      return observation;
    observation.rows = body.rows;
    if (body.next_cursor !== undefined) observation.nextCursor = body.next_cursor as string | null;
    if (outputId !== undefined) observation.outputId = outputId as string | null;
  }
  observation.deliveryState = "accepted";
  if (options.operation === "create") observation.providerTaskId = taskId;
  if (
    typeof body.credits_used === "number" &&
    Number.isFinite(body.credits_used) &&
    body.credits_used >= 0
  )
    observation.usage = [{ scope: "task", unit: "credits", amount: body.credits_used }];
  return observation;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Both source views project the same actor-verified occurrence; no provider reads or writes. */
export function createRecruitingCandidateReportReader(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  actor: Actor,
  roleId: string,
  options: {
    artifacts?: Map<string, Awaited<ReturnType<typeof readActorArtifact>>>;
    fromTool?: true;
  } = {},
) {
  const artifacts =
    options.artifacts ?? new Map<string, Awaited<ReturnType<typeof readActorArtifact>>>();
  let research: ReturnType<typeof listRecruitingResearch> | undefined;
  // ponytail: share verified page decoding only within this actor/role read, never across requests.
  const pages = new Map<
    string,
    { observation: RecruitingResearchObservation; requestCursor: unknown }
  >();
  return async (source: Omit<RecruitingCandidateSource, "crmImports">) => {
    try {
      const { artifactId, sha256 } = source.artifactRef;
      let saved = artifacts.get(artifactId);
      if (!saved) {
        saved = await readActorArtifact(deps, actor, { artifactId, fromTool: options.fromTool });
        artifacts.set(artifactId, saved);
      }
      if (saved.row.hash !== sha256) throw new IsolationError();
      const pageKey = JSON.stringify([
        artifactId,
        sha256,
        source.taskId,
        source.actionId,
        source.roleRevisionId,
        source.effectId,
        source.requestCursor,
        source.outputId,
      ]);
      let page = pages.get(pageKey);
      if (!page) {
        let observation: RecruitingResearchObservation;
        let requestCursor: unknown;
        if (source.taskId === null && source.actionId === null) {
          const snapshot = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(saved.bytes),
          );
          const direct = boundDirectApprovalDetails(snapshot?.request, "__rakazoCatalogTool");
          const catalog = catalogApprovalDetails(snapshot?.request, "__rakazoCatalogTool");
          const route = direct?.route ?? catalog?.route;
          const args = direct?.args ?? catalog?.args.arguments;
          if (
            route?.connectorId !== "mcp" ||
            route.toolName !== "get_rows" ||
            !args ||
            typeof args !== "object" ||
            Array.isArray(args) ||
            !("task_id" in args) ||
            typeof args.task_id !== "string" ||
            !args.task_id.trim() ||
            (catalog && !["connectors_execute_tool", "mcp_execute_tool"].includes(catalog.toolName))
          )
            throw new IsolationError();
          observation = classifyRecruitingResearchResult(snapshot.providerResult, {
            operation: "rows",
            providerTaskId: args.task_id,
          });
          requestCursor = "cursor" in args ? args.cursor : null;
        } else {
          research ??= listRecruitingResearch(deps.prisma, actor, { roleId });
          const context = await research;
          const task = context.tasks.find((task) => task.id === source.taskId);
          const action = context.actions.find((action) => action.id === source.actionId);
          if (
            !task ||
            !action ||
            task.roleId !== roleId ||
            action.roleRevisionId !== source.roleRevisionId
          )
            throw new IsolationError();
          const snapshot = await readRecruitingResearchReadArtifact(saved.bytes, {
            task,
            action,
            artifact: source.artifactRef,
          });
          if (snapshot.operation !== "rows" || snapshot.effectId !== source.effectId)
            throw new IsolationError();
          observation = classifyRecruitingResearchResult(snapshot.providerResult, {
            operation: "rows",
            providerTaskId: task.providerTaskId ?? undefined,
          });
          if (!isDeepStrictEqual(snapshot.observation, observation)) throw new IsolationError();
          requestCursor = snapshot.request.cursor ?? null;
        }
        page = { observation, requestCursor };
        pages.set(pageKey, page);
      }
      const { observation, requestCursor } = page;
      if (
        requestCursor !== source.requestCursor ||
        (observation.outputId ?? null) !== source.outputId ||
        observation.deliveryState !== "accepted" ||
        !observation.rows ||
        !Number.isSafeInteger(source.rowIndex) ||
        source.rowIndex < 0 ||
        !Object.hasOwn(observation.rows, source.rowIndex)
      )
        throw new IsolationError();
      const row = observation.rows[source.rowIndex];
      return { row, report: projectRecruitingCandidateReport(row) };
    } catch {
      throw new IsolationError();
    }
  };
}
