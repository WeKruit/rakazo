import { createHash } from "node:crypto";
import type { RecruitingSourceRef } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LoadedRecruitingRunContext } from "./recruiting-context.js";
import {
  buildRecruitingResearchRequest,
  classifyRecruitingResearchResult,
  createRecruitingCandidateReportReader,
  projectRecruitingCandidateReport,
  readRecruitingResearchRequest,
  requireAutumnTaskOwnership,
  requireFullEnrichJobOwnership,
} from "./recruiting-research.js";

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
      externalEffect: {
        findMany: vi.fn(async ({ where }) =>
          where.spaceId === actor.spaceId &&
          where.run.spaceId === actor.spaceId &&
          where.run.userId === actor.userId
            ? [{ request: savedRequest, result: savedResult }]
            : [],
        ),
      },
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
      await expect(authorize(db)).resolves.toBeUndefined();
      expect(db.externalEffect.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "completed",
            spaceId: actor.spaceId,
            run: actor,
          }),
        }),
      );
    },
  );
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
    await expect(authorize(db, "enrich_bulk", creation)).resolves.toBeUndefined();
    await expect(authorize(db, "get_credits", {})).resolves.toBeUndefined();
    expect(db.externalEffect.findMany).not.toHaveBeenCalled();
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
    ).resolves.toBeUndefined();
    expect(db.externalEffect.findMany).not.toHaveBeenCalled();
  });
});

describe("Autumn task ownership", () => {
  const actor = { userId: "owner", spaceId: "space" };
  const server = {
    id: "autumn-server",
    revision: 2,
    transport: "streamable_http",
    endpoint: "https://api.autumn.ai/mcp",
  };
  const route = {
    connectorId: "mcp",
    resourceId: server.id,
    resourceRevision: 2,
    toolName: "research",
  };
  const direct = ["__rakazoCatalogTool", "direct", { route, args: { prompt: "Find engineers" } }];
  function fixture(
    request: unknown = direct,
    result: unknown = { structuredContent: { task_id: "owned-task" } },
  ) {
    return {
      recruitingResearchTask: { findFirst: vi.fn(async () => null) },
      externalEffect: {
        findMany: vi.fn(async ({ where }) =>
          where.spaceId === actor.spaceId &&
          where.run.spaceId === actor.spaceId &&
          where.run.userId === actor.userId
            ? [{ request, result }]
            : [],
        ),
      },
    };
  }
  const authorize = (
    db: ReturnType<typeof fixture>,
    tool = "get_task",
    args: Record<string, unknown> = { task_id: "owned-task" },
    context = actor,
    connection = server,
  ) => requireAutumnTaskOwnership(db as never, context, connection, tool, args);

  it.each(["get_task", "get_rows", "reply", "stop_task", "continue_with_file"])(
    "reuses an owned native creation receipt for %s",
    async (tool) => {
      await expect(authorize(fixture(), tool)).resolves.toBeUndefined();
    },
  );
  it.each(["connectors_execute_tool", "mcp_execute_tool"])(
    "accepts the canonical %s creation receipt",
    async (tool) => {
      const request = [
        "__rakazoCatalogTool",
        tool,
        { id: `${server.id}:research`, arguments: { prompt: "Find engineers" } },
        route,
      ];
      await expect(authorize(fixture(request))).resolves.toBeUndefined();
    },
  );
  it.each(["user", "space", "task", "connection", "revision", "read", "error", "malformed"])(
    "does not grant ownership from %s mismatch",
    async (change) => {
      const request = structuredClone(direct);
      const body = request[2] as { route: typeof route };
      if (change === "connection") body.route.resourceId = "other-server";
      if (change === "revision") body.route.resourceRevision = 1;
      if (change === "read") body.route.toolName = "get_task";
      const db = fixture(
        request,
        change === "error"
          ? { isError: true, structuredContent: { task_id: "owned-task" } }
          : change === "malformed"
            ? { content: [{ type: "text", text: "Task owned-task" }] }
            : undefined,
      );
      await expect(
        authorize(
          db,
          "get_rows",
          { task_id: change === "task" ? "foreign-task" : "owned-task" },
          {
            userId: change === "user" ? "other-user" : actor.userId,
            spaceId: change === "space" ? "other-space" : actor.spaceId,
          },
        ),
      ).rejects.toThrow();
    },
  );
  it("accepts an existing actor-scoped native research task", async () => {
    const db = fixture();
    db.recruitingResearchTask.findFirst.mockResolvedValue({ id: "native-task" } as never);
    await expect(authorize(db)).resolves.toBeUndefined();
    expect(db.recruitingResearchTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          providerTaskId: "owned-task",
          mcpServerId: server.id,
          serverRevision: 2,
          role: actor,
          createdByRun: actor,
        }),
      }),
    );
    expect(db.externalEffect.findMany).not.toHaveBeenCalled();
  });
  it.each(["list_tasks", "get_team", "get_usage", "invite_member", "unknown"])(
    "denies account-wide or unsupported %s before querying receipts",
    async (tool) => {
      const db = fixture();
      await expect(authorize(db, tool, {})).rejects.toThrow(/Listing all research is unavailable/i);
      expect(db.externalEffect.findMany).not.toHaveBeenCalled();
    },
  );
  it("does not constrain other MCP providers or require a task for a new research call", async () => {
    const db = fixture();
    await expect(authorize(db, "research", { prompt: "Find engineers" })).resolves.toBeUndefined();
    await expect(authorize(db, "credits", {})).resolves.toBeUndefined();
    await expect(
      authorize(db, "list_tasks", {}, actor, { ...server, endpoint: "https://mcp.example.test" }),
    ).resolves.toBeUndefined();
    expect(db.externalEffect.findMany).not.toHaveBeenCalled();
    await expect(
      authorize(db, "research", { prompt: "Find engineers", task_id: "foreign-task" }),
    ).rejects.toThrow();
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
        confirmation: {
          revision: 2,
          userId: "owner",
          messageId: "confirmation",
          confirmedAt: "2026-10-16T18:00:00Z",
        },
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
const request = {
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
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("frozen recruiting research requests", () => {
  it("freezes the actual UTF-8 request and exact role, memory and desired text", () => {
    const built = buildRecruitingResearchRequest(request);
    expect(built.sha256).toBe(sha256(built.bytes));
    expect(built.bytes.equals(Buffer.from(JSON.stringify(built.manifest), "utf8"))).toBe(true);
    const loaded = readRecruitingResearchRequest(built.bytes, built.sha256);
    expect(loaded).toEqual(built.manifest);
    expect(loaded.args).toEqual({ prompt: expect.stringContaining(contextText) });
    if (!("prompt" in loaded.args)) throw new Error("Expected research prompt");
    for (const text of [request.instructions, request.output, request.recallScope])
      expect(loaded.args.prompt).toContain(text);
    expect(loaded).toMatchObject({
      version: 3,
      candidateOutputSchema: "candidate_output_v1",
      purpose: "calibration",
      approvalEffectId: "g1-approval",
      roleId: "role",
      roleRevisionId: "role-revision",
      roleRevision: 2,
      source,
      contextArtifact: context.contextArtifact,
    });
    expect(loaded.args.prompt).toContain("do not change qualification");
    expect(loaded.args.prompt).toContain("Research purpose:\ncalibration");
    expect(loaded.args.prompt).toContain("linkedin_url");
    expect(loaded.args.prompt).toContain("evidence_urls");
    expect(loaded.args.prompt).not.toContain("maximum years");
  });

  it("reads immutable v2 requests without inventing a candidate output schema", () => {
    const built = buildRecruitingResearchRequest(request);
    const legacy = JSON.parse(built.bytes.toString("utf8"));
    legacy.version = 2;
    delete legacy.candidateOutputSchema;
    legacy.args.prompt = legacy.args.prompt.split("\n\nCanonical candidate output schema:")[0];
    const bytes = Buffer.from(JSON.stringify(legacy));
    expect(readRecruitingResearchRequest(bytes, sha256(bytes))).toEqual(legacy);
    expect(legacy).not.toHaveProperty("candidateOutputSchema");
  });

  it("continues only the stored provider task with the complete frozen message", () => {
    const built = buildRecruitingResearchRequest({
      ...request,
      operation: "continue",
      providerTaskId: "provider-task",
      route: { ...request.route, toolName: "reply" },
    });
    expect(built.manifest.args).toEqual({
      task_id: "provider-task",
      message: expect.stringContaining(contextText),
    });
    expect(readRecruitingResearchRequest(built.bytes, built.sha256)).toEqual(built.manifest);
  });

  it("rejects tampered bytes before parsing", () => {
    const built = buildRecruitingResearchRequest(request);
    expect(() =>
      readRecruitingResearchRequest(Buffer.concat([built.bytes, Buffer.from(" ")]), built.sha256),
    ).toThrow(/hash/i);
  });

  it.each(["create", "continue"] as const)(
    "reads immutable v1 %s requests without inferring purpose or approval",
    (operation) => {
      const built = buildRecruitingResearchRequest(
        operation === "create"
          ? request
          : {
              ...request,
              operation,
              providerTaskId: "provider-task",
              route: { ...request.route, toolName: "reply" },
            },
      );
      const legacy = JSON.parse(built.bytes.toString("utf8"));
      legacy.version = 1;
      delete legacy.purpose;
      delete legacy.approvalEffectId;
      delete legacy.candidateOutputSchema;
      legacy.args[operation === "create" ? "prompt" : "message"] = [
        contextText,
        `Research instructions:\n${request.instructions}`,
        `Requested output:\n${request.output}`,
        `Recall scope for this round:\n${request.recallScope}`,
        "The role criteria remain authoritative. Recall scope and output instructions do not change qualification. Preserve missing evidence as unknown; provider labels do not establish qualification.",
      ].join("\n\n");
      const bytes = Buffer.from(JSON.stringify(legacy), "utf8");
      const loaded = readRecruitingResearchRequest(bytes, sha256(bytes));
      expect(loaded).toEqual(legacy);
      expect(loaded).not.toHaveProperty("purpose");
      expect(loaded).not.toHaveProperty("approvalEffectId");
      expect(bytes.toString("utf8")).toBe(JSON.stringify(legacy));
    },
  );

  it.each([
    (m: Record<string, unknown>) => ({ ...m, arbitrary: true }),
    (m: Record<string, unknown>) => ({ ...m, purpose: undefined }),
    (m: Record<string, unknown>) => ({ ...m, approvalEffectId: undefined }),
    (m: Record<string, unknown>) => ({ ...m, purpose: "scale" }),
    (m: Record<string, unknown>) => ({ ...m, approvalEffectId: " " }),
    (m: Record<string, unknown>) => ({ ...m, version: 1 }),
    (m: Record<string, unknown>) => ({ ...m, args: { prompt: "Conditions omitted" } }),
    (m: Record<string, unknown>) => ({ ...m, route: { ...request.route, toolName: "reply" } }),
    (m: Record<string, unknown>) => ({ ...m, route: { ...request.route, resourceRevision: "3" } }),
    (m: Record<string, unknown>) => ({
      ...m,
      args: { prompt: (m.args as { prompt: string }).prompt, count: 10 },
    }),
    (m: Record<string, unknown>) => ({
      ...m,
      contextArtifact: { artifactId: "context", sha256: "bad" },
    }),
  ])("rejects a rehashed but internally invalid closed manifest %#", (tamper) => {
    const built = buildRecruitingResearchRequest(request);
    const bytes = Buffer.from(JSON.stringify(tamper(built.manifest)), "utf8");
    expect(() => readRecruitingResearchRequest(bytes, sha256(bytes))).toThrow();
  });

  it.each([
    { instructions: " \n " },
    { output: " " },
    { recallScope: " " },
    { purpose: undefined },
    { purpose: "other" },
    { approvalEffectId: undefined },
    { approvalEffectId: " " },
    { intent: { basis: "inferred", quote: source.quote! } },
    { source: { ...source, quote: "Another instruction" } },
    { context: { ...context, text: "Truncated role" } },
    { context: { ...context, manifest: { ...context.manifest, roleText: "" } } },
    {
      context: {
        ...context,
        workspace: { ...context.workspace, role: { ...context.workspace.role, revision: 3 } },
      },
    },
  ])("rejects an invalid preparation %#", (invalid) => {
    expect(() =>
      buildRecruitingResearchRequest({ ...request, ...invalid } as typeof request),
    ).toThrow();
  });
});

describe("recruiting MCP result observations", () => {
  it("accepts a real task ID from structured content or a complete JSON text block", () => {
    for (const raw of [
      { structuredContent: { task_id: "provider-task", status: "accepted" } },
      mcp({ task_id: "provider-task", state: "submitted", done: false }),
    ]) {
      expect(classifyRecruitingResearchResult(raw, { operation: "create" })).toMatchObject({
        deliveryState: "accepted",
        providerTaskId: "provider-task",
        done: false,
        providerApplicationConfirmed: false,
        automaticRetry: false,
      });
    }
  });

  it.each([
    { content: [{ type: "text", text: "Created task_id=provider-task; it is working." }] },
    { content: [{ type: "text", text: 'prefix {"task_id":"provider-task"}' }] },
    { task_id: "provider-task" },
    mcp({ task_id: " " }),
    mcp({ status: "accepted" }),
    { isError: true, structuredContent: { task_id: "provider-task", status: "accepted" } },
    {
      structuredContent: { task_id: "first" },
      content: [{ type: "text", text: '{"task_id":"second"}' }],
    },
  ])("keeps an unproven or conflicting creation unknown %#", (raw) => {
    expect(classifyRecruitingResearchResult(raw, { operation: "create" })).toMatchObject({
      deliveryState: "unknown",
      providerApplicationConfirmed: false,
      automaticRetry: false,
    });
  });

  it("accepts an explicit queued continuation without claiming completion or application", () => {
    expect(
      classifyRecruitingResearchResult(mcp({ status: "accepted", activity: "queued" }), {
        operation: "continue",
        providerTaskId: "original-task",
      }),
    ).toMatchObject({
      deliveryState: "accepted",
      providerTaskId: "original-task",
      observedProviderState: "queued",
      done: false,
      providerApplicationConfirmed: false,
    });
    expect(
      classifyRecruitingResearchResult(mcp({ task_id: "different", status: "accepted" }), {
        operation: "continue",
        providerTaskId: "original-task",
      }).deliveryState,
    ).toBe("unknown");
    expect(
      classifyRecruitingResearchResult(mcp({ message: "Queued" }), {
        operation: "continue",
        providerTaskId: "original-task",
      }).deliveryState,
    ).toBe("unknown");
  });

  it("does not label a queued acknowledgement completed", () => {
    expect(
      classifyRecruitingResearchResult(mcp({ status: "accepted", done: true }), {
        operation: "continue",
        providerTaskId: "task",
      }).deliveryState,
    ).toBe("unknown");
  });

  it("requires creation-specific non-delivery proof for ambiguous server errors", () => {
    const raw = mcp({ error: "internal_error", task_created: false });
    expect(classifyRecruitingResearchResult(raw, { operation: "create" }).deliveryState).toBe(
      "rejected",
    );
    expect(
      classifyRecruitingResearchResult(raw, { operation: "continue", providerTaskId: "task" })
        .deliveryState,
    ).toBe("unknown");
    expect(
      classifyRecruitingResearchResult(
        mcp({ error: "internal_error", task_created: false, task_id: "task" }),
        { operation: "create" },
      ).deliveryState,
    ).toBe("unknown");
  });

  it.each([
    ["submitted", false],
    ["working", false],
    ["input-required", true],
    ["completed", true],
    ["canceled", true],
    ["failed", true],
  ])("records explicit %s status without treating acceptance as completion", (state, done) => {
    expect(
      classifyRecruitingResearchResult(mcp({ task_id: "task", state, done }), {
        operation: "status",
        providerTaskId: "task",
      }),
    ).toMatchObject({
      deliveryState: "accepted",
      observedProviderState: state,
      done,
      providerApplicationConfirmed: false,
    });
  });

  it("rejects contradictory status, foreign identity and narrative completion", () => {
    for (const body of [
      { task_id: "task", state: "working", done: true },
      { task_id: "other", state: "completed", done: true },
      { task_id: "task", message: "Completed" },
    ])
      expect(
        classifyRecruitingResearchResult(mcp(body), { operation: "status", providerTaskId: "task" })
          .deliveryState,
      ).toBe("unknown");
  });

  it("retains malformed rows alongside valid candidates for explicit unresolved indexing", () => {
    const rows = [{ name: { value: "Example", source_id: "source" } }, null, "malformed"];
    expect(
      classifyRecruitingResearchResult(mcp({ rows }), {
        operation: "rows",
        providerTaskId: "task",
      }),
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
    const first = classifyRecruitingResearchResult(raw, {
      operation: "rows",
      providerTaskId: "task",
    });
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
      { operation: "rows", providerTaskId: "task" },
    );
    expect(changed.rows).not.toEqual(first.rows);
    expect(changed.nextCursor).toBe(first.nextCursor);
  });

  it.each(["12", -1, Number.POSITIVE_INFINITY, null])(
    "does not invent numeric or per-person usage from %j",
    (credits_used) => {
      expect(
        classifyRecruitingResearchResult(
          { structuredContent: { task_id: "task", credits_used } },
          { operation: "create" },
        ).usage,
      ).toBeNull();
    },
  );

  it("records only explicitly reported task credits", () => {
    expect(
      classifyRecruitingResearchResult(
        mcp({ task_id: "task", credits_used: 12, progress: { rows: 4 } }),
        { operation: "create" },
      ).usage,
    ).toEqual([{ scope: "task", unit: "credits", amount: 12 }]);
  });

  it.each([
    "out_of_credits",
    "invalid_request",
    "unauthorized",
    "task_executing",
    "task_in_cron_mode",
    "task_not_found",
    "task_exists",
    "auth_unavailable",
  ])("recognizes a structured %s refusal without scheduling retries", (error) => {
    expect(
      classifyRecruitingResearchResult(
        mcp({
          error,
          message: "Request refused",
          retryable: true,
          request_id: "synthetic-request",
          retry_after: 5,
        }),
        { operation: "create" },
      ),
    ).toMatchObject({
      deliveryState: "rejected",
      refusalCode: error,
      retryAfterSeconds: 5,
      automaticRetry: false,
    });
  });

  it.each([
    { error: "out_of_credits", task_id: "not-created" },
    { error: "invalid_request", task_id: "not-created", task_created: false },
    { error: "internal_error", task_id: "not-created", task_created: false },
    { task_id: "not-created", task_created: false },
  ])("never binds a returned task ID from refused or unproven creation %#", (body) => {
    const result = classifyRecruitingResearchResult(mcp(body), { operation: "create" });
    expect(result.providerTaskId).toBeNull();
    expect(result.deliveryState).not.toBe("accepted");
    expect(result.automaticRetry).toBe(false);
  });

  it.each(["continue", "status", "rows"] as const)(
    "retains only the known original task ID on a refused %s",
    (operation) => {
      expect(
        classifyRecruitingResearchResult(mcp({ error: "out_of_credits", task_id: "known-task" }), {
          operation,
          providerTaskId: "known-task",
        }),
      ).toMatchObject({
        deliveryState: "rejected",
        providerTaskId: "known-task",
        automaticRetry: false,
      });
      expect(
        classifyRecruitingResearchResult(
          mcp({ error: "out_of_credits", task_id: "unrelated-task" }),
          {
            operation,
            providerTaskId: "known-task",
          },
        ),
      ).toMatchObject({ deliveryState: "unknown", providerTaskId: "known-task" });
    },
  );

  it.each([
    { error: "Connection interrupted" },
    mcp({ error: "internal_error", task_id: "known-task", retryable: true }),
    mcp({ error: "service_unavailable", retryable: true }),
    mcp({ error: "out_of_credits", task_created: true }),
    { isError: true, content: [{ type: "text", text: "out_of_credits" }] },
  ])("retains uncertain dispatched failures as unknown %#", (raw) => {
    expect(classifyRecruitingResearchResult(raw, { operation: "create" })).toMatchObject({
      deliveryState: "unknown",
      automaticRetry: false,
    });
  });
});

describe("confirmed brief adoption", () => {
  it("freezes confirmed feedback rules into the actual provider search text", () => {
    const updated = structuredClone(context);
    updated.workspace.revision.brief!.rules = [
      {
        criterionId: "production-ownership",
        origin: "user_instruction",
        effect: "flag",
        sourceRefIds: ["feedback-message"],
      },
    ];
    const feedback = {
      ...source,
      id: "feedback-message",
      quote: "Prefer engineers who have operated production services.",
    };
    updated.workspace.revision = {
      ...updated.workspace.revision,
      sourceRefs: [feedback],
      criteria: [
        {
          id: "production-ownership",
          priority: "preferred",
          expression: { kind: "atom", id: "operated-production", statement: feedback.quote },
          sourceRefs: [feedback],
          definitionQuestions: [],
        },
      ],
    };
    updated.manifest.roleText = `<recruiting_role>${JSON.stringify(updated.workspace)}</recruiting_role>`;
    updated.text = updated.manifest.roleText;
    updated.manifest.text = updated.text;
    const built = buildRecruitingResearchRequest({ ...request, context: updated });
    expect("prompt" in built.manifest.args && built.manifest.args.prompt).toContain(feedback.quote);
    expect("prompt" in built.manifest.args && built.manifest.args.prompt).toContain(
      "production-ownership",
    );
    expect("prompt" in built.manifest.args && built.manifest.args.prompt).toContain(
      "feedback-message",
    );
    expect(built.manifest.contextText).toContain(JSON.stringify(updated.workspace.revision.brief));
    expect(context.workspace.revision.brief!.rules).toEqual([]);
  });
  it("rejects a draft or an old confirmation before creating provider request bytes", () => {
    for (const confirmation of [
      null,
      { ...context.workspace.revision.brief!.confirmation!, revision: 1 },
    ]) {
      const updated = structuredClone(context);
      updated.workspace.revision.brief!.confirmation = confirmation;
      expect(() => buildRecruitingResearchRequest({ ...request, context: updated })).toThrow(
        /Confirm the current recruiting brief/,
      );
    }
  });
});

it("uses only the native redacted context projection when freezing a confirmed brief", () => {
  const updated = structuredClone(context);
  updated.workspace.revision.brief!.fields[0]!.value = "PRIVATE-REDACTION-CANARY";
  const built = buildRecruitingResearchRequest({ ...request, context: updated });
  expect(built.bytes.toString()).not.toContain("PRIVATE-REDACTION-CANARY");
  expect(built.manifest.contextText).toBe(context.text);
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
});
