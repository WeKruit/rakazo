import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { describeToolActivity, parametersFor, serializeToolResult } from "./pi-runtime.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";

it("requires a nonnegative native memory revision in Pi's tool schema", () => {
  const schema = parametersFor(builtinAgentTools.find((tool) => tool.name === "remember")!);
  expect(schema.required).toContain("expectedRevision");
  expect(schema.properties).toHaveProperty(
    "expectedRevision",
    expect.objectContaining({ type: "integer", minimum: 0 }),
  );
});

describe("describeToolActivity", () => {
  it("summarizes builtin tools with their most informative argument", () => {
    expect(describeToolActivity("shell", { command: "pnpm test --filter web" })).toBe(
      "Running: pnpm test --filter web",
    );
    expect(describeToolActivity("read_file", { path: "notes/plan.md" })).toBe(
      "Reading notes/plan.md",
    );
    expect(describeToolActivity("write_file", { path: "out.csv", content: "…" })).toBe(
      "Writing out.csv",
    );
    expect(describeToolActivity("render_plot", { spec: {} })).toBe("Rendering a chart");
    expect(describeToolActivity("add_mcp_server", { name: "Linear" })).toBe(
      "Connecting MCP server: Linear",
    );
    expect(describeToolActivity("run_subagent", { name: "scout", task: "…" })).toBe(
      "Delegating to helper: scout",
    );
    expect(describeToolActivity("create_space", { name: "Customer support" })).toBe(
      "Creating space: Customer support",
    );
    expect(describeToolActivity("web_search", { query: "rakazo agents" })).toBe(
      "Searching the web: rakazo agents",
    );
    expect(describeToolActivity("web_fetch", { url: "https://example.com" })).toBe(
      "Reading page: https://example.com/",
    );
  });

  it("names MCP server and remote tool", () => {
    expect(describeToolActivity("mcp__brex__list_expenses", {})).toBe("Using brex: list_expenses");
    expect(describeToolActivity("mcp__demo-oauth__greet", {})).toBe("Using demo-oauth: greet");
  });

  it("truncates long details and collapses whitespace", () => {
    const long = `x${"y".repeat(200)}`;
    const line = describeToolActivity("shell", { command: `a\n\t${long}` });
    expect(line.length).toBeLessThanOrEqual("Running: ".length + 91);
    expect(line).toContain("…");
    expect(line).not.toContain("\n");
    expect(line).toMatch(/^Running: a x/);
  });

  it("redacts credentials from activity details", () => {
    const token = "fake-token";
    const line = describeToolActivity("shell", {
      command: `curl -H 'Authorization: Bearer ${token}' https://example.test?api_key=fake-key password=fake-password`,
    });

    expect(line).toContain("Bearer [redacted]");
    expect(line).toContain("api_key=[redacted]");
    expect(line).not.toContain(token);
    expect(line).not.toContain("fake-key");
    expect(line).not.toContain("fake-password");
  });

  it("strips signed-URL query and fragment from web_fetch activity", () => {
    const line = describeToolActivity("web_fetch", {
      url: "https://user:secret@cdn.example.test/doc.pdf?X-Amz-Signature=abc123&token=leak#frag",
    });
    expect(line).toBe("Reading page: https://cdn.example.test/doc.pdf");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("X-Amz-Signature");
    expect(line).not.toContain("token=");
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("frag");
  });

  it("does not echo secrets from malformed web_fetch URLs", () => {
    const line = describeToolActivity("web_fetch", {
      url: "https://user:secret@[",
    });
    expect(line).toBe("Reading page: [invalid URL]");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("user:");
  });

  it("falls back to the tool name", () => {
    expect(describeToolActivity("destination_write", undefined)).toBe("Using destination_write");
  });
});

describe("serializeToolResult", () => {
  it.each(["current", "retrieval"] as const)(
    "projects an exact duplicate MCP text payload once before the %s limit without changing the receipt",
    (strategy) => {
      const structuredContent = { data: { note: "x".repeat(6_500) } };
      const content = [{ type: "text", text: JSON.stringify(structuredContent) }];
      const result = Object.freeze({
        content,
        structuredContent,
        isError: true,
        _meta: { cursor: 2 },
        extra: "retained",
      });
      expect(JSON.stringify(result).length).toBeGreaterThan(TOOL_RESULT_TEXT_LIMIT);

      const serialized = serializeToolResult(result, strategy, "mcp__service__read", {});

      expect(JSON.parse(serialized)).toEqual({
        structuredContent,
        isError: true,
        _meta: { cursor: 2 },
        extra: "retained",
      });
      expect(result.content).toBe(content);
      expect(result.content[0]?.text).toBe(JSON.stringify(structuredContent));
    },
  );

  const structuredContent = { value: "retained" };
  const exact = { type: "text", text: JSON.stringify(structuredContent) };
  it.each([
    { structuredContent, content: [{ type: "text", text: '{ "value": "retained" }' }] },
    { structuredContent, content: [exact, { type: "text", text: "another block" }] },
    { structuredContent, content: [exact, { type: "image", data: "AA==", mimeType: "image/png" }] },
    { structuredContent, content: [{ ...exact, annotations: { audience: ["user"] } }] },
    { content: [exact], isError: false },
    { structuredContent, content: "unknown content shape" },
    "unknown result",
  ])("preserves non-duplicate, multipart, annotated and unknown results: %j", (result) => {
    expect(serializeToolResult(result, "current", "mcp__service__read", {})).toBe(
      JSON.stringify(result),
    );
  });

  it("still applies the existing limit when the deduplicated projection is too large", () => {
    const structuredContent = { value: "x".repeat(TOOL_RESULT_TEXT_LIMIT) };
    const result = {
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    };
    const projected = JSON.stringify({ structuredContent });
    expect(serializeToolResult(result, "current", "mcp__service__read", {})).toBe(
      `${projected.slice(0, TOOL_RESULT_TEXT_LIMIT)}…`,
    );
  });
});
