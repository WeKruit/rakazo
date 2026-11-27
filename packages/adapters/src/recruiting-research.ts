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
import { IsolationError, listRecruitingResearch, listRunToolResults, Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { readActorArtifact } from "./artifact-read.js";
import type { ContactProvider, FoundEmail } from "./contact-lookup.js";
import { isPeopleSearchEndpoint, linkedinPersonKey, peopleFromSearch } from "./recruiting-profiles.js";

export { isRecruitingCandidateReportField, projectRecruitingCandidateReport } from "@rakazo/core";
export { mcpObject } from "@rakazo/core/node/approval-effect-key";

/** Receipts read per page: each holds a full provider answer, so most callers stop early. */
const RECEIPT_PAGE = 20;
/** Contact lookup receipts are small (a few KB each) and every one is read. */
const LOOKUP_RECEIPT_PAGE = 500;

/**
 * This person's native creation receipts on one connection, newest first, read one page at a
 * time so a caller that finds what it needs in the newest receipts never loads the whole history.
 *
 * The route is matched with literal JSON paths so the external_effects_*_tool_receipts indexes
 * find the receipts; a JSON filter with bound paths read every one of the account's effects.
 */
async function* nativeMcpCreationReceipts(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
  server: Pick<McpServer, "id" | "revision">,
  toolName: string,
  scope: { threadId?: string; since?: Date; pageSize?: number } = {},
): AsyncGenerator<{ args: Record<string, unknown>; result: unknown }> {
  const pageSize = scope.pageSize ?? RECEIPT_PAGE;
  const routeIs = (path: "direct" | "catalog") => {
    const at = (field: string) =>
      Prisma.raw(`e."request" #> '{${path === "direct" ? "2,route" : "3"},${field}}'`);
    const text = (field: string) =>
      Prisma.raw(`e."request" #>> '{${path === "direct" ? "2,route" : "3"},${field}}'`);
    return Prisma.sql`(${text("resourceId")} = ${server.id} AND ${text("toolName")} = ${toolName}
      AND ${at("connectorId")} = '"mcp"'::jsonb AND ${at("resourceId")} = to_jsonb(${server.id}::text)
      AND ${at("toolName")} = to_jsonb(${toolName}::text)
      AND ${at("resourceRevision")} = to_jsonb(${server.revision}::int))`;
  };
  // ponytail: inspect only native creation receipts, never full saved candidate outputs.
  let before: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const page = await prisma.$queryRaw<
      Array<{ id: string; createdAt: Date; request: unknown; result: unknown }>
    >(Prisma.sql`
      SELECT e."id", e."createdAt", e."request", e."result"
      FROM "external_effects" e JOIN "runs" r ON r."id" = e."runId"
      WHERE e."spaceId" = ${actor.spaceId} AND e."status" = 'completed'
        AND r."spaceId" = ${actor.spaceId} AND r."userId" = ${actor.userId}
        ${scope.threadId ? Prisma.sql`AND r."threadId" = ${scope.threadId}` : Prisma.empty}
        ${scope.since ? Prisma.sql`AND e."createdAt" >= ${scope.since}` : Prisma.empty}
        ${before ? Prisma.sql`AND (e."createdAt", e."id") < (${before.createdAt}, ${before.id})` : Prisma.empty}
        AND (${routeIs("direct")} OR ${routeIs("catalog")})
      ORDER BY e."createdAt" DESC, e."id" DESC
      LIMIT ${pageSize}`);
    for (const effect of page) {
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
      yield {
        args: requestArgs,
        result: record(effect.result)?.providerResult ?? effect.result,
      };
    }
    if (page.length < pageSize) return;
    const last = page[page.length - 1]!;
    before = { createdAt: last.createdAt, id: last.id };
  }
}

/** Schools on the public profile, so Results can show education without another lookup. */
const EDUCATION_SCHEMA = {
  type: ["array", "null"],
  description: 'One entry per degree, "School | Degree, field of study | Start – End"',
  items: { type: "string" },
} as const;

/** Output shape a people-search agent run returns when the request names none. */
/**
 * People one search run may return. The recruiter's rule: each try finds about 10 to 20 more,
 * never a wide sweep; a bigger request is several small tries, each limited below.
 */
export const AGENT_RUN_MAX_PEOPLE = 20;

/** The grades a search gives a person it found, in the words Results already reads. */
export const PEOPLE_MATCH_TIERS = ["Strong", "Promising", "Uncertain", "Partial"] as const;

/**
 * The search agent finds and grades in the same run (the recruiter's rule: it is our search agent,
 * we only pass the request on), so every person comes back with a score, a tier and one reason.
 */
export const AGENT_RUN_PEOPLE_SCHEMA = {
  type: "object",
  required: ["people"],
  properties: {
    people: {
      type: "array",
      maxItems: AGENT_RUN_MAX_PEOPLE,
      items: {
        type: "object",
        required: ["name", "linkedin_url", "evidence", "match_score", "match_tier", "fit_reasons"],
        properties: {
          name: { type: "string" },
          linkedin_url: { type: ["string", "null"], format: "uri" },
          current_role: { type: ["string", "null"] },
          current_company: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
          education: EDUCATION_SCHEMA,
          evidence: {
            type: "string",
            description:
              "What the public profile says, facts only: titles, companies, dates, years, skills, languages, current location.",
          },
          match_score: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description: "How well the profile fits the request's requirements on the person.",
          },
          match_tier: {
            type: "string",
            enum: PEOPLE_MATCH_TIERS,
            description:
              "Strong: every requirement is shown on the profile. Promising: most are shown and none is contradicted. Uncertain: the profile does not show enough to tell. Partial: a requirement is clearly not met, or the person is someone the request says to leave out.",
          },
          fit_reasons: {
            type: "string",
            description: "One short sentence: why, and what is missing.",
          },
        },
      },
    },
  },
} as const;
/** Most one deeper search for people may spend; observed deeper runs cost $0.3 to $1.4. */
export const AGENT_RUN_FIND_MAX_COST_USD = 2;
/**
 * People one quick people search may return. Ten is what the search's base price covers (each
 * result beyond ten is billed extra), and it keeps every search a small try, the recruiter's rule.
 */
export const PEOPLE_SEARCH_MAX_RESULTS = 10;

/** The conversation and role a run works in. */
async function runRole(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId" | "runId">,
) {
  return actor.runId
    ? prisma.run.findFirst({
        where: { id: actor.runId, spaceId: actor.spaceId, userId: actor.userId },
        select: { threadId: true, thread: { select: { activeRecruitingRoleId: true } } },
      })
    : null;
}

/** Model-facing: a people search in the main chat, whose people would have nowhere to go. */
export const PEOPLE_SEARCH_NEEDS_ROLE =
  "Not searched: people found here would have no role to be saved, checked and kept in, so the search for a role runs in that role's conversation. For a saved role, pass the recruiter's request to it with delegate_to_role in their own words; for a new one, open it with start_role.";
/** Model-facing: a people search in a role chat whose role is not saved yet. */
export const PEOPLE_SEARCH_NEEDS_SAVED_ROLE =
  "Not searched: this role is not saved yet, so the people found would have nowhere to go. Save it first with recruiting_role create (title and the JD's requirements), then search again.";

/**
 * People searches run only inside a saved role: its cap, autosave, per-requirement check and feedback
 * all read the conversation's role. Staging a986fe51, feedback-round: the main chat searched
 * itself, nothing was saved or checked, and a snippet's employer was stated as fact; 14d33ed1: a
 * role chat searched before its role was saved and save_search was refused.
 */
export async function requireRoleForPeopleSearch(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId" | "runId">,
  server: Pick<McpServer, "transport" | "endpoint">,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const people =
    (toolName === "web_search_advanced_exa" && args.category === "people") ||
    (toolName === "web_search_exa" && /\bcategory:\s*people\b/i.test(String(args.query ?? ""))) ||
    (toolName === "agent_run" && args.runId === undefined);
  if (
    !people ||
    !actor.runId ||
    server.transport !== "streamable_http" ||
    !server.endpoint ||
    new URL(server.endpoint).host !== "mcp.exa.ai"
  )
    return;
  const run = await prisma.run.findFirst({
    where: { id: actor.runId, spaceId: actor.spaceId, userId: actor.userId },
    select: { thread: { select: { activeRecruitingRoleId: true, groupId: true } } },
  });
  if (!run || run.thread.activeRecruitingRoleId) return;
  if (run.thread.groupId?.startsWith("recruiting-global-"))
    throw new IsolationError(PEOPLE_SEARCH_NEEDS_ROLE);
  if (run.thread.groupId?.startsWith("role-"))
    throw new IsolationError(PEOPLE_SEARCH_NEEDS_SAVED_ROLE);
}

/** The profile text a people search returns with each person. */
export const PROFILE_TEXT_CHARS = 6_000;

/** A quick people search asks for at most ten people, however the agent or a plan sized it. */
export function limitPeopleSearch(
  server: Pick<McpServer, "transport" | "endpoint">,
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const plain = toolName === "web_search_exa";
  if (
    !(plain || (toolName === "web_search_advanced_exa" && args.category === "people")) ||
    server.transport !== "streamable_http" ||
    !server.endpoint ||
    new URL(server.endpoint).host !== "mcp.exa.ai"
  )
    return args;
  const asked = Number(args.numResults);
  const wanted = Math.min(
    Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : PEOPLE_SEARCH_MAX_RESULTS,
    PEOPLE_SEARCH_MAX_RESULTS,
  );
  if (plain) return args;
  // A search for people also returns each profile's full text (dated jobs with their own
  // descriptions), which the requirement check reads; one person's lookup keeps its own size.
  const text = Number(args.textMaxCharacters);
  return {
    ...args,
    numResults: wanted,
    ...(linkedinPersonKey(args.query)
      ? {}
      : { textMaxCharacters: Math.max(Number.isFinite(text) ? text : 0, PROFILE_TEXT_CHARS) }),
  };
}

/** The search API's excludeText takes at most fifty strings: the newest saved people's names. */
const QUICK_SEARCH_EXCLUSION_LIMIT = 50;

/**
 * A quick people search leaves out the people already saved in the conversation's role, as an
 * agent run does. The people index refuses URL filters and accepts a text filter, so they are
 * named. Plays of 11-25: 50–80% of each later search's rows were people an earlier one had saved.
 */
export async function excludeFoundPeople(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId" | "runId">,
  server: Pick<McpServer, "transport" | "endpoint">,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    toolName !== "web_search_advanced_exa" ||
    args.category !== "people" ||
    server.transport !== "streamable_http" ||
    !server.endpoint ||
    new URL(server.endpoint).host !== "mcp.exa.ai"
  )
    return args;
  const roleId = (await runRole(prisma, actor))?.thread.activeRecruitingRoleId;
  if (!roleId) return args;
  const saved = await prisma.recruitingCandidateOccurrence.findMany({
    where: {
      roleId,
      name: { not: null },
      candidate: { role: { spaceId: actor.spaceId, userId: actor.userId } },
    },
    select: { name: true },
    distinct: ["candidateKey"],
    orderBy: { page: { observedAt: "desc" } },
    take: QUICK_SEARCH_EXCLUSION_LIMIT,
  });
  const given = Array.isArray(args.excludeText) ? args.excludeText.map(String) : [];
  const names = [
    ...new Set([...given, ...saved.flatMap(({ name }) => (name?.trim() ? [name.trim()] : []))]),
  ];
  return names.length
    ? { ...args, excludeText: names.slice(0, QUICK_SEARCH_EXCLUSION_LIMIT) }
    : args;
}

/** Most earlier turns of the conversation read for the profile text their searches returned. */
const PROFILE_TEXT_RUNS = 12;

/**
 * The full profile text the conversation's people searches returned, by person: this run's first,
 * then its earlier turns'.
 */
async function profileTexts(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId" | "runId">,
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  try {
    const run = await runRole(prisma, actor);
    const earlier = run
      ? await prisma.run.findMany({
          where: {
            threadId: run.threadId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            id: { not: actor.runId! },
          },
          orderBy: { createdAt: "desc" },
          take: PROFILE_TEXT_RUNS,
          select: { id: true },
        })
      : [];
    for (const runId of [actor.runId!, ...earlier.map(({ id }) => id)])
      for (const call of await listRunToolResults(prisma, { ...actor } as Actor, runId))
        if (isPeopleSearchEndpoint(call.endpoint))
          for (const person of peopleFromSearch(call.result, call.endpoint)) {
            const key = linkedinPersonKey(person.linkedin_url);
            if (key && person._profile_text && !texts.has(key))
              texts.set(key, person._profile_text);
          }
  } catch {
    // Without the text the people are graded and checked on what their row holds.
  }
  return texts;
}

/**
 * Rows a grading run returns hold only the grade, so each keeps the profile text the search
 * returned for that person: the requirement check then reads the same text the grade came from.
 */
export async function keepProfileText(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId" | "runId">,
  entries: Array<{ row: Record<string, unknown> }>,
): Promise<void> {
  if (entries.every(({ row }) => row._profile_text)) return;
  const texts = await profileTexts(prisma, actor);
  for (const { row } of entries) {
    const key = linkedinPersonKey(row.linkedin_url);
    const text = key ? texts.get(key) : undefined;
    if (text && !row._profile_text) row._profile_text = text;
  }
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
    for await (const receipt of nativeMcpCreationReceipts(prisma, actor, server, "agent_run")) {
      const id = mcpObject(receipt.result)?.id;
      if (typeof id === "string") owned.add(id);
      if (named.every((field) => owned.has(String(args[field])))) break;
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
  // One people search (decided 2026-11-27): a run finds and grades people in one go. People
  // already saved are not sent back to be graded a second way.
  const toGrade = record(args.input)?.data;
  if (Array.isArray(toGrade) && toGrade.length > 0)
    throw new IsolationError(
      "A run searches for people and grades the ones it returns; it does not grade people given in input.data. Leave input.data out: people already in Results keep the grade their search gave them.",
    );
  const run = await runRole(prisma, actor);
  // Every search is a small try of 10 to 20 people (the recruiter's rule), so ultra, which is for
  // thousand-person sweeps, runs as auto.
  const effort = args.effort === "ultra" ? "auto" : args.effort;
  const metered = effort === "auto";
  const cap = AGENT_RUN_FIND_MAX_COST_USD;
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
    outputSchema: args.outputSchema ?? AGENT_RUN_PEOPLE_SCHEMA,
  };
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
  const input = record(args.input) ?? {};
  const given = Array.isArray(input.exclusion) ? input.exclusion : [];
  const ready = exclusion.length
    ? { ...prepared, input: { ...input, exclusion: [...given, ...exclusion] } }
    : prepared;
  return ready;
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
    for await (const receipt of nativeMcpCreationReceipts(prisma, actor, server, "enrich_bulk")) {
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
  // Every receipt is read, so read them in few pages: each page scans the effects table.
  for await (const receipt of nativeMcpCreationReceipts(prisma, actor, server, toolName, {
    pageSize: LOOKUP_RECEIPT_PAGE,
  })) {
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

/** Reads already running, so parallel candidate lists in one turn share one read. */
const lookupsInFlight = new Map<string, Promise<SavedContactLookups>>();

/** What this account's contact lookups did, across its lookup connections and every role. */
export function lookedUpContacts(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
): Promise<SavedContactLookups> {
  const key = `${actor.spaceId}\u0000${actor.userId}`;
  let read = lookupsInFlight.get(key);
  if (!read) {
    read = readLookedUpContacts(prisma, actor).finally(() => lookupsInFlight.delete(key));
    lookupsInFlight.set(key, read);
  }
  // Callers add to what they get, so each one gets its own copy.
  return read.then(({ emails, searched }) => ({
    emails: new Map(emails),
    searched: new Map([...searched].map(([person, providers]) => [person, new Set(providers)])),
  }));
}

async function readLookedUpContacts(
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
  await importedContactEmails(prisma, actor, saved.emails);
  return saved;
}

/**
 * Addresses the recruiter's own imported lists gave, by LinkedIn key or else the saved person's
 * key. A list with emails is a known contact: its people are never looked up (and paid for)
 * again, nor asked for. Lookup results come first; a list fills in only who they lack.
 */
async function importedContactEmails(
  prisma: PrismaClient,
  actor: Pick<AdapterContext, "userId" | "spaceId">,
  into: Map<string, FoundEmail[]>,
) {
  const imports = await prisma.externalEffect.findMany({
    where: {
      spaceId: actor.spaceId,
      run: { userId: actor.userId },
      kind: "recruiting_research",
      status: "completed",
      request: { path: ["operation"], equals: "import_csv" },
    },
    select: { result: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  for (const { result } of imports) {
    const rows = record(result)?.candidateRows;
    for (const row of Array.isArray(rows) ? rows : []) {
      const entry = record(row);
      const address = typeof entry?.email === "string" ? entry.email : undefined;
      const key = linkedinPersonKey(entry?.linkedinUrl) ?? entry?.candidateKey;
      if (!address || typeof key !== "string" || into.has(key)) continue;
      into.set(key, [{ address, type: "personal", status: null, provider: "import" }]);
    }
  }
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
  // A saved person without a LinkedIn profile is known by their saved key.
  const emails = profiles
    .flatMap((value) => [linkedinPersonKey(value), value])
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
// These codes explicitly refuse a request in the provider's public ErrorResponse contract.
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

/**
 * Re-reads a stored page of result rows the way it was classified when it was saved, so an older
 * role's saved people can be checked against their retained receipt.
 */
export function classifyRecruitingResearchResult(
  raw: unknown,
  options: { providerTaskId?: string },
): RecruitingResearchObservation {
  const observation: RecruitingResearchObservation = {
    deliveryState: "unknown",
    providerTaskId: nonblank(options.providerTaskId) ? options.providerTaskId : null,
    observedProviderState: null,
    done: null,
    providerApplicationConfirmed: false,
    automaticRetry: false,
    usage: null,
  };
  const body = mcpObject(raw);
  if (!body) return observation;
  // A finished people-search agent run that graded people: its structured rows are the page.
  if (options.providerTaskId?.startsWith("agent_run_")) {
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
    if (body.task_created !== true && refusalCodes.has(body.error))
      observation.deliveryState = "rejected";
    return observation;
  }
  if (record(raw)?.isError === true || (body.error != null && body.state !== "failed"))
    return observation;
  if (!nonblank(options.providerTaskId)) return observation;
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
  observation.deliveryState = "accepted";
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
          // A people search, CSV import or stored grade page keeps its rows in its own
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
