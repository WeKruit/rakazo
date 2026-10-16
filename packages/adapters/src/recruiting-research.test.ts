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
const roleText = "<recruiting_role>Exact role: implemented geometry; 7 years.</recruiting_role>";
const contextText = `${roleText}\n\nActual memory fragment: show the complete prompt.`;
const context = {
  workspace: {
    role: { id: "role", revision: 2, currentRevisionId: "role-revision" },
    revision: { id: "role-revision", roleId: "role", revision: 2 },
  },
  text: contextText,
  contextArtifact: { artifactId: "context-artifact", sha256: "a".repeat(64) },
  manifest: {
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
  route: {
    connectorId: "mcp" as const,
    resourceId: "server",
    resourceRevision: 3,
    toolName: "research" as const,
  },
  instructions: "  Look for engineers.\n保留所有条件 😀  ",
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
      roleId: "role",
      roleRevisionId: "role-revision",
      roleRevision: 2,
      source,
      contextArtifact: context.contextArtifact,
    });
    expect(loaded.args.prompt).toContain("do not change qualification");
    expect(loaded.args.prompt).not.toContain("maximum years");
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

  it.each([
    (m: Record<string, unknown>) => ({ ...m, arbitrary: true }),
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
