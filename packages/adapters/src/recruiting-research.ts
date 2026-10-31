import { isDeepStrictEqual } from "node:util";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type {
  Actor,
  RecruitingCandidateSource,
  RecruitingResearchObservation,
} from "@rakazo/contracts";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  projectRecruitingCandidateReport,
  readRecruitingResearchReadArtifact,
} from "@rakazo/core";
import { mcpObject } from "@rakazo/core/node/approval-effect-key";
import type { McpServer, PrismaClient } from "@rakazo/db";
import { IsolationError, listRecruitingResearch, listRunToolResults } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { readActorArtifact } from "./artifact-read.js";
import type { ContactProvider, FoundEmail } from "./contact-lookup.js";
import { NOT_GRADING_TASK } from "./recruiting-grading.js";
import { isPeopleSearchEndpoint, linkedinPersonKey } from "./recruiting-profiles.js";

export { isRecruitingCandidateReportField, projectRecruitingCandidateReport } from "@rakazo/core";
export { mcpObject } from "@rakazo/core/node/approval-effect-key";

async function nativeMcpCreationReceipts(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
  server: Pick<McpServer, "id" | "revision">,
  toolName: string,
  scope: { threadId?: string; since?: Date } = {},
) {
  // ponytail: inspect only native creation receipts, never full saved candidate outputs.
  const effects = await prisma.externalEffect.findMany({
    where: {
      spaceId: actor.spaceId,
      status: "completed",
      run: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        ...(scope.threadId ? { threadId: scope.threadId } : {}),
      },
      ...(scope.since ? { createdAt: { gte: scope.since } } : {}),
      OR: [["2", "route"], ["3"]].map((path) => ({
        AND: [
          { request: { path: [...path, "connectorId"], equals: "mcp" } },
          { request: { path: [...path, "resourceId"], equals: server.id } },
          { request: { path: [...path, "resourceRevision"], equals: server.revision } },
          { request: { path: [...path, "toolName"], equals: toolName } },
        ],
      })),
    },
    orderBy: { createdAt: "desc" },
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
      // The executor appends the resolved route only after the catalog id or display name
      // resolved to this exact tool, so the route, not the model-chosen id, is authoritative.
      (!direct &&
        (!catalog?.route ||
          !["connectors_execute_tool", "mcp_execute_tool"].includes(catalog.toolName)))
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
      "Listing all research is unavailable. Continue this role's research with get_task or reply on the task id from this conversation's earlier research calls, or start new research in this conversation.",
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

/**
 * A role's first calibration rounds come from the built-in people search, which answers in
 * seconds. Before any round is accepted, a new research task on a role that has none yet starts
 * only after a people search ran in this run (to top up a short one). Roles that already have
 * research keep their existing flow.
 */
export async function requireQuickSearchBeforeResearch(
  prisma: PrismaClient,
  context: Pick<AdapterContext, "userId" | "spaceId" | "runId">,
  server: Pick<McpServer, "transport" | "endpoint">,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (
    server.transport !== "streamable_http" ||
    server.endpoint !== "https://api.autumn.ai/mcp" ||
    toolName !== "research" ||
    args.task_id !== undefined ||
    !context.runId
  )
    return;
  const scope = { spaceId: context.spaceId, userId: context.userId };
  const run = await prisma.run.findFirst({
    where: { id: context.runId, ...scope },
    select: { trigger: true, thread: { select: { activeRecruitingRoleId: true } } },
  });
  const roleId = run?.thread.activeRecruitingRoleId;
  // Grading people a search already found is not a search.
  if (!roleId || run.trigger === "recruiting_grade") return;
  const [searchAssigned, earlierResearch, acceptedRound] = await Promise.all([
    prisma.botMcpServer.count({
      where: { ...scope, server: { ...scope, slug: "people-search", enabled: true } },
    }),
    prisma.recruitingResearchTask.count({ where: { roleId, ...NOT_GRADING_TASK } }),
    prisma.recruitingCalibrationRound.count({ where: { roleId, approvedAt: { not: null } } }),
  ]);
  if (!searchAssigned || earlierResearch || acceptedRound) return;
  const calls = await listRunToolResults(prisma, { ...scope } as Actor, context.runId);
  if (calls.some((call) => isPeopleSearchEndpoint(call.endpoint))) return;
  throw new IsolationError(
    "Calibration rounds use the built-in people search, not a research task: call web_search_advanced_exa yourself (four searches in one step; each saves itself to Results), then calibration_round, in this turn. If you do not have the people search, hand the round back to Main. Research starts after a round is accepted, or to top up a short people search in the same run.",
  );
}

/** Schools on the public profile, so Results can show education without another lookup. */
const EDUCATION_SCHEMA = {
  type: ["array", "null"],
  description: 'One entry per degree, "School | Degree, field of study | Start – End"',
  items: { type: "string" },
} as const;

/** Output shape a people-search agent run returns when the request names none. */
export const AGENT_RUN_PEOPLE_SCHEMA = {
  type: "object",
  required: ["people"],
  properties: {
    people: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        required: ["name", "linkedin_url", "evidence"],
        properties: {
          name: { type: "string" },
          linkedin_url: { type: ["string", "null"], format: "uri" },
          current_role: { type: ["string", "null"] },
          current_company: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
          education: EDUCATION_SCHEMA,
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;
/**
 * A grading run's rows: one per person given in input.data, in the research service's own row
 * format (canonical person columns, education, match_score 0–100, match_tier Strong / Promising / Partial /
 * Uncertain, fit_reasons, concerns, requirements_assessment), so Results reads them unchanged.
 */
export const AGENT_RUN_GRADE_SCHEMA = {
  type: "object",
  required: ["rows"],
  properties: {
    rows: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        required: [
          "name",
          "linkedin_url",
          "current_title",
          "current_company",
          "location",
          "education",
          "evidence_urls",
          "match_score",
          "match_tier",
          "fit_reasons",
          "concerns",
          "requirements_assessment",
        ],
        properties: {
          name: { type: "string" },
          linkedin_url: { type: "string" },
          current_title: { type: ["string", "null"] },
          current_company: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
          education: EDUCATION_SCHEMA,
          evidence_urls: { type: ["array", "null"], items: { type: "string" } },
          match_score: { type: "integer", minimum: 0, maximum: 100 },
          match_tier: { type: "string", enum: ["Strong", "Promising", "Partial", "Uncertain"] },
          fit_reasons: { type: "string" },
          concerns: { type: "array", items: { type: "string" } },
          requirements_assessment: {
            type: "array",
            items: {
              type: "object",
              required: ["requirement", "status", "evidence"],
              properties: {
                requirement: { type: "string" },
                status: { type: "string", enum: ["met", "not_met", "unknown"] },
                evidence: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
  },
} as const;
/** Most one people-search agent run (one wave) may spend, in US dollars. */
export const AGENT_RUN_MAX_COST_USD = 10;
/** Most one ultra run may spend; ultra is only for waves that ask for a thousand people or more. */
export const AGENT_RUN_ULTRA_MAX_COST_USD = 30;
/** People an ultra wave may return; a smaller wave stays within the default schema's 500. */
const AGENT_RUN_ULTRA_MAX_PEOPLE = 2000;

/** The largest people count a query names ("1,000", "5000"), or 0. */
function askedPeople(query: unknown): number {
  if (typeof query !== "string") return 0;
  let most = 0;
  for (const match of query.matchAll(/\b\d{1,3}(?:,\d{3})+\b|\b\d{1,6}\b/g))
    most = Math.max(most, Number(match[0].replaceAll(",", "")));
  return most;
}
/** A grading run of the same people in the same conversation is read again for this long. */
const GRADING_REUSE_MS = 6 * 60 * 60_000;
const FAILED_RUN_STATUSES = new Set(["failed", "cancelled", "canceled", "stopped", "expired"]);

/** The people a grading request names, as one comparable key; undefined when one has no profile. */
function gradedPeopleKey(data: unknown[]): string | undefined {
  const keys = data.map((person) => {
    const url = record(person)?.linkedin_url;
    return typeof url === "string" ? linkedinPersonKey(url) : undefined;
  });
  if (keys.some((key) => !key)) return undefined;
  return [...new Set(keys)].sort().join("\n");
}

/**
 * A grading run this conversation already started for exactly these people, unless it failed.
 * Its grades are read again instead of paying for the same batch twice: a grading turn that
 * restarts, or repeats its call after the run finished, used to send the identical batch again.
 */
async function earlierGradingRun(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
  server: Pick<McpServer, "id" | "revision">,
  threadId: string,
  people: unknown[],
): Promise<string | undefined> {
  const wanted = gradedPeopleKey(people);
  if (!wanted) return undefined;
  const receipts = await nativeMcpCreationReceipts(prisma, actor, server, "agent_run", {
    threadId,
    since: new Date(Date.now() - GRADING_REUSE_MS),
  });
  const failed = new Set<string>();
  for (const receipt of receipts) {
    const body = mcpObject(receipt.result);
    if (typeof body?.id === "string" && FAILED_RUN_STATUSES.has(String(body.status)))
      failed.add(body.id);
  }
  for (const receipt of receipts) {
    const data = record(receipt.args.input)?.data;
    const id = mcpObject(receipt.result)?.id;
    if (
      receipt.args.runId === undefined &&
      Array.isArray(data) &&
      typeof id === "string" &&
      !failed.has(id) &&
      gradedPeopleKey(data) === wanted
    )
      return id;
  }
  return undefined;
}

/** Most saved people sent as one agent run's exclusion list. */
const AGENT_RUN_EXCLUSION_LIMIT = 500;

/**
 * The people-search key is shared funding, not a shared run history: an agent run is resumed or
 * continued only from a run this person started. A new run returns people by default and skips
 * the people already in the conversation's role, so a wave never pays for someone twice.
 */
export async function prepareAgentRun(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId" | "runId">,
  server: Pick<McpServer, "id" | "revision" | "transport" | "endpoint">,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    toolName !== "agent_run" ||
    server.transport !== "streamable_http" ||
    !server.endpoint ||
    new URL(server.endpoint).host !== "mcp.exa.ai"
  )
    return args;
  const named = (["runId", "previousRunId"] as const).filter((field) => args[field] !== undefined);
  if (named.length) {
    const owned = new Set<string>();
    for (const receipt of await nativeMcpCreationReceipts(prisma, actor, server, "agent_run")) {
      const id = mcpObject(receipt.result)?.id;
      if (typeof id === "string") owned.add(id);
    }
    for (const field of named)
      if (!owned.has(String(args[field])))
        throw new IsolationError(
          owned.size
            ? `No agent run with that ${field}. Your latest runs, newest first: ${[...owned].slice(0, 3).join(", ")}. Copy one unchanged, or start a new run with query.`
            : "This agent run is not available in your workspace. Start a new run with query.",
        );
  }
  if (args.runId !== undefined) return args;
  const toGrade = record(args.input)?.data;
  const grading = Array.isArray(toGrade) && toGrade.length > 0;
  const run = actor.runId
    ? await prisma.run.findFirst({
        where: { id: actor.runId, spaceId: actor.spaceId, userId: actor.userId },
        select: { threadId: true, thread: { select: { activeRecruitingRoleId: true } } },
      })
    : null;
  if (grading && run?.threadId) {
    const earlier = await earlierGradingRun(prisma, actor, server, run.threadId, toGrade);
    if (earlier) return { runId: earlier };
  }
  // Ultra is for a wave of a thousand people or more (the recruiter's rule); smaller waves and
  // grading use auto, which finds the same people for less.
  const ultra = args.effort === "ultra" && !grading && askedPeople(args.query) >= 1000;
  const effort = args.effort === "ultra" && !ultra ? "auto" : args.effort;
  const metered = effort === "auto" || ultra;
  const cap = ultra ? AGENT_RUN_ULTRA_MAX_COST_USD : AGENT_RUN_MAX_COST_USD;
  const asked = Number(record(args.budget)?.maxCostDollars);
  const { budget: _budget, ...rest } = args;
  const prepared: Record<string, unknown> = {
    ...rest,
    ...(effort !== undefined ? { effort } : {}),
    // The recruiter's spending limit for one wave; a lower limit the agent set still applies.
    ...(metered
      ? {
          budget: {
            maxCostDollars: Number.isFinite(asked) && asked >= 1 ? Math.min(asked, cap) : cap,
          },
        }
      : {}),
    // A grading run always returns the research row format; an agent's own schema would drop it.
    outputSchema: grading
      ? AGENT_RUN_GRADE_SCHEMA
      : (args.outputSchema ??
        (ultra
          ? {
              ...AGENT_RUN_PEOPLE_SCHEMA,
              properties: {
                people: {
                  ...AGENT_RUN_PEOPLE_SCHEMA.properties.people,
                  maxItems: AGENT_RUN_ULTRA_MAX_PEOPLE,
                },
              },
            }
          : AGENT_RUN_PEOPLE_SCHEMA)),
  };
  // People given to grade are already saved; leaving them out would leave nothing to grade.
  if (grading) return prepared;
  const roleId = run?.thread.activeRecruitingRoleId;
  if (!roleId) return prepared;
  const saved = await prisma.recruitingCandidate.findMany({
    where: { roleId, role: { id: roleId, spaceId: actor.spaceId, userId: actor.userId } },
    select: { candidateKey: true },
    take: AGENT_RUN_EXCLUSION_LIMIT,
  });
  const exclusion = saved.flatMap(({ candidateKey }) =>
    candidateKey.startsWith("linkedin:")
      ? [{ linkedin_url: `https://www.linkedin.com${candidateKey.slice("linkedin:".length)}` }]
      : [],
  );
  if (!exclusion.length) return prepared;
  const input = record(args.input) ?? {};
  const given = Array.isArray(input.exclusion) ? input.exclusion : [];
  return { ...prepared, input: { ...input, exclusion: [...given, ...exclusion] } };
}

/**
 * A finished people-search agent run reports what it cost in dollars; it goes in the usage ledger
 * once per run (as that service's credits, one per dollar), however often the run is read.
 * Accounting never fails the call it observes.
 */
export async function recordAgentRunCost(
  prisma: Pick<PrismaClient, "usageRecord">,
  actor: Pick<AdapterContext, "userId" | "spaceId" | "botId" | "runId">,
  server: Pick<McpServer, "slug" | "transport" | "endpoint">,
  toolName: string,
  result: unknown,
): Promise<void> {
  if (
    toolName !== "agent_run" ||
    server.transport !== "streamable_http" ||
    !server.endpoint ||
    new URL(server.endpoint).host !== "mcp.exa.ai"
  )
    return;
  const body = mcpObject(result);
  const dollars = Number(record(body?.costDollars)?.total);
  if (
    body?.status !== "completed" ||
    typeof body.id !== "string" ||
    !Number.isFinite(dollars) ||
    !(dollars > 0)
  )
    return;
  await prisma.usageRecord
    .createMany({
      data: [
        {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: actor.botId ?? null,
          runId: actor.runId ?? null,
          parentRunId: actor.runId ?? null,
          provider: server.slug,
          model: toolName,
          unit: "credits",
          quantity: dollars,
          costUsd: dollars,
          costSource: "provider-reported",
          usageSource: "provider_receipt",
          callId: `credits:${server.slug}:${body.id}`,
          operationKind: "retrieval",
        },
      ],
      skipDuplicates: true,
    })
    .catch((error: unknown) =>
      getLogger().warn("agent run cost not recorded", { error: String(error) }),
    );
}

/**
 * Shared contact-enrichment funding does not share another person's job history. Returns the
 * arguments to send: enrichment_id "latest" reads this person's newest lookup, so a later turn
 * need not recover the id from history.
 */
export async function requireFullEnrichJobOwnership(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
  server: Pick<McpServer, "id" | "revision" | "transport" | "endpoint">,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    server.transport !== "streamable_http" ||
    server.endpoint !== "https://mcp.fullenrich.com/mcp"
  )
    return args;
  if (toolName === "get_credits" && Object.keys(args).length === 0) return args;
  if (toolName === "enrich_bulk" && args.enrichment_id === undefined) return args;
  if (toolName === "get_enrichment_results") {
    const owned: string[] = [];
    for (const receipt of await nativeMcpCreationReceipts(prisma, actor, server, "enrich_bulk")) {
      if (receipt.args.enrichment_id !== undefined || record(receipt.result)?.isError === true)
        continue;
      const body = mcpObject(receipt.result);
      if (body?.error !== undefined || !nonblank(body?.enrichment_id)) continue;
      if (body.enrichment_id === args.enrichment_id) return args;
      owned.push(String(body.enrichment_id));
    }
    if (args.enrichment_id === "latest" && owned[0]) return { ...args, enrichment_id: owned[0] };
    // A mistyped id must not lead to a second paid lookup: name the ones this person started.
    if (owned.length)
      throw new IsolationError(
        `No lookup with that id. Your latest lookups, newest first: ${owned.slice(0, 3).join(", ")}. Read one of these, copying the id unchanged, or pass "latest"; do not start a new lookup.`,
      );
  }
  throw new IsolationError(
    "This contact lookup is not available in your workspace. Start a new lookup in this conversation.",
  );
}

/** What this account's earlier contact lookups did, by LinkedIn key. */
export type SavedContactLookups = {
  /** Emails already found. */
  emails: Map<string, FoundEmail[]>;
  /** Sources that already searched for a person and found nothing; never charged again. */
  searched: Map<string, Set<ContactProvider>>;
};

/** What this account's earlier contact lookups on this connection found, by LinkedIn key. */
export async function savedContactLookups(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
  server: Pick<McpServer, "id" | "revision">,
  toolName: string,
  into: SavedContactLookups = { emails: new Map(), searched: new Map() },
): Promise<SavedContactLookups> {
  for (const receipt of await nativeMcpCreationReceipts(prisma, actor, server, toolName)) {
    const people = mcpObject(receipt.result)?.people;
    for (const person of Array.isArray(people) ? people : []) {
      const entry = record(person);
      const key = linkedinPersonKey(entry?.linkedin_url);
      if (!key) continue;
      const emails = Array.isArray(entry?.emails) ? (entry.emails as FoundEmail[]) : [];
      if (emails.length && !into.emails.has(key)) into.emails.set(key, emails);
      for (const lookup of Array.isArray(entry?.lookups) ? entry.lookups : []) {
        const attempt = record(lookup);
        const provider = attempt?.provider;
        if (
          attempt?.outcome === "not_found" &&
          (provider === "fullenrich" || provider === "contactout" || provider === "leadmagic")
        )
          into.searched.set(key, (into.searched.get(key) ?? new Set()).add(provider));
      }
    }
  }
  return into;
}

/** What this account's contact lookups did, across its lookup connections and every role. */
export async function lookedUpContacts(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
) {
  const servers = await prisma.mcpServer.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      enabled: true,
      endpoint: "https://mcp.fullenrich.com/mcp",
    },
    select: { id: true, revision: true },
  });
  const saved: SavedContactLookups = { emails: new Map(), searched: new Map() };
  for (const server of servers)
    await savedContactLookups(prisma, actor, server, "native_find_emails", saved);
  return saved;
}

/** Emails this account's contact lookups saved, by LinkedIn key, across its lookup connections. */
export async function lookedUpContactEmails(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
) {
  return (await lookedUpContacts(prisma, actor)).emails;
}

/** The best saved email for a person: a deliverable one first. */
export function bestLookedUpEmail(
  found: Map<string, FoundEmail[]>,
  ...profiles: (string | null | undefined)[]
) {
  const emails = profiles
    .map((value) => linkedinPersonKey(value))
    .filter((key): key is string => Boolean(key))
    .flatMap((key) => found.get(key) ?? []);
  return emails.find((email) => email.status === "DELIVERABLE") ?? emails[0];
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
  // A finished people-search agent run that graded people: its structured rows are the page.
  if (options.operation === "rows" && options.providerTaskId?.startsWith("agent_run_")) {
    const rows = record(record(body.output)?.structured)?.rows;
    if (body.id !== options.providerTaskId || body.status !== "completed" || !Array.isArray(rows))
      return observation;
    observation.observedProviderState = "completed";
    observation.done = true;
    observation.rows = rows;
    observation.nextCursor = null;
    observation.deliveryState = "accepted";
    return observation;
  }
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
    {
      observation: Pick<RecruitingResearchObservation, "rows" | "outputId" | "deliveryState">;
      requestCursor: unknown;
    }
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
        let observation: Pick<RecruitingResearchObservation, "rows" | "outputId" | "deliveryState">;
        let requestCursor: unknown;
        const snapshot =
          source.taskId === null && source.actionId === null
            ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(saved.bytes))
            : undefined;
        if (
          snapshot?.version === 1 &&
          (snapshot.kind === "people_search" ||
            snapshot.kind === "csv_import" ||
            snapshot.kind === "reviewer_grades") &&
          Array.isArray(snapshot.rows)
        ) {
          // A people search, CSV import or quality-check grading page keeps its rows in its own
          // receipt; there is no research task behind it.
          observation = {
            deliveryState: "accepted",
            outputId: null,
            rows: snapshot.rows.map((item: { row?: unknown }) => item?.row),
          };
          requestCursor = null;
        } else if (snapshot) {
          const direct = boundDirectApprovalDetails(snapshot?.request, "__rakazoCatalogTool");
          const catalog = catalogApprovalDetails(snapshot?.request, "__rakazoCatalogTool");
          const route = direct?.route ?? catalog?.route;
          // A grading agent run's page is read by the run id in its own result.
          const agentRun =
            route?.toolName === "agent_run" ? mcpObject(snapshot.providerResult) : null;
          const args =
            agentRun && typeof agentRun.id === "string"
              ? { task_id: agentRun.id }
              : (direct?.args ?? catalog?.args.arguments);
          if (
            route?.connectorId !== "mcp" ||
            (route.toolName !== "get_rows" && !agentRun) ||
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
      return { row, report: projectRecruitingCandidateReport(row, observation.rows) };
    } catch {
      throw new IsolationError();
    }
  };
}
