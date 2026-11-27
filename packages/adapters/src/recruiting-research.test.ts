import { createHash } from "node:crypto";
import type { RecruitingSourceRef } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LoadedRecruitingRunContext } from "./recruiting-context.js";
import {
  AGENT_RUN_FIND_MAX_COST_USD,
  AGENT_RUN_PEOPLE_SCHEMA,
  agentRunSchemaForAgent,
  bestLookedUpEmail,
  classifyRecruitingResearchResult,
  createRecruitingCandidateReportReader,
  excludeFoundPeople,
  limitPeopleSearch,
  lookedUpContacts,
  prepareAgentRun,
  projectRecruitingCandidateReport,
  recordAgentRunCost,
  requireFullEnrichJobOwnership,
  requireRoleForPeopleSearch,
  savedContactLookups,
} from "./recruiting-research.js";
import { receiptQuery, receiptScope } from "./testing/receipt-query.js";

describe("agent run output schemas", () => {
  it("ask for education, so Results can show it for found and graded people", () => {
    expect(AGENT_RUN_PEOPLE_SCHEMA.properties.people.items.properties.education.items).toEqual({
      type: "string",
    });
  });
});

describe("people-search agent runs", () => {
  const actor = { userId: "owner", spaceId: "space", runId: "run-1" };
  const server = {
    id: "people-search",
    revision: 1,
    transport: "streamable_http",
    endpoint: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa",
  };
  const route = {
    connectorId: "mcp",
    resourceId: server.id,
    resourceRevision: 1,
    toolName: "agent_run",
  };
  const started = {
    request: ["__rakazoCatalogTool", "direct", { route, args: { query: "Find people" } }],
    result: {
      content: [
        { type: "text", text: JSON.stringify({ id: "agent_run_mine", status: "running" }) },
      ],
    },
  };
  function fixture(roleId: string | null = "role-1") {
    return {
      $queryRaw: vi.fn(
        receiptQuery((scope) =>
          scope.userId === actor.userId && scope.spaceId === actor.spaceId ? [started] : [],
        ),
      ),
      run: {
        findFirst: vi.fn(async () => ({
          threadId: "thread-1",
          thread: { activeRecruitingRoleId: roleId },
        })),
      },
      recruitingCandidate: {
        findMany: vi.fn(async () => [
          { candidateKey: "linkedin:/in/saved-person" },
          { candidateKey: "email:someone" },
        ]),
        count: vi.fn(async () => 2),
      },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async (_query?: unknown): Promise<Array<{ candidateKey: string }>> => []),
      },
      recruitingCalibrationRound: {
        findFirst: vi.fn(async (): Promise<{ approvedAt: Date | null } | null> => null),
      },
      // Searches still running at the provider, by their countdowns.
      externalEffect: {
        findMany: vi.fn(
          async (): Promise<Array<{ idempotencyKey: string; request: unknown }>> => [],
        ),
      },
      message: {
        findFirst: vi.fn(async (): Promise<{ createdAt: Date } | null> => null),
        // The recruiter's recent messages, newest first.
        findMany: vi.fn(async (): Promise<Array<{ createdAt: Date; blocks: unknown }>> => []),
      },
      recruitingRoleRevision: {
        findFirst: vi.fn(async (): Promise<{ createdAt: Date } | null> => null),
      },
    };
  }
  const prepare = (db: ReturnType<typeof fixture>, args: Record<string, unknown>) =>
    prepareAgentRun(db as never, actor, server, "agent_run", args);

  it("resumes only a run this person started", async () => {
    const db = fixture();
    await expect(prepare(db, { runId: "agent_run_mine" })).resolves.toEqual({
      runId: "agent_run_mine",
    });
    await expect(prepare(db, { runId: "agent_run_other" })).rejects.toThrow(/agent_run_mine/);
    await expect(
      prepare(db, { query: "More like these", previousRunId: "agent_run_other" }),
    ).rejects.toThrow(/previousRunId/);
    const scope = receiptScope(db.$queryRaw.mock.calls[0]![0]);
    expect(scope).toMatchObject({ spaceId: "space", userId: "owner" });
    expect(scope).not.toHaveProperty("threadId");
  });

  it("stops reading older runs once the named run is found", async () => {
    const db = fixture();
    const page = Array.from({ length: 20 }, () => started);
    db.$queryRaw.mockImplementation(receiptQuery(() => page) as never);
    await expect(prepare(db, { runId: "agent_run_mine" })).resolves.toEqual({
      runId: "agent_run_mine",
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(receiptScope(db.$queryRaw.mock.calls[0]![0]).limit).toBe(20);
  });

  it("returns people and leaves out people already in the role", async () => {
    const db = fixture();
    await expect(
      prepare(db, { query: "Find 50 people", input: { exclusion: [{ name: "Given" }] } }),
    ).resolves.toEqual({
      query: "Find 50 people",
      outputSchema: AGENT_RUN_PEOPLE_SCHEMA,
      input: {
        exclusion: [
          { name: "Given" },
          { linkedin_url: "https://www.linkedin.com/in/saved-person" },
        ],
      },
    });
    expect(db.recruitingCandidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { roleId: "role-1", role: { id: "role-1", spaceId: "space", userId: "owner" } },
      }),
    );
    // The agent's own format would drop the grade Results shows.
    await expect(
      prepare(fixture(null), { query: "Find", outputSchema: { type: "object" } }),
    ).resolves.toEqual({ query: "Find", outputSchema: AGENT_RUN_PEOPLE_SCHEMA });
  });

  it("keeps every search a small try: 20 people, two dollars, never ultra", async () => {
    const db = fixture(null);
    expect(AGENT_RUN_PEOPLE_SCHEMA.properties.people.maxItems).toBe(20);
    await expect(prepare(db, { query: "Find", effort: "auto" })).resolves.toMatchObject({
      effort: "auto",
      budget: { maxCostDollars: AGENT_RUN_FIND_MAX_COST_USD },
      outputSchema: AGENT_RUN_PEOPLE_SCHEMA,
    });
    // A thousand-person sweep is no longer one run: ultra runs as auto under the same limits.
    await expect(
      prepare(db, { query: "Find 5,000 people", effort: "ultra", budget: { maxCostDollars: 50 } }),
    ).resolves.toMatchObject({
      effort: "auto",
      budget: { maxCostDollars: 2 },
      outputSchema: AGENT_RUN_PEOPLE_SCHEMA,
    });
    await expect(
      prepare(db, { query: "Find", effort: "auto", budget: { maxCostDollars: 1.5 } }),
    ).resolves.toMatchObject({ budget: { maxCostDollars: 1.5 } });
    // Fixed-price efforts take no budget; one the agent sent anyway is dropped.
    const low = await prepare(db, { query: "Find", effort: "low", budget: { maxCostDollars: 3 } });
    expect(low).not.toHaveProperty("budget");
  });

  it("runs people searches only inside a saved role", async () => {
    // Staging a986fe51, feedback-round: the main chat searched itself and nothing was saved.
    const inChat = (groupId: string, roleId: string | null = null) => ({
      run: {
        findFirst: vi.fn(async () => ({ thread: { activeRecruitingRoleId: roleId, groupId } })),
      },
    });
    const check = (db: unknown, tool: string, args: Record<string, unknown>) =>
      requireRoleForPeopleSearch(db as never, actor, server, tool, args);
    const people = { category: "people", query: "Senior SRE Austin" };
    for (const [tool, args] of [
      ["web_search_advanced_exa", people],
      ["web_search_exa", { query: "category:people SRE Austin" }],
      ["agent_run", { query: "SRE" }],
    ] as const)
      await expect(check(inChat("recruiting-global-u"), tool, args)).rejects.toThrow(
        /delegate_to_role/,
      );
    await expect(check(inChat("role-abc"), "web_search_advanced_exa", people)).rejects.toThrow(
      /recruiting_role create/,
    );
    // A saved role, a company search, reading a running agent run, or another chat go ahead.
    await expect(
      check(inChat("role-abc", "role-1"), "web_search_advanced_exa", people),
    ).resolves.toBeUndefined();
    await expect(
      check(inChat("recruiting-global-u"), "web_search_exa", { query: "Austin SaaS companies" }),
    ).resolves.toBeUndefined();
    await expect(
      check(inChat("recruiting-global-u"), "agent_run", { runId: "r1" }),
    ).resolves.toBeUndefined();
    await expect(
      check(inChat("team-x"), "web_search_advanced_exa", people),
    ).resolves.toBeUndefined();
  });

  it("asks each quick people search for at most ten people", async () => {
    // Long-search-finishes 11-15: four searches of 25 saved 64 people for a request of 20.
    const limit = (args: Record<string, unknown>, to = server) =>
      Promise.resolve(limitPeopleSearch(to, "web_search_advanced_exa", args));
    await expect(limit({ category: "people", numResults: 25 })).resolves.toMatchObject({
      numResults: 10,
    });
    await expect(limit({ category: "people" })).resolves.toMatchObject({ numResults: 10 });
    await expect(limit({ category: "people", numResults: 5 })).resolves.toMatchObject({
      numResults: 5,
    });
    // The profiles' full text comes back with the people; one person's lookup keeps its size.
    await expect(limit({ category: "people" })).resolves.toMatchObject({ textMaxCharacters: 6000 });
    await expect(
      limit({
        category: "people",
        query: "https://www.linkedin.com/in/someone",
        textMaxCharacters: 300,
      }),
    ).resolves.toMatchObject({ textMaxCharacters: 300 });
    // Other searches and other servers are left as they are.
    const company = { category: "company", numResults: 25 };
    await expect(limit(company)).resolves.toBe(company);
    const people = { category: "people", numResults: 25 };
    await expect(limit(people, { ...server, endpoint: "https://example.com/mcp" })).resolves.toBe(
      people,
    );
  });

  it("leaves the role's saved people out of a quick people search", async () => {
    // Plays of 11-25: 50–80% of each later search's rows were people an earlier one had saved.
    const db = (roleId: string | null) => ({
      run: {
        findFirst: vi.fn(async () => ({
          threadId: "t",
          thread: { activeRecruitingRoleId: roleId },
        })),
      },
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () => [{ name: "Saved One" }, { name: " " }, { name: "Saved Two" }]),
      },
    });
    const people = { category: "people", query: "q", excludeText: ["Saved One", "Given"] };
    await expect(
      excludeFoundPeople(db("role-1") as never, actor, server, "web_search_advanced_exa", people),
    ).resolves.toEqual({ ...people, excludeText: ["Saved One", "Given", "Saved Two"] });
    // No role, another kind of search: sent as asked.
    await expect(
      excludeFoundPeople(db(null) as never, actor, server, "web_search_advanced_exa", people),
    ).resolves.toBe(people);
    const company = { category: "company", query: "q" };
    await expect(
      excludeFoundPeople(db("role-1") as never, actor, server, "web_search_advanced_exa", company),
    ).resolves.toBe(company);
  });

  it("offers the agent only the options a run keeps: no own format, no people to grade, no ultra", async () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
        effort: { type: "string", enum: ["low", "auto", "ultra"] },
        outputSchema: { type: "object" },
        input: {
          type: "object",
          properties: { data: { type: "array" }, exclusion: { type: "array" } },
          required: ["data"],
        },
      },
      required: ["query", "outputSchema"],
    };
    expect(agentRunSchemaForAgent(server, "agent_run", schema)).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
        effort: { type: "string", enum: ["low", "auto"] },
        input: { type: "object", properties: { exclusion: { type: "array" } }, required: [] },
      },
      required: ["query"],
    });
    expect(agentRunSchemaForAgent(server, "web_search_exa", schema)).toBe(schema);
    // People sent to be graded anyway are left out: a run finds and grades in one go.
    const people = [{ name: "Saved", linkedin_url: "https://www.linkedin.com/in/saved-person" }];
    const prepared = await prepare(fixture(null), { query: "Find", input: { data: people } });
    expect(prepared).toEqual({ query: "Find", input: {}, outputSchema: AGENT_RUN_PEOPLE_SCHEMA });
  });

  it("reads a finished grading run's rows as a page", () => {
    const rows = [{ name: "A", linkedin_url: "https://www.linkedin.com/in/a", match_score: 80 }];
    const result = (status: string, id = "agent_run_1") => ({
      content: [
        { type: "text", text: JSON.stringify({ id, status, output: { structured: { rows } } }) },
      ],
    });
    const read = (raw: unknown) =>
      classifyRecruitingResearchResult(raw, { providerTaskId: "agent_run_1" });
    expect(read(result("completed"))).toMatchObject({ rows, deliveryState: "accepted" });
    expect(read(result("running")).rows).toBeUndefined();
    expect(read(result("completed", "agent_run_2")).rows).toBeUndefined();
  });

  it("records a finished run's cost once, by run", async () => {
    const createMany = vi.fn(async () => ({ count: 1 }));
    const db = { usageRecord: { createMany } };
    const done = (status: string) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: "agent_run_1", status, costDollars: { total: 0.21 } }),
        },
      ],
    });
    const exa = { ...server, slug: "people-search" };
    await recordAgentRunCost(
      db as never,
      { ...actor, botId: "bot", runId: "run" },
      exa,
      "agent_run",
      done("running"),
    );
    expect(createMany).not.toHaveBeenCalled();
    await recordAgentRunCost(
      db as never,
      { ...actor, botId: "bot", runId: "run" },
      exa,
      "agent_run",
      done("completed"),
    );
    expect(createMany).toHaveBeenCalledExactlyOnceWith({
      data: [
        expect.objectContaining({
          provider: "people-search",
          unit: "credits",
          quantity: 0.21,
          costUsd: 0.21,
          costSource: "provider-reported",
          callId: "credits:people-search:agent_run_1",
          runId: "run",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("does not record non-finite or negative provider dollar receipts", async () => {
    const createMany = vi.fn();
    for (const total of ["Infinity", "NaN", -1]) {
      await recordAgentRunCost(
        { usageRecord: { createMany } } as never,
        actor,
        { ...server, slug: "people-search" },
        "agent_run",
        {
          structuredContent: { id: "invalid", status: "completed", costDollars: { total } },
        },
      );
    }
    expect(createMany).not.toHaveBeenCalled();
  });

  it("leaves other tools and services unchanged", async () => {
    const db = fixture();
    const args = { query: "x" };
    await expect(prepareAgentRun(db as never, actor, server, "web_search_exa", args)).resolves.toBe(
      args,
    );
    await expect(
      prepareAgentRun(
        db as never,
        actor,
        { ...server, endpoint: "https://mcp.example.com/mcp" },
        "agent_run",
        args,
      ),
    ).resolves.toBe(args);
  });
});

describe("FullEnrich job ownership", () => {
  const actor = { userId: "owner", spaceId: "space" };
  const server = {
    id: "contact-server",
    revision: 2,
    transport: "streamable_http",
    endpoint: "https://mcp.fullenrich.com/mcp",
  };
  const route = {
    connectorId: "mcp",
    resourceId: server.id,
    resourceRevision: 2,
    toolName: "enrich_bulk",
  };
  const creation = {
    contacts: [{ linkedin_url: "https://linkedin.com/in/example-person" }],
    fields: ["work_email"],
  };
  const request = ["__rakazoCatalogTool", "direct", { route, args: creation }];
  const result = {
    content: [{ type: "text", text: JSON.stringify({ enrichment_id: "owned-job" }) }],
  };
  function fixture(savedRequest: unknown = request, savedResult: unknown = result) {
    return {
      $queryRaw: vi.fn(
        receiptQuery((scope) =>
          scope.spaceId === actor.spaceId && scope.userId === actor.userId
            ? [{ request: savedRequest, result: savedResult }]
            : [],
        ),
      ),
    };
  }
  const authorize = (
    db: ReturnType<typeof fixture>,
    tool = "get_enrichment_results",
    args: Record<string, unknown> = { enrichment_id: "owned-job" },
    who = actor,
    connection = server,
  ) => requireFullEnrichJobOwnership(db as never, who, connection, tool, args);

  it.each(["direct", "connectors_execute_tool", "mcp_execute_tool"])(
    "accepts an owned successful %s creation receipt",
    async (kind) => {
      const saved =
        kind === "direct"
          ? request
          : [
              "__rakazoCatalogTool",
              kind,
              { id: `${server.id}:enrich_bulk`, arguments: creation },
              route,
            ];
      const db = fixture(saved);
      await expect(authorize(db)).resolves.toBeTruthy();
      expect(db.$queryRaw.mock.calls[0]![0].sql).toContain(`e."status" = 'completed'`);
      expect(receiptScope(db.$queryRaw.mock.calls[0]![0])).toMatchObject({
        ...actor,
        serverId: server.id,
        toolName: "enrich_bulk",
      });
    },
  );
  it("reads the person's newest lookup for latest", async () => {
    await expect(
      authorize(fixture(), "get_enrichment_results", { enrichment_id: "latest" }),
    ).resolves.toEqual({ enrichment_id: "owned-job" });
    await expect(
      authorize({ $queryRaw: vi.fn(async () => []) } as never, "get_enrichment_results", {
        enrichment_id: "latest",
      }),
    ).rejects.toThrow();
  });
  it("names the person's own lookups when the id is mistyped", async () => {
    await expect(
      authorize(fixture(), "get_enrichment_results", { enrichment_id: "owned-jbo" }),
    ).rejects.toThrow("Your latest lookups, newest first: owned-job.");
  });
  it("accepts a creation the agent called by the tool's display name", async () => {
    const saved = [
      "__rakazoCatalogTool",
      "connectors_execute_tool",
      { id: "mcp__fullenrich__enrich_bulk", arguments: { data: [{ linkedin_url: "x" }] } },
      route,
    ];
    await expect(authorize(fixture(saved))).resolves.toBeTruthy();
  });
  it.each(["user", "space", "job", "connection", "revision", "read", "error", "malformed"])(
    "does not grant ownership from %s mismatch",
    async (change) => {
      const saved = structuredClone(request);
      const body = saved[2] as { route: typeof route };
      if (change === "connection") body.route.resourceId = "other-server";
      if (change === "revision") body.route.resourceRevision = 1;
      if (change === "read") body.route.toolName = "get_enrichment_results";
      const db = fixture(
        saved,
        change === "error"
          ? { ...result, isError: true }
          : change === "malformed"
            ? { content: [{ type: "text", text: "Job owned-job" }] }
            : result,
      );
      await expect(
        authorize(
          db,
          "get_enrichment_results",
          { enrichment_id: change === "job" ? "foreign-job" : "owned-job" },
          {
            userId: change === "user" ? "other" : actor.userId,
            spaceId: change === "space" ? "other" : actor.spaceId,
          },
        ),
      ).rejects.toThrow();
    },
  );
  it("allows creation and credits but denies unscoped account tools and malformed job reads", async () => {
    const db = fixture();
    await expect(authorize(db, "enrich_bulk", creation)).resolves.toBeTruthy();
    await expect(authorize(db, "get_credits", {})).resolves.toBeTruthy();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    for (const [tool, args] of [
      ["export_enrichment_results", { enrichment_id: "owned-job" }],
      ["get_enrichment_results", {}],
      ["list_enrichments", {}],
      ["enrich_bulk", { ...creation, enrichment_id: "foreign-job" }],
      ["get_credits", { enrichment_id: "foreign-job" }],
    ] as const)
      await expect(authorize(db, tool, args)).rejects.toThrow();
  });
  it("does not apply provider guards to a different configured integration", async () => {
    const db = fixture();
    await expect(
      authorize(db, "custom_tool", {}, actor, {
        ...server,
        endpoint: "https://custom.example.test/mcp",
      }),
    ).resolves.toBeTruthy();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

const source: RecruitingSourceRef = {
  id: "human-message:human",
  kind: "original_material",
  anchor: { kind: "message", messageId: "human", locator: "blocks[0].text" },
  readState: "read",
  readAt: "2026-10-15T00:00:00.000Z",
  quote: "Search this round",
};
const roleText =
  "<recruiting_role>Synthetic role: implemented geometry; 5+ years.</recruiting_role>";
const contextText = `${roleText}\n\nActual memory fragment: show the complete prompt.`;
const context = {
  workspace: {
    role: {
      id: "role",
      revision: 2,
      currentRevisionId: "role-revision",
      spaceId: "space",
      userId: "owner",
      sourceThreadId: "thread",
      title: "Example engineer",
    },
    revision: {
      id: "role-revision",
      roleId: "role",
      revision: 2,
      sourceRefs: [],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
      createdAt: "2026-10-16T18:00:00Z",
      brief: {
        searchFilters: [],
        fields: [
          {
            key: "salary_range",
            value: "GBP 90,000 to 120,000",
            origin: "user_instruction",
            state: "known",
            consequential: true,
            sourceRefIds: ["human"],
          },
          {
            key: "location",
            value: "Unrestricted",
            origin: "user_instruction",
            state: "known",
            consequential: true,
            sourceRefIds: ["human"],
          },
        ],
        questions: [],
        rules: [],
      },
    },
  },
  text: contextText,
  contextArtifact: { artifactId: "context-artifact", sha256: "a".repeat(64) },
  manifest: {
    version: 1,
    actor: { spaceId: "space", userId: "owner" },
    runId: "run",
    threadId: "thread",
    botId: "bot",
    memory: { documents: [] },
    recallScope: null,
    placement: "instructions",
    reason: "synthetic intake",
    sourceMessageId: "human",
    roleId: "role",
    roleRevisionId: "role-revision",
    roleRevision: 2,
    roleText,
    text: contextText,
  },
} as LoadedRecruitingRunContext;
const _request = {
  operation: "create" as const,
  context,
  source,
  intent: { basis: "direct" as const, quote: "Search this round" },
  purpose: "calibration" as const,
  approvalEffectId: "g1-approval",
  route: {
    connectorId: "mcp" as const,
    resourceId: "server",
    resourceRevision: 3,
    toolName: "research" as const,
  },
  instructions: "  Look for engineers.\nPreserve every condition 😀  ",
  output: "  Name, profile, source and unknowns.\n  ",
  recallScope: "  Bay Area first; expand only if asked.  ",
};
const mcp = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
const _sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("stored result page observations", () => {
  it("keeps a page that names another task, or holds no rows, unknown", () => {
    for (const body of [
      { task_id: "other", rows: [] },
      { task_id: "task", state: "working", done: true, rows: [] },
      { task_id: "task", message: "Completed" },
    ])
      expect(
        classifyRecruitingResearchResult(mcp(body), { providerTaskId: "task" }).deliveryState,
      ).toBe("unknown");
  });

  it("retains malformed rows alongside valid candidates for explicit unresolved indexing", () => {
    const rows = [{ name: { value: "Example", source_id: "source" } }, null, "malformed"];
    expect(
      classifyRecruitingResearchResult(mcp({ rows }), { providerTaskId: "task" }),
    ).toMatchObject({ deliveryState: "accepted", rows });
  });

  it("preserves changing raw cells, sources, opaque cursors and real output IDs", () => {
    const rows = [
      {
        name: { value: "Synthetic Person", source_id: "s1" },
        geometry: { value: null, source_id: "s1" },
        _sources: { s1: "https://example.test/profile" },
      },
    ];
    const body = { rows, next_cursor: "  opaque/游标==  ", output_id: "actual-output" };
    const raw = mcp(body);
    const before = JSON.stringify(raw);
    const first = classifyRecruitingResearchResult(raw, { providerTaskId: "task" });
    expect(first).toMatchObject({
      deliveryState: "accepted",
      providerTaskId: "task",
      rows,
      nextCursor: body.next_cursor,
      outputId: "actual-output",
    });
    expect(JSON.stringify(raw)).toBe(before);
    const changed = classifyRecruitingResearchResult(
      mcp({
        ...body,
        rows: [{ ...rows[0], geometry: { value: "New material", source_id: "s1" } }],
      }),
      { providerTaskId: "task" },
    );
    expect(changed.rows).not.toEqual(first.rows);
    expect(changed.nextCursor).toBe(first.nextCursor);
  });

  it("reads a stored refusal as rejected only for its own task", () => {
    expect(
      classifyRecruitingResearchResult(mcp({ error: "out_of_credits", task_id: "known-task" }), {
        providerTaskId: "known-task",
      }),
    ).toMatchObject({ deliveryState: "rejected", providerTaskId: "known-task" });
    expect(
      classifyRecruitingResearchResult(
        mcp({ error: "out_of_credits", task_id: "unrelated-task" }),
        {
          providerTaskId: "known-task",
        },
      ),
    ).toMatchObject({ deliveryState: "unknown", providerTaskId: "known-task" });
  });
});

describe("retained candidate report projection", () => {
  it.each([
    ["rule_hr7_project_evidence", "Project evidence"],
    ["round3_project_evidence", "Project evidence"],
    ["rule_of_thumb", "Rule of thumb"],
    ["round_trip_support", "Round trip support"],
  ])("labels %s without changing the supplied report cell", (key, label) => {
    const cell = {
      value: "  Round 5: reported finding.\nUnchanged conclusion.  ",
      evidence: "Original supporting quote.",
      reasoning: "Original provider explanation.",
      source_id: "reference",
    };
    const row = { [key]: cell, _sources: { reference: "https://example.test/evidence" } };
    const original = structuredClone(row);
    expect(projectRecruitingCandidateReport(row)).toEqual({
      fields: [
        {
          label,
          value: cell.value,
          evidence: cell.evidence,
          reasoning: cell.reasoning,
          sourceUrls: [row._sources.reference],
        },
      ],
      sourceUrls: [row._sources.reference],
    });
    expect(row).toEqual(original);
  });

  it("keeps supplied values, unknowns and report notes while resolving only real source links", () => {
    expect(
      projectRecruitingCandidateReport({
        name: { value: "Synthetic Person", source_id: "profile" },
        years_swe_approx: { value: 6 },
        geometry: {
          value: null,
          absent: true,
          evidence: "No implementation supplied",
          reasoning: "Needs a code sample",
          source_id: "missing",
        },
        interests: { value: ["systems", true, 2, null] },
        sources: {
          value: [
            "https://example.test/project",
            "javascript:alert(1)",
            "https://user:pass@example.test/private",
          ],
        },
        _sources: {
          profile: "https://example.test/profile",
          missing: "source-without-a-link",
          unused: "https://example.test/unused",
        },
        _internal: "hidden",
        task_id: { value: "private-task" },
        artifactId: "private-artifact",
        shard_ids: ["private-shard"],
        request: { value: "private-request" },
        toolName: "private-tool",
        tool_name: "private-tool",
        connectorId: "private-connector",
        resourceId: "private-resource",
        resourceRevision: 8,
        catalogGroup: "private-catalog",
        clientNonce: "private-nonce",
        arbitrary: { nested: { value: "not report text" } },
      }),
    ).toEqual({
      fields: [
        { label: "Name", value: "Synthetic Person", sourceUrls: ["https://example.test/profile"] },
        { label: "Years swe approx", value: "6", sourceUrls: [] },
        {
          label: "Geometry",
          value: null,
          evidence: "No implementation supplied",
          reasoning: "Needs a code sample",
          sourceUrls: [],
        },
        { label: "Interests", value: "systems\ntrue\n2\nnull", sourceUrls: [] },
        {
          label: "Sources",
          value:
            "https://example.test/project\njavascript:alert(1)\nhttps://user:pass@example.test/private",
          sourceUrls: ["https://example.test/project"],
        },
        {
          label: "Arbitrary",
          value: null,
          structuredValue: { nested: { value: "not report text" } },
          sourceIds: [],
          sourceUrls: [],
          sourceUrlsById: {
            profile: ["https://example.test/profile"],
            missing: [],
            unused: ["https://example.test/unused"],
          },
        },
      ],
      sourceUrls: ["https://example.test/profile", "https://example.test/project"],
    });
  });
  it("keeps annotated and multi-URL report text out of links while retaining exact observations", () => {
    const pages =
      "https://example.test/person ; https://code.example.test/project (identity rejected)";
    const inaccessible = "https://blocked.example.test/person (403 Forbidden)";
    const profile = "https://example.test/person?name=Jane%20Doe#bio";
    expect(
      projectRecruitingCandidateReport({
        pages_read: {
          value: pages,
          evidence: "Original page notes",
          reasoning: "Identity is unresolved",
          source_id: "mixed",
        },
        inaccessible_pages: { value: inaccessible, source_id: "archive" },
        profile: { value: profile },
        _sources: { mixed: pages, archive: "https://archive.example.test/person" },
      }),
    ).toEqual({
      fields: [
        {
          label: "Pages read",
          value: pages,
          evidence: "Original page notes",
          reasoning: "Identity is unresolved",
          sourceUrls: [],
        },
        {
          label: "Inaccessible pages",
          value: inaccessible,
          sourceUrls: ["https://archive.example.test/person"],
        },
        { label: "Profile", value: profile, sourceUrls: [profile] },
      ],
      sourceUrls: ["https://archive.example.test/person", profile],
    });
  });
  it("preserves a supplied absence-only flag and its report explanation", () => {
    expect(
      projectRecruitingCandidateReport({
        robotics_multimodal: {
          absent: true,
          reasoning: "No supporting robotics evidence was supplied",
        },
        code_sample: { absent: false, evidence: "A repository link was supplied" },
        arbitrary: { nested: true, reasoning: "Not a scalar report cell" },
      }),
    ).toEqual({
      fields: [
        {
          label: "Robotics multimodal absent",
          value: "true",
          reasoning: "No supporting robotics evidence was supplied",
          sourceUrls: [],
        },
        {
          label: "Code sample absent",
          value: "false",
          evidence: "A repository link was supplied",
          sourceUrls: [],
        },
        {
          label: "Arbitrary",
          value: null,
          structuredValue: { nested: true, reasoning: "Not a scalar report cell" },
          reasoning: "Not a scalar report cell",
          sourceIds: [],
          sourceUrls: [],
          sourceUrlsById: {},
        },
      ],
      sourceUrls: [],
    });
  });
  it.each([null, "malformed", [], { arbitrary: undefined }])(
    "does not invent an empty report for %j",
    (row) => {
      expect(() => projectRecruitingCandidateReport(row)).toThrow();
    },
  );
});

describe("candidate reports from saved people-search pages", () => {
  // 2026-10-26 02:42: every sources read of a quick-search person failed, because the reader only
  // knew research-task pages.
  it("reads a people-search page's row from its own receipt", async () => {
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "people_search",
        request: { operation: "save_search", expectedRoleRevision: 3 },
        sources: [{ effectId: "search-1", toolName: "web_search_exa", host: "search.example" }],
        rows: [
          {
            rowIndex: 0,
            sourceEffectId: "search-1",
            row: { name: "Ada Park", linkedin_url: "https://www.linkedin.com/in/ada" },
          },
          {
            rowIndex: 1,
            sourceEffectId: "search-1",
            row: { name: "Sam Reid", current_title: "Research Scientist" },
          },
        ],
        truncated: false,
      }),
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    const row = { id: "page-artifact", hash } as never;
    const read = createRecruitingCandidateReportReader(
      { prisma: {} as never, artifacts: {} as never },
      { spaceId: "s", userId: "u", email: "", isDeploymentOwner: false },
      "role-1",
      { artifacts: new Map([["page-artifact", { row, bytes }]]) },
    );
    const source = {
      providerTaskId: null,
      taskId: null,
      actionId: null,
      roleRevisionId: "rev-3",
      effectId: "save-1",
      rowIndex: 1,
      artifactRef: { artifactId: "page-artifact", sha256: hash },
      requestCursor: null,
      outputId: null,
      observedAt: "2026-10-26T02:40:37.000Z",
    };
    const { row: saved, report } = await read(source);
    expect(saved).toEqual({ name: "Sam Reid", current_title: "Research Scientist" });
    expect(report).toBeDefined();
    await expect(read({ ...source, rowIndex: 5 })).rejects.toThrow();
  });

  // 2026-10-30 19:23: grade pages from people-search agent runs showed a tier but no reasons.
  it("reads a grading agent run page's row with its reasons", async () => {
    const graded = {
      name: "Ada Park",
      linkedin_url: "https://www.linkedin.com/in/ada",
      match_score: 91,
      match_tier: "Strong",
      fit_reasons: "Leads the USC Korean Student Association",
      concerns: ["Graduation year unknown"],
    };
    const bytes = Buffer.from(
      JSON.stringify({
        request: [
          "__rakazoCatalogTool",
          "direct",
          {
            route: {
              connectorId: "mcp",
              resourceId: "people-search",
              resourceRevision: 1,
              toolName: "agent_run",
            },
            args: { query: "Grade", input: { data: [] } },
          },
        ],
        providerResult: {
          structuredContent: {
            id: "agent_run_1",
            status: "completed",
            output: { structured: { rows: [graded] } },
          },
        },
      }),
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    const read = createRecruitingCandidateReportReader(
      { prisma: {} as never, artifacts: {} as never },
      { spaceId: "s", userId: "u", email: "", isDeploymentOwner: false },
      "role-1",
      {
        artifacts: new Map([
          ["grade-artifact", { row: { id: "grade-artifact", hash } as never, bytes }],
        ]),
      },
    );
    const { row, report } = await read({
      providerTaskId: null,
      taskId: null,
      actionId: null,
      roleRevisionId: "rev-3",
      effectId: "save-2",
      rowIndex: 0,
      artifactRef: { artifactId: "grade-artifact", sha256: hash },
      requestCursor: null,
      outputId: null,
      observedAt: "2026-10-30T19:18:16.000Z",
    });
    expect(row).toEqual(graded);
    expect(JSON.stringify(report)).toContain("Leads the USC Korean Student Association");
  });
});

describe("savedContactLookups", () => {
  it("keeps found emails and which sources already found nothing, by person", async () => {
    const effect = (people: unknown[]) => ({
      request: [
        "__rakazoCatalogTool",
        "direct",
        {
          route: {
            connectorId: "mcp",
            resourceId: "enrich",
            resourceRevision: 1,
            toolName: "native_find_emails",
          },
          args: { people: [] },
        },
      ],
      result: { structuredContent: { people } },
    });
    const findMany = vi.fn(async () => [
      effect([
        {
          linkedin_url: "https://www.linkedin.com/in/no-match",
          emails: [],
          lookups: [
            { provider: "fullenrich", outcome: "failed", detail: "no credits left" },
            { provider: "contactout", outcome: "not_found" },
          ],
        },
      ]),
      effect([
        {
          linkedin_url: "https://www.linkedin.com/in/found",
          emails: [{ address: "a@x.test", type: "work", status: null, provider: "fullenrich" }],
          lookups: [{ provider: "fullenrich", outcome: "found" }],
        },
        {
          linkedin_url: "https://www.linkedin.com/in/no-match",
          emails: [],
          lookups: [{ provider: "leadmagic", outcome: "not_found" }],
        },
      ]),
    ]);
    const saved = await savedContactLookups(
      { $queryRaw: findMany } as never,
      { userId: "user", spaceId: "space" },
      { id: "enrich", revision: 1 },
      "native_find_emails",
    );
    expect([...saved.emails.keys()]).toEqual(["linkedin:/in/found"]);
    // A source that failed (no credits) has not searched yet, so it may still run.
    expect(saved.searched.get("linkedin:/in/no-match")).toEqual(
      new Set(["contactout", "leadmagic"]),
    );
  });

  it("reads every receipt in few pages and shares one read between parallel lists", async () => {
    const findMany = vi.fn(async () => []);
    const receipts = vi.fn(async () => []);
    const mcpServers = vi.fn(async () => [{ id: "enrich", revision: 1 }]);
    const prisma = {
      $queryRaw: receipts,
      externalEffect: { findMany },
      mcpServer: { findMany: mcpServers },
    } as never;
    const actor = { userId: "user", spaceId: "space" };
    const [first, second] = await Promise.all([
      lookedUpContacts(prisma, actor),
      lookedUpContacts(prisma, actor),
    ]);
    expect(mcpServers).toHaveBeenCalledTimes(1);
    // One read of the lookup receipts and one of the imported lists.
    expect(receipts).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(receiptScope((receipts.mock.calls[0] as never)[0]).limit).toBe(500);
    // Each caller adds to its own copy.
    expect(first.emails).not.toBe(second.emails);
    // A later read sees receipts saved since.
    await lookedUpContacts(prisma, actor);
    expect(receipts).toHaveBeenCalledTimes(2);
  });

  // 11-12: a list imported with emails lost them, so Outreach paid for a lookup, found nothing
  // and asked the recruiter for the address the list already had.
  it("counts an imported list's addresses as known contact emails, after lookups", async () => {
    const lookup = {
      request: [
        "__rakazoCatalogTool",
        "direct",
        {
          route: {
            connectorId: "mcp",
            resourceId: "enrich",
            resourceRevision: 1,
            toolName: "native_find_emails",
          },
          args: { people: [] },
        },
      ],
      result: {
        structuredContent: {
          people: [
            {
              linkedin_url: "https://www.linkedin.com/in/found",
              emails: [
                { address: "found@x.test", type: "work", status: null, provider: "fullenrich" },
              ],
              lookups: [{ provider: "fullenrich", outcome: "found" }],
            },
          ],
        },
      },
    };
    const imported = {
      result: {
        candidateRows: [
          { candidateKey: "source-row:import:0", email: "noah@x.test", linkedinUrl: null },
          {
            candidateKey: "linkedin:/in/found",
            email: "list@x.test",
            linkedinUrl: "https://www.linkedin.com/in/found",
          },
          { candidateKey: "linkedin:/in/none" },
        ],
      },
    };
    const prisma = {
      $queryRaw: vi.fn(receiptQuery(() => [lookup])),
      externalEffect: { findMany: vi.fn(async () => [imported]) },
      mcpServer: { findMany: vi.fn(async () => [{ id: "enrich", revision: 1 }]) },
    } as never;
    const { emails } = await lookedUpContacts(prisma, { userId: "list-user", spaceId: "space" });
    expect(bestLookedUpEmail(emails, null, "source-row:import:0")?.address).toBe("noah@x.test");
    // A lookup's result stands; the list only fills in people it lacks.
    expect(
      bestLookedUpEmail(emails, "https://www.linkedin.com/in/found", "linkedin:/in/found")?.address,
    ).toBe("found@x.test");
    expect(bestLookedUpEmail(emails, null, "linkedin:/in/none")).toBeUndefined();
  });
});
