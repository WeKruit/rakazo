import { createHash } from "node:crypto";
import type { RecruitingSourceRef } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { LoadedRecruitingRunContext } from "./recruiting-context.js";
import {
  buildRecruitingResearchRequest,
  classifyRecruitingResearchResult,
  readRecruitingResearchRequest,
} from "./recruiting-research.js";

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
      expect(() => buildRecruitingResearchRequest({ ...request, context: updated })).toThrow(/G0/);
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
