import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ArtifactStore,
  ConnectorCall,
  ConnectorProvider,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { recruitingResearchPollJob } from "@rakazo/adapter-kit";
import type { Actor, RecruitingResearchToolInput } from "@rakazo/contracts";
import {
  RecruitingCrmCandidatesReadSchema,
  RecruitingCrmRoleMailReadSchema,
  RecruitingResearchReadArtifactSchema,
  RecruitingResearchToolInputSchema,
  RecruitingRoleToolInputSchema,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  parseCsv,
} from "@rakazo/core";
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
  bindRecruitingResearchReadEffect,
  executeRecruitingRoleMutation,
  getRecruitingWorkspace,
  IsolationError,
  listRecruitingCandidates,
  listRunToolResults,
  listUnmappedRecruitingResearchReads,
  RecruitingConflictError,
  RecruitingIntentQuoteError,
  RecruitingSourceValidationError,
  readNativeRecruitingCandidatePage,
  readRecruitingResearchContext,
  recordRecruitingResearchObservation,
  recruitingCsvImportReceipt,
  recruitingGradesReceipt,
  recruitingPeopleSearchReceipt,
  recruitingResearchSnapshot,
  saveNativeRecruitingCandidatePage,
  saveRecruitingCandidateCsvImport,
  saveRecruitingCandidateGrades,
  saveRecruitingCandidatePeopleSearch,
  scoped,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

import { completeExternalEffect } from "./approval-effect.js";
import { readActorArtifact } from "./artifact-read.js";
import { inlineProfilePhotos } from "./profile-photo.js";
import type { PeopleSearchRow } from "./recruiting-profiles.js";
import {
  isPeopleSearchEndpoint,
  keepSearchHistory,
  peopleFromSearch,
} from "./recruiting-profiles.js";
import {
  bestLookedUpEmail,
  classifyRecruitingResearchResult,
  lookedUpContactEmails,
} from "./recruiting-research.js";
import {
  RECRUITING_RESEARCH_BACKGROUND_NOTICE,
  RECRUITING_RESEARCH_FOREGROUND_WAIT_SECONDS,
  recruitingResearchPollDelay,
} from "./recruiting-research-poll.js";

const BRIEF_KEYS = ["fields", "searchFilters", "questions", "rules"] as const;
const ROLE_KEYS = [
  "title",
  "sourceRefs",
  "criteria",
  "preferences",
  "definitionQuestions",
] as const;

const SOURCE_KINDS = [
  "provider_report",
  "original_material",
  "candidate_statement",
  "recruiter_verified",
];
const READ_STATES = ["read", "unread", "unavailable"];
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Rewrites one source reference into the shape the schema takes, or drops it when it names no
 * message or file. The server then fills the file fingerprint and checks ownership as before, so a
 * citation slip never costs the save.
 */
function repairSourceRef(
  value: unknown,
  now: string,
  index: number,
): Record<string, unknown> | undefined {
  const object = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item);
  const text = (item: unknown) =>
    typeof item === "string" && item.trim() ? item.trim() : undefined;
  if (!object(value)) return undefined;
  const anchor = object(value.anchor) ? value.anchor : {};
  const file = object(anchor.artifact) ? anchor.artifact : {};
  const artifactId = text(file.artifactId) ?? text(anchor.artifactId) ?? text(value.artifactId);
  const messageId = text(anchor.messageId) ?? text(value.messageId);
  const locator = text(anchor.locator) ?? text(value.locator);
  const sha256 = text(file.sha256) ?? text(anchor.sha256);
  const fixedAnchor =
    messageId && (anchor.kind !== "artifact" || !artifactId)
      ? { kind: "message", messageId, locator: locator ?? "blocks[0].text" }
      : artifactId
        ? {
            kind: "artifact",
            artifact: {
              artifactId,
              sha256: sha256 && SHA256.test(sha256) ? sha256 : "0".repeat(64),
            },
            locator: locator ?? "text",
          }
        : undefined;
  if (!fixedAnchor) return undefined;
  const readState = READ_STATES.includes(String(value.readState))
    ? String(value.readState)
    : "read";
  const time = text(value.readAt) ? Date.parse(String(value.readAt)) : Number.NaN;
  const quote = readState === "read" ? text(value.quote) : undefined;
  const url = text(value.url);
  return {
    id: text(value.id) ?? `source-${index + 1}`,
    kind: SOURCE_KINDS.includes(String(value.kind)) ? value.kind : "original_material",
    anchor: fixedAnchor,
    readState,
    readAt: readState === "unread" ? null : Number.isNaN(time) ? now : new Date(time).toISOString(),
    ...(url && /^https?:\/\//.test(url) ? { url } : {}),
    ...(quote ? { quote } : {}),
  };
}

function repairSourceRefs(value: unknown, now: string): Record<string, unknown>[] | undefined {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value]).flatMap((item, index) => {
    const repaired = repairSourceRef(item, now, index);
    return repaired ? [repaired] : [];
  });
}

/**
 * Repairs harmless slips before the schema check, so they never cost a rejected call and a
 * regenerated brief: a read carries only its operation; a read human-message reference without
 * readAt gets the call time (message reads have no receipt time); brief lists written next to
 * the brief move into it, and role lists written inside it move out.
 */
export function normalizeRecruitingRoleArgs(
  args: Record<string, unknown>,
  now: string,
): Record<string, unknown> {
  if (args.operation === "read") return { operation: "read" };
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const record = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, visit(item)]),
    );
    const anchor = record.anchor as { kind?: unknown } | undefined;
    return anchor?.kind === "message" && record.readState === "read" && record.readAt == null
      ? { ...record, readAt: now }
      : record;
  };
  let visited = visit(args) as Record<string, unknown>;
  if (!["create", "update", "revise"].includes(String(visited.operation))) return visited;
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  // Every citation is put into the schema's shape; a criterion keeps at least the role's first one.
  const roleRefs = repairSourceRefs(visited.sourceRefs, now);
  if (roleRefs) visited = { ...visited, sourceRefs: roleRefs };
  const repairCriteria = (list: unknown) =>
    Array.isArray(list)
      ? list.map((criterion) => {
          if (!object(criterion) || criterion.sourceRefs === undefined) return criterion;
          const refs = repairSourceRefs(criterion.sourceRefs, now) ?? [];
          return { ...criterion, sourceRefs: refs.length ? refs : (roleRefs ?? []).slice(0, 1) };
        })
      : list;
  if (Array.isArray(visited.criteria))
    visited = { ...visited, criteria: repairCriteria(visited.criteria) };
  else if (object(visited.criteria) && Array.isArray(visited.criteria.upsert))
    visited = {
      ...visited,
      criteria: { ...visited.criteria, upsert: repairCriteria(visited.criteria.upsert) },
    };
  // An update's criteria hold only upsert/remove; other keys written there belong to the call.
  if (visited.operation === "update" && object(visited.criteria)) {
    const { upsert, remove, ...stray } = visited.criteria;
    const criteria = {
      ...(upsert === undefined ? {} : { upsert }),
      ...(remove === undefined ? {} : { remove }),
    };
    const { criteria: _criteria, ...rest } = visited;
    visited = { ...stray, ...rest, ...(Object.keys(criteria).length ? { criteria } : {}) };
  }
  const outside = BRIEF_KEYS.filter((key) => Object.hasOwn(visited, key));
  if (!object(visited.brief) && !outside.length) return visited;
  const brief: Record<string, unknown> = object(visited.brief) ? { ...visited.brief } : {};
  const result: Record<string, unknown> = { ...visited };
  for (const key of outside) {
    if (!Object.hasOwn(brief, key)) brief[key] = result[key];
    delete result[key];
  }
  for (const key of ROLE_KEYS) {
    if (!Object.hasOwn(brief, key)) continue;
    if (!Object.hasOwn(result, key)) result[key] = brief[key];
    delete brief[key];
  }
  delete brief.confirmation;
  return { ...result, brief };
}

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

type ResearchContext = Awaited<ReturnType<typeof readRecruitingResearchContext>>;
type ResearchDeps = {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  /** When present, a task still working after a call is polled in the background. */
  jobs?: Pick<JobPublisher, "enqueue">;
};
type ResearchActor = { actor: Actor; runId: string; sourceMessageId: string | null };

export async function resolveRecruitingResearchTool(
  deps: ResearchDeps,
  trusted: ResearchActor,
  untrusted: Extract<RecruitingResearchToolInput, { operation: "status" | "rows" }>,
  context: AdapterContext,
) {
  const input = RecruitingResearchToolInputSchema.parse(untrusted);
  if (input.operation !== "status" && input.operation !== "rows") throw new IsolationError();
  const saved = await readRecruitingResearchContext(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    historical: true,
    taskId: input.taskId,
    toolName: input.operation === "status" ? "get_task" : "get_rows",
  });
  if (!saved.task || !saved.server) throw new IsolationError();
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
type ResearchReadAdmission = {
  kind: "read";
  operation: "status" | "rows";
  saved: ResearchContext;
  call: ConnectorCall;
  recoveredResult?: object;
};
export type RecruitingResearchCallAdmission = ResearchReadAdmission;

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
  options: { taskId?: string },
): Promise<RecruitingResearchCallAdmission | undefined> {
  const route = call.route;
  // Only status and row reads of an older saved research action are recorded here; everything
  // else, including new research, uses the harness's own permissions, effects and recovery.
  if (
    route?.connectorId !== "mcp" ||
    !route.resourceId ||
    (route.toolName !== "get_task" && route.toolName !== "get_rows")
  )
    return undefined;
  const run = await deps.prisma.run.findFirst({
    where: { id: trusted.runId, spaceId: trusted.actor.spaceId, userId: trusted.actor.userId },
    select: { thread: { select: { activeRecruitingRoleId: true } } },
  });
  if (!run) throw new IsolationError();
  const task = options.taskId
    ? { id: options.taskId }
    : await deps.prisma.recruitingResearchTask.findFirst({
        where: {
          role: { spaceId: trusted.actor.spaceId, userId: trusted.actor.userId },
          mcpServerId: route.resourceId,
          serverRevision: Number(route.resourceRevision),
          providerTaskId: String(call.args.task_id ?? ""),
          // Research started directly on the provider is only followed in the background;
          // its reads stay ordinary native reads.
          actions: { some: {} },
        },
        select: { id: true },
      });
  if (!task) return undefined;
  if (!deps.artifacts) throw new Error("Recruiting research requires artifact storage");
  const researchDeps = { prisma: deps.prisma, artifacts: deps.artifacts };
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
        toolName: route.toolName,
      });
  return {
    kind: "read",
    operation: route.toolName === "get_task" ? "status" : "rows",
    saved,
    call,
    recoveredResult,
  };
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
    return await withCandidatePageSummary(deps.prisma, result, observation.rows);
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

const SUMMARY_PEOPLE = 20;
const GRADE_COLUMNS = ["grade", "match_tier", "tier"];

/** How many returned rows carry each grade, from the first grade column the rows have. */
function gradeCounts(rows: readonly unknown[]): Record<string, number> | undefined {
  const cell = (row: unknown, key: string) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
    const value = (row as Record<string, unknown>)[key];
    const plain =
      value !== null && typeof value === "object" && "value" in value
        ? (value as { value: unknown }).value
        : value;
    return typeof plain === "string" && plain.trim() ? plain.trim() : undefined;
  };
  const column = GRADE_COLUMNS.find((key) => rows.some((row) => cell(row, key) !== undefined));
  if (!column) return undefined;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const grade = cell(row, column) ?? "unknown";
    counts[grade] = (counts[grade] ?? 0) + 1;
  }
  return counts;
}

/**
 * Adds who was saved to a save_results receipt, so the agent relays the page from this summary
 * instead of paging through the complete output artifact. A summary failure keeps the receipt.
 */
export async function withCandidatePageSummary(
  prisma: PrismaClient,
  result: unknown,
  returned: readonly unknown[] = [],
) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
  const { roleId, sourceEffectId } = result as { roleId?: unknown; sourceEffectId?: unknown };
  if (typeof roleId !== "string" || typeof sourceEffectId !== "string") return result;
  try {
    const rows = await prisma.recruitingCandidateOccurrence.findMany({
      where: { pageId: sourceEffectId, roleId },
      orderBy: { rowIndex: "asc" },
      select: {
        candidateKey: true,
        name: true,
        title: true,
        company: true,
        location: true,
        linkedinUrl: true,
        matchFields: true,
      },
    });
    const earlier = await prisma.recruitingCandidateOccurrence.findMany({
      where: {
        roleId,
        pageId: { not: sourceEffectId },
        candidateKey: { in: rows.map((row) => row.candidateKey) },
      },
      distinct: ["candidateKey"],
      select: { candidateKey: true },
    });
    const seen = new Set(earlier.map((row) => row.candidateKey));
    const grades = gradeCounts(returned);
    const fresh = rows.filter((row) => !seen.has(row.candidateKey));
    return {
      ...result,
      summary: {
        saved: rows.length,
        newToRole: new Set(fresh.map((row) => row.candidateKey)).size,
        ...(grades ? { grades } : {}),
        people: fresh
          .slice(0, SUMMARY_PEOPLE)
          .map(({ candidateKey: _key, matchFields, ...person }) =>
            matchFields && typeof matchFields === "object" && Object.keys(matchFields).length
              ? { ...person, match: matchFields }
              : person,
          ),
        note: "Relay results from this summary (counts, grades, people) and the role's Results; the people are saved. Never copy the output into files or count it with a shell; read outputArtifact only for one named person's evidence, with a small limit.",
      },
    };
  } catch (error) {
    getLogger().warn("recruiting.candidates.summary.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
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

export class RecruitingPeopleSearchError extends Error {}

/** One agent run can return up to 500 people; all of them reach Results on one page. */
const PEOPLE_SEARCH_PAGE_LIMIT = 500;

/** Idempotency prefix of the save the server makes the moment one people search returns. */
export const PEOPLE_SEARCH_AUTOSAVE_KEY = "people-search-autosave:";

type SavedSearchRow = { candidateKey: string; alreadyInPool: boolean } & Record<string, unknown>;

function savedRows(result: unknown): SavedSearchRow[] {
  const rows =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as { candidateRows?: unknown }).candidateRows
      : undefined;
  return Array.isArray(rows)
    ? rows.filter(
        (row): row is SavedSearchRow =>
          Boolean(row) && typeof (row as { candidateKey?: unknown }).candidateKey === "string",
      )
    : [];
}

/**
 * Save the people this run's profile-data searches returned as one unassessed candidate page.
 * With `onlyEffectId` it saves just that one search, which is how each search reaches Results
 * the moment it returns. A later save_search then returns those already-saved rows too.
 */
export async function saveRecruitingPeopleSearch(
  deps: ResearchDeps,
  trusted: ResearchActor & {
    leaseOwner: string;
    leaseFence: number;
    effectId: string;
    effectRequest: unknown;
  },
  input: Extract<RecruitingResearchToolInput, { operation: "save_search" }>,
  context: AdapterContext,
  onlyEffectId?: string,
) {
  if (
    context.runId !== trusted.runId ||
    context.spaceId !== trusted.actor.spaceId ||
    context.userId !== trusted.actor.userId
  )
    throw new IsolationError();
  const sources: Array<{ effectId: string; toolName: string; host: string }> = [];
  const rows: Array<{ rowIndex: number; sourceEffectId: string; row: Record<string, string> }> = [];
  const seen = new Set<string>();
  let truncated = false;
  const saves = onlyEffectId
    ? []
    : await deps.prisma.externalEffect.findMany({
        where: {
          id: { not: trusted.effectId },
          runId: trusted.runId,
          spaceId: trusted.actor.spaceId,
          kind: "recruiting_research",
          status: "completed",
          request: { path: ["operation"], equals: "save_search" },
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, idempotencyKey: true, result: true },
      });
  // A run that searches in waves saves each wave once: calls an earlier save already took are
  // skipped, and searches the server saved as they returned are reused instead of saved again.
  const previous = saves
    .filter((save) => !save.idempotencyKey.startsWith(PEOPLE_SEARCH_AUTOSAVE_KEY))
    .at(-1);
  const autoSaved = saves.filter(
    (save) =>
      save.idempotencyKey.startsWith(PEOPLE_SEARCH_AUTOSAVE_KEY) &&
      (!previous || save.createdAt > previous.createdAt),
  );
  const autoSavedCalls = new Set(
    autoSaved
      .filter((save) => savedRows(save.result).length)
      .map((save) => save.idempotencyKey.slice(PEOPLE_SEARCH_AUTOSAVE_KEY.length).split(":")[0]),
  );
  const reused = new Map<string, SavedSearchRow>();
  for (const save of autoSaved)
    for (const row of savedRows(save.result))
      if (!reused.has(row.candidateKey)) reused.set(row.candidateKey, row);
  // Oldest call first, so the page keeps the order the searches returned people in.
  const calls = (await listRunToolResults(deps.prisma, trusted.actor, trusted.runId)).reverse();
  for (const call of calls) {
    if (onlyEffectId ? call.effectId !== onlyEffectId : autoSavedCalls.has(call.effectId)) continue;
    if (!isPeopleSearchEndpoint(call.endpoint)) continue;
    if (previous && call.createdAt <= previous.createdAt) continue;
    const people = peopleFromSearch(call.result, call.endpoint);
    if (!people.length) continue;
    sources.push({
      effectId: call.effectId,
      toolName: call.toolName,
      host: new URL(call.endpoint).hostname,
    });
    for (const person of people) {
      if (seen.has(person.linkedin_url)) continue;
      if (rows.length >= PEOPLE_SEARCH_PAGE_LIMIT) {
        truncated = true;
        break;
      }
      seen.add(person.linkedin_url);
      rows.push({ rowIndex: rows.length, sourceEffectId: call.effectId, row: { ...person } });
    }
  }
  if (!rows.length && reused.size) {
    const candidateRows = [...reused.values()];
    const result = {
      status: "saved",
      newPeople: candidateRows.filter((row) => !row.alreadyInPool).length,
      candidateRows,
    };
    if (
      !(await completeExternalEffect(deps.prisma, trusted.effectId, "executing", result as never))
    )
      throw new IsolationError();
    return result;
  }
  if (!rows.length)
    throw new RecruitingPeopleSearchError(
      "No people with a name and LinkedIn profile came back from a profile-data search in this run. Run the people search with the connected profile-data connector first, then save.",
    );
  await inlineProfilePhotos(rows.map((entry) => entry.row));
  const captured = { sources, rows, truncated };
  const bytes = Buffer.from(
    stableJsonValue(recruitingPeopleSearchReceipt(input, captured)),
    "utf8",
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  const name = `recruiting-people-search-${hash}.json`;
  const stored = await deps.artifacts.put({ name, mimeType: "application/json", bytes }, context);
  const saved = await saveRecruitingCandidatePeopleSearch(
    deps.prisma,
    trusted.actor,
    trusted,
    input,
    {
      ...captured,
      outputArtifact: {
        name,
        mimeType: "application/json",
        size: bytes.byteLength,
        hash,
        storageKey: stored.id,
        clientNonce: `recruiting-people-search:${trusted.effectId}`,
      },
    },
  );
  // Results reads education and work history from the saved profile, since a later grading
  // result becomes the person's newest row and does not repeat them. It runs beside the reply
  // and never fails the save.
  const searchedAt = new Map(calls.map((call) => [call.effectId, call.createdAt]));
  void keepSearchHistory(
    deps.prisma,
    trusted.actor,
    trusted.runId,
    rows.map((entry) => ({
      row: entry.row as PeopleSearchRow,
      effectId: entry.sourceEffectId,
      createdAt: searchedAt.get(entry.sourceEffectId) ?? new Date(),
    })),
  ).catch((error) => getLogger().warn("recruiting.profiles.keep_failed", { error: String(error) }));
  if (!reused.size) return saved;
  const fresh = savedRows(saved).filter((row) => !reused.has(row.candidateKey));
  const candidateRows = [...reused.values(), ...fresh];
  return {
    ...(saved as Record<string, unknown>),
    newPeople: candidateRows.filter((row) => !row.alreadyInPool).length,
    candidateRows,
  };
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
  const { task, action } = admitted.saved;
  if (!task || !action || !receiptIdentity) throw new IsolationError();
  const raw = result;
  const observation = classifyRecruitingResearchResult(raw, {
    operation: admitted.operation,
    ...(task.providerTaskId ? { providerTaskId: task.providerTaskId } : {}),
  });
  const snapshot = {
    version: 1,
    taskId: task.id,
    actionId: action.id,
    operation: admitted.operation,
    effectId: receiptIdentity.effectId,
    request: admitted.call.args,
    providerResult: raw,
    observation,
  };
  const file =
    receiptIdentity.outputArtifact ??
    (await uploadResearchReceipt(
      deps,
      context,
      RecruitingResearchReadArtifactSchema.parse(snapshot),
      `recruiting-observation-${action.id}`,
      receiptIdentity.effectId,
    ));
  const taskState =
    observation.observedProviderState === "completed" && observation.done === true
      ? ("completed" as const)
      : observation.deliveryState === "accepted" && observation.done === false
        ? ("active" as const)
        : undefined;
  const persisted = await recordRecruitingResearchObservation(deps.prisma, trusted.actor, {
    runId: trusted.runId,
    actionId: action.id,
    effectId: receiptIdentity.effectId,
    request: receiptIdentity.request as Prisma.InputJsonValue,
    rawResult: raw as Prisma.InputJsonValue,
    ...(receiptIdentity.historicalBackfill ? { historicalBackfill: true } : {}),
    toolName: admitted.operation === "status" ? "get_task" : "get_rows",
    outputArtifact: file,
    ...(observation.rows === undefined ? {} : { rows: observation.rows }),
    ...(observation.outputId === undefined ? {} : { outputId: observation.outputId }),
    ...(observation.observedProviderState === null
      ? {}
      : { observedProviderState: observation.observedProviderState }),
    ...(observation.usage === null || !action.receiptArtifactId
      ? {}
      : { usage: observation.usage }),
    ...(taskState ? { taskState } : {}),
    ...(observation.nextCursor === undefined ? {} : { cursor: observation.nextCursor }),
  });
  // The provider is still working after the foreground wait: hand off to the poll job, which
  // wakes this thread once, and tell the model not to spin on status. A stopped run never arms it.
  const background =
    taskState === "active" &&
    admitted.operation !== "rows" &&
    deps.jobs &&
    !receiptIdentity?.historicalBackfill &&
    (await deps.prisma.run.count({
      where: { id: trusted.runId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    })) > 0;
  if (background)
    await deps.jobs!.enqueue(
      recruitingResearchPollJob({ taskId: task.id }, recruitingResearchPollDelay(0)),
    );
  return {
    status: observation.deliveryState,
    ...recruitingResearchSnapshot(persisted.task, persisted.action),
    ...("candidateRows" in persisted ? { candidateRows: persisted.candidateRows } : {}),
    observation,
    providerResult: raw,
    ...(background ? { background: RECRUITING_RESEARCH_BACKGROUND_NOTICE } : {}),
  };
}

const fold = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Case/diacritics-insensitive partial match: every query word appears in the stored name. */
export function personNameMatches(name: string | null | undefined, query: string) {
  const words = fold(query).split(" ").filter(Boolean);
  const stored = fold(name ?? "");
  return words.length > 0 && words.every((word) => stored.includes(word));
}

const sameUrl = (url: string | null | undefined) =>
  url
    ? fold(url)
        .replace(/^https?:\/\/(www\.)?/, "")
        .replace(/\/+$/, "")
    : null;

export type ResolvedRecruitingContact = {
  name: string | null;
  email: string | null;
  linkedinUrl: string | null;
  sources: ("crm_contact" | "saved_pool")[];
  crmCandidateId: string | null;
  candidateKey: string | null;
  stage: string | null;
  outreachStatus: string | null;
};
type CrmRow = ReturnType<typeof RecruitingCrmCandidatesReadSchema.parse>["rows"][number];
type PoolRow = { candidateKey: string; name: string | null; linkedinUrl: string | null };

/** The role's own records for one person: CRM contacts first, then the saved pool. */
export function matchRecruitingContacts(nameOrEmail: string, crmRows: CrmRow[], pool: PoolRow[]) {
  const email = nameOrEmail.includes("@") ? fold(nameOrEmail) : null;
  const matches: ResolvedRecruitingContact[] = crmRows
    .filter((row) =>
      email ? fold(row.email ?? "") === email : personNameMatches(row.full_name, nameOrEmail),
    )
    .map((row) => ({
      name: row.full_name,
      email: row.email,
      linkedinUrl: row.linkedin_url,
      sources: ["crm_contact"],
      crmCandidateId: row.candidate_id,
      candidateKey: null,
      stage: row.stage,
      outreachStatus: row.outreach_status,
    }));
  // The pool stores no email, so an email query resolves through CRM contacts only.
  for (const row of email ? [] : pool.filter((row) => personNameMatches(row.name, nameOrEmail))) {
    // Merge only on the same LinkedIn profile, never by name.
    const same = matches.find(
      (match) => match.linkedinUrl && sameUrl(match.linkedinUrl) === sameUrl(row.linkedinUrl),
    );
    if (same) {
      same.sources.push("saved_pool");
      same.candidateKey = row.candidateKey;
    } else
      matches.push({
        name: row.name,
        email: null,
        linkedinUrl: row.linkedinUrl,
        sources: ["saved_pool"],
        crmCandidateId: null,
        candidateKey: row.candidateKey,
        stage: null,
        outreachStatus: null,
      });
  }
  return {
    status: !matches.length
      ? ("not_found" as const)
      : matches.length === 1
        ? ("resolved" as const)
        : ("ambiguous" as const),
    matches,
  };
}

// ponytail: per-process, per-run memory of resolved stored emails; a restarted run re-resolves.
const resolvedEmails = new Map<string, Map<string, string | null>>();
export function rememberResolvedContactEmails(runId: string, matches: ResolvedRecruitingContact[]) {
  const emails = resolvedEmails.get(runId) ?? new Map<string, string | null>();
  for (const match of matches) if (match.email) emails.set(fold(match.email), match.name);
  resolvedEmails.delete(runId);
  resolvedEmails.set(runId, emails);
  if (resolvedEmails.size > 500) resolvedEmails.delete(resolvedEmails.keys().next().value!);
}

/** Correspondence lookups use only an address stored for that person in this run's resolution. */
export function unresolvedContactEmailError(runId: string, email: string, name?: string) {
  const stored = resolvedEmails.get(runId)?.get(fold(email));
  return stored === undefined || (name && stored && !personNameMatches(stored, name))
    ? `No stored email for ${name ?? email}; resolve the contact first, never guess an address`
    : null;
}

/** candidate_key -> lead email recorded when people were added to the role's outreach campaign. */
async function roleCampaignLeadEmails(prisma: PrismaClient, actor: Actor, roleId: string) {
  const emails = new Map<string, string>();
  const bindings = await prisma.externalEffect.findMany({
    where: {
      spaceId: actor.spaceId,
      kind: "instantly_role_campaign",
      request: { path: ["roleId"], equals: roleId },
    },
    select: { result: true },
  });
  for (const { result } of bindings) {
    const leads = (result as { leads?: Record<string, { email?: unknown }> } | null)?.leads;
    for (const [key, lead] of Object.entries(leads ?? {}))
      if (typeof lead?.email === "string") emails.set(key, lead.email);
  }
  return emails;
}

/** Resolve a named person through the role's CRM-bound contacts and saved candidate pool. */
export async function resolveRecruitingContact(
  deps: { prisma: PrismaClient; connector?: Pick<ConnectorProvider, "execute"> },
  actor: Actor,
  input: { roleId: string; nameOrEmail: string },
  context: AdapterContext,
) {
  const pool: PoolRow[] = [];
  let crmTarget: Awaited<ReturnType<typeof listRecruitingCandidates>>["crmTarget"] = null;
  // ponytail: scans at most 1,000 saved people and 1,000 CRM contacts per role; add a folded-name index past that.
  for (let cursor: string | undefined, page = 0; page < 5; page++) {
    const result = await listRecruitingCandidates(deps.prisma, actor, {
      roleId: input.roleId,
      limit: 200,
      sort: "name",
      ...(cursor ? { cursor } : {}),
    });
    crmTarget = result.crmTarget;
    pool.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  const crmRows: CrmRow[] = [];
  let crm: "read" | "not_bound" | "unavailable" = crmTarget ? "read" : "not_bound";
  const target = crmTarget?.target;
  if (target && !deps.connector) crm = "unavailable";
  else if (target)
    try {
      crmRows.push(...(await readCrmRoleContacts(deps.connector!, target, context)));
    } catch (error) {
      context.signal.throwIfAborted();
      getLogger().warn("recruiting.contact.resolve.crm_unavailable", { error: String(error) });
      crm = "unavailable";
    }
  const result = matchRecruitingContacts(input.nameOrEmail, crmRows, pool);
  // A saved person enrolled in this role's outreach campaign has that lead address stored.
  const leadEmails = await roleCampaignLeadEmails(deps.prisma, actor, input.roleId);
  // Otherwise the email an earlier contact lookup saved for the same LinkedIn profile.
  const found = result.matches.some((match) => !match.email)
    ? await lookedUpContactEmails(deps.prisma, actor)
    : new Map();
  for (const match of result.matches)
    if (!match.email)
      match.email =
        (match.candidateKey ? leadEmails.get(match.candidateKey) : undefined) ??
        bestLookedUpEmail(found, match.linkedinUrl, match.candidateKey)?.address ??
        null;
  if (context.runId) rememberResolvedContactEmails(context.runId, result.matches);
  const contacts = result.matches.filter((match) => match.crmCandidateId);
  if (!target || crm !== "read" || !contacts.length) return { ...result, crm };
  // The Inbox's source: the role's stored correspondence is the primary "latest mail" answer.
  let messages: ReturnType<typeof RecruitingCrmRoleMailReadSchema.parse>["messages"] = [];
  let correspondence: "read" | "unavailable" = "read";
  try {
    for (const candidateId of new Set(contacts.map((contact) => contact.crmCandidateId!))) {
      // Pages are newest first: once the latest incoming message is present, both requested answers are known.
      const read = await readCrmRoleCorrespondence(deps.connector!, target, context, candidateId, {
        stopAtReceived: true,
      });
      messages.push(...read.messages);
    }
  } catch (error) {
    context.signal.throwIfAborted();
    getLogger().warn("recruiting.contact.resolve.correspondence_unavailable", {
      error: String(error),
    });
    correspondence = "unavailable";
    messages = [];
  }
  return {
    ...result,
    crm,
    matches: result.matches.map((match) => {
      if (!match.crmCandidateId) return match;
      const mine = messages
        .filter((m) => m.candidate_id === match.crmCandidateId)
        .toSorted((a, b) =>
          String(b.timestamp_email ?? "").localeCompare(String(a.timestamp_email ?? "")),
        );
      return {
        ...match,
        correspondence: {
          source: "crm_role_correspondence" as const,
          status: correspondence,
          latest: mailSummary(mine[0]),
          latestReceived: mailSummary(mine.find((m) => m.direction === "received")),
        },
      };
    }),
  };
}

async function crmData(
  connector: Pick<ConnectorProvider, "execute">,
  target: { mcpServerId: string; serverRevision: number },
  context: AdapterContext,
  tool: string,
  args: Record<string, unknown>,
) {
  let data: unknown;
  for await (const event of connector.execute(
    {
      tool,
      route: {
        connectorId: "mcp",
        resourceId: target.mcpServerId,
        resourceRevision: target.serverRevision,
        toolName: tool,
      },
      args,
      executionId: randomUUID(),
    },
    context,
  )) {
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "result")
      data = (event.data as { structuredContent?: { data?: unknown } } | null)?.structuredContent
        ?.data;
  }
  return data;
}

type CrmRoleMail = ReturnType<typeof RecruitingCrmRoleMailReadSchema.parse>["messages"][number];
export type CrmReadTarget = {
  mcpServerId: string;
  serverRevision: number;
  organizationId: string;
  crmRoleId: string;
  clientLabel: string;
  roleLabel: string;
};

function mailSummary(message: CrmRoleMail | undefined, previewLength = 500) {
  return message
    ? {
        direction: message.direction,
        at: message.timestamp_email,
        from: message.from_address,
        to: message.to_address,
        subject: message.subject,
        preview: message.body_text?.slice(0, previewLength) ?? null,
      }
    : null;
}

/** The role's CRM contacts, matched on the exact client and role labels. */
async function readCrmRoleContacts(
  connector: Pick<ConnectorProvider, "execute">,
  target: CrmReadTarget,
  context: AdapterContext,
) {
  const rows: CrmRow[] = [];
  for (let offset = 0; offset < 1000; ) {
    // list_crm_candidates filters by client/role LABELS, not role_spec_id; unreviewed-only is its default.
    const page = RecruitingCrmCandidatesReadSchema.parse(
      await crmData(connector, target, context, "list_crm_candidates", {
        p_org: target.organizationId,
        p_client: target.clientLabel,
        p_role: target.roleLabel,
        p_not_reviewed: false,
        p_limit: 50,
        p_offset: offset,
      }),
    );
    rows.push(
      ...page.rows.filter(
        (row) =>
          row.client_label.trim() === target.clientLabel.trim() &&
          row.role_label.trim() === target.roleLabel.trim(),
      ),
    );
    offset += page.rows.length;
    if (!page.rows.length || offset >= page.total) break;
  }
  return rows;
}

/**
 * The role's stored correspondence (the Inbox source), newest first, for one candidate or the
 * whole role. Every page must echo the exact organization, role and candidate scope.
 */
async function readCrmRoleCorrespondence(
  connector: Pick<ConnectorProvider, "execute">,
  target: CrmReadTarget,
  context: AdapterContext,
  candidateId: string | null,
  options: { stopAtReceived?: boolean; maxPages?: number; stopBefore?: string } = {},
) {
  const messages: CrmRoleMail[] = [];
  const seen = new Set<string>();
  let offset: number | null = 0;
  for (let page = 0; offset !== null && page < (options.maxPages ?? 1000); page++) {
    const read = RecruitingCrmRoleMailReadSchema.parse(
      await crmData(connector, target, context, "list_crm_role_correspondence", {
        p_org: target.organizationId,
        p_role: target.crmRoleId,
        ...(candidateId ? { p_candidate: candidateId } : {}),
        p_limit: 50,
        p_offset: offset,
      }),
    );
    if (
      read.organization_id !== target.organizationId ||
      read.role_id !== target.crmRoleId ||
      (candidateId ? read.candidate_id !== candidateId : read.candidate_id != null) ||
      read.messages.length > 50 ||
      read.messages.some(
        (message) =>
          message.organization_id !== target.organizationId ||
          (candidateId !== null && message.candidate_id !== candidateId) ||
          seen.has(message.id),
      ) ||
      new Set(read.messages.map((message) => message.id)).size !== read.messages.length ||
      (read.next_offset !== null &&
        (!read.messages.length || read.next_offset !== offset + read.messages.length))
    )
      throw new IsolationError("CRM correspondence scope or pagination changed");
    for (const message of read.messages) {
      seen.add(message.id);
      messages.push(message);
    }
    if (options.stopAtReceived && read.messages.some((message) => message.direction === "received"))
      return { messages, complete: true };
    // Newest first, so a page reaching past the window has read everything inside it.
    if (
      options.stopBefore &&
      read.messages.some(
        (message) => Date.parse(message.timestamp_email ?? "") < Date.parse(options.stopBefore!),
      )
    )
      return { messages, complete: true };
    offset = read.next_offset;
  }
  return { messages, complete: offset === null };
}

/**
 * Everyone on the role who has replied, from the role's stored correspondence (the Inbox
 * source). Unbound or unreadable correspondence is reported as such, never as "nobody replied".
 */
/** A received email on a role, with the sender's CRM name when the role's contacts list it. */
export type RecruitingRoleReply = {
  id: string;
  crmCandidateId: string;
  name: string | null;
  email: string | null;
  at: string;
  from: string | null;
  subject: string | null;
  body: string | null;
};

/**
 * Received emails on a role from `since` on, newest first, read from the role's stored
 * correspondence (the Inbox source) without a model. At most `maxPages` pages; `complete`
 * says whether the whole window was read. Names are read only when there is a reply to name.
 */
export async function readRecruitingRoleRepliesSince(
  connector: Pick<ConnectorProvider, "execute">,
  target: CrmReadTarget,
  context: AdapterContext,
  since: string,
  maxPages = 4,
): Promise<{ replies: RecruitingRoleReply[]; complete: boolean }> {
  const read = await readCrmRoleCorrespondence(connector, target, context, null, {
    maxPages,
    stopBefore: since,
  });
  const received = read.messages.filter(
    (message) =>
      message.direction === "received" &&
      Date.parse(message.timestamp_email ?? "") >= Date.parse(since),
  );
  if (!received.length) return { replies: [], complete: read.complete };
  const contacts = await readCrmRoleContacts(connector, target, context);
  const byId = new Map(contacts.map((row) => [row.candidate_id, row]));
  return {
    complete: read.complete,
    replies: received.map((message) => ({
      id: message.id,
      crmCandidateId: message.candidate_id,
      name: byId.get(message.candidate_id)?.full_name ?? null,
      email: byId.get(message.candidate_id)?.email ?? null,
      at: message.timestamp_email!,
      from: message.from_address,
      subject: message.subject,
      body: message.body_text,
    })),
  };
}

/** A chat without a role: resolve across this user's active roles, each read with its own role checks. */
export async function resolveRecruitingContactAcrossRoles(
  deps: Parameters<typeof resolveRecruitingContact>[0],
  actor: Actor,
  nameOrEmail: string,
  context: AdapterContext,
) {
  // ponytail: 50 active roles (cuid order ~ newest); add a cross-role name index if users keep more.
  const roles = await deps.prisma.recruitingRole.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { id: true, title: true },
    orderBy: { id: "desc" },
    take: 50,
  });
  const matches: (ResolvedRecruitingContact & { roleId: string; roleTitle: string })[] = [];
  const crm: { roleId: string; crm: "read" | "not_bound" | "unavailable" }[] = [];
  for (const role of roles) {
    const result = await resolveRecruitingContact(
      deps,
      actor,
      { roleId: role.id, nameOrEmail },
      context,
    );
    crm.push({ roleId: role.id, crm: result.crm });
    matches.push(
      ...result.matches.map((match) => ({ ...match, roleId: role.id, roleTitle: role.title })),
    );
  }
  return {
    scope: "all_user_roles" as const,
    status: !matches.length
      ? ("not_found" as const)
      : matches.length === 1
        ? ("resolved" as const)
        : ("ambiguous" as const),
    matches,
    crm,
  };
}

/**
 * The arguments for the server's one repeat of a refused role save: every citation becomes a plain
 * locator (no quote to match), and a mistyped intent quote becomes the recruiter's own words. The
 * repeat passes the same ownership checks; undefined when it would change nothing.
 */
export function repairedRoleSave(
  args: Record<string, unknown>,
  error: unknown,
): Record<string, unknown> | undefined {
  if (args.operation === "read" || !(error instanceof Error)) return undefined;
  if (
    !(error instanceof IsolationError) &&
    !(error instanceof RecruitingSourceValidationError) &&
    error.name !== "RecruitingPlaybookValidationError" &&
    error.name !== "ZodError"
  )
    return undefined;
  let changed = false;
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    const record = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, strip(item)]),
    );
    if (!("anchor" in record) || !("quote" in record)) return record;
    changed = true;
    const { quote: _quote, ...rest } = record;
    return rest;
  };
  const { intent, ...rest } = args;
  const repaired = strip(rest) as Record<string, unknown>;
  const quote = error instanceof RecruitingIntentQuoteError ? error.quote : undefined;
  const intentRecord =
    intent && typeof intent === "object" ? (intent as Record<string, unknown>) : {};
  if (quote && quote !== intentRecord.quote) changed = true;
  if (!changed) return undefined;
  return {
    ...repaired,
    ...(intent === undefined && !quote
      ? {}
      : { intent: { ...intentRecord, ...(quote ? { quote } : {}) } }),
  };
}

/** The quality check's own grades for saved people: one receipt artifact, then one role page. */
export async function saveRecruitingGrades(
  deps: ResearchDeps,
  trusted: ResearchActor & {
    leaseOwner: string;
    leaseFence: number;
    effectId: string;
    effectRequest: unknown;
  },
  input: Extract<RecruitingResearchToolInput, { operation: "save_grades" }>,
  context: AdapterContext,
) {
  if (
    context.runId !== trusted.runId ||
    context.spaceId !== trusted.actor.spaceId ||
    context.userId !== trusted.actor.userId
  )
    throw new IsolationError();
  const bytes = Buffer.from(stableJsonValue(recruitingGradesReceipt(input)), "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const name = `recruiting-grades-${hash}.json`;
  const stored = await deps.artifacts.put({ name, mimeType: "application/json", bytes }, context);
  return saveRecruitingCandidateGrades(deps.prisma, trusted.actor, trusted, input, {
    outputArtifact: {
      name,
      mimeType: "application/json",
      size: bytes.byteLength,
      hash,
      storageKey: stored.id,
      clientNonce: `recruiting-grades:${trusted.effectId}`,
    },
  });
}
