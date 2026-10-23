import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { applyMemoryEdit, nativeMemorySaveError, selectMemoryTools } from "./memory-tools.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const allThree = [
  tool("remember"),
  tool("recall_memory"),
  tool("save_memory"),
  tool("forget_memory"),
  tool("shell"),
];

describe("selectMemoryTools", () => {
  it("keeps native remember and drops semantic memory tools when unconfigured", () => {
    const names = selectMemoryTools(allThree, false).map((t) => t.name);
    expect(names).toEqual(["remember", "shell"]);
  });

  it("keeps semantic memory tools and drops native remember when configured", () => {
    const names = selectMemoryTools(allThree, true).map((t) => t.name);
    expect(names).toEqual(["recall_memory", "save_memory", "forget_memory", "shell"]);
  });

  it("is a no-op for tool lists with no memory tools at all", () => {
    const shellOnly = [tool("shell")];
    expect(selectMemoryTools(shellOnly, false)).toEqual(shellOnly);
    expect(selectMemoryTools(shellOnly, true)).toEqual(shellOnly);
  });
});

describe("applyMemoryEdit", () => {
  const doc = "# Notes\n\nPrefers Berlin.\nAvoids agencies.\n";
  it("replaces a unique match and keeps the rest of the document", () => {
    expect(applyMemoryEdit(doc, { find: "Prefers Berlin.", replace: "Prefers Munich." })).toEqual({
      content: "# Notes\n\nPrefers Munich.\nAvoids agencies.\n",
    });
  });
  it("rejects a missing match without echoing the document", () => {
    const result = applyMemoryEdit(doc, { find: "Prefers Paris.", replace: "x" });
    expect(result).toHaveProperty("error");
    expect(JSON.stringify(result)).not.toContain("Berlin");
  });
  it("rejects an ambiguous match", () => {
    expect(applyMemoryEdit(doc, { find: "s", replace: "x" })).toEqual({
      error: expect.stringContaining("more than one place"),
    });
  });
  it("validates edit arguments before any read", () => {
    expect(nativeMemorySaveError({ edit: { find: "a", replace: "b" }, expectedRevision: 1 })).toBe(
      undefined,
    );
    expect(
      nativeMemorySaveError({ edit: { find: "", replace: "b" }, expectedRevision: 1 }),
    ).toMatch(/edit\.find/);
    expect(
      nativeMemorySaveError({
        edit: { find: "a", replace: "b" },
        content: "c",
        expectedRevision: 1,
      }),
    ).toMatch(/either content or edit/);
    expect(nativeMemorySaveError({ expectedRevision: 1 })).toBe("content must be a string");
  });
});
