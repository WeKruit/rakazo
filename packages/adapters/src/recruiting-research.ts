import { createHash } from "node:crypto";
import type {
  RecruitingHumanIntent,
  RecruitingResearchObservation,
  RecruitingSourceRef,
} from "@rakazo/contracts";
import {
  RecruitingArtifactRefSchema,
  RecruitingHumanIntentSchema,
  RecruitingId,
  RecruitingSourceRefSchema,
} from "@rakazo/contracts";
import { requireRecruitingBriefConfirmation } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { z } from "zod";
import type { LoadedRecruitingRunContext } from "./recruiting-context.js";

const Text = z.string().refine((text) => text.trim().length > 0, "Text must not be blank");
const Route = z.strictObject({
  connectorId: z.literal("mcp"),
  resourceId: RecruitingId,
  resourceRevision: z.number().int().positive(),
  toolName: z.enum(["research", "reply"]),
  catalogGroup: Text.optional(),
});
const Request = {
  version: z.literal(1),
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
export const RecruitingResearchRequestSchema = z
  .discriminatedUnion("operation", [
    z.strictObject({
      ...Request,
      operation: z.literal("create"),
      args: z.strictObject({ prompt: Text }),
    }),
    z.strictObject({
      ...Request,
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
  });
  const manifest = RecruitingResearchRequestSchema.parse({
    version: 1,
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
}): string {
  return [
    input.contextText,
    `Research instructions:\n${input.instructions}`,
    `Requested output:\n${input.output}`,
    ...(input.recallScope === null ? [] : [`Recall scope for this round:\n${input.recallScope}`]),
    "The role criteria remain authoritative. Recall scope and output instructions do not change qualification. Preserve missing evidence as unknown; provider labels do not establish qualification.",
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
    if (!Array.isArray(body.rows) || body.rows.some((row) => !record(row))) return observation;
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

function mcpObject(raw: unknown): Record<string, unknown> | undefined {
  const envelope = record(raw);
  if (!envelope) return undefined;
  const bodies: Record<string, unknown>[] = [];
  if (envelope.structuredContent !== undefined) {
    const body = record(envelope.structuredContent);
    if (!body) return undefined;
    bodies.push(body);
  }
  for (const block of Array.isArray(envelope.content) ? envelope.content : []) {
    if (record(block)?.type !== "text" || typeof block.text !== "string") continue;
    try {
      const body = record(JSON.parse(block.text));
      if (body) bodies.push(body);
    } catch {
      /* Narrative text is never a structured receipt. */
    }
  }
  if (!bodies.length) return undefined;
  try {
    const first = stableJsonValue(bodies[0]);
    if (bodies.some((body) => stableJsonValue(body) !== first)) return undefined;
  } catch {
    return undefined;
  }
  return bodies[0];
}
