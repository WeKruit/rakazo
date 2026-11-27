import { describe, expect, it } from "vitest";
import { serializeToolResult } from "./pi-runtime.js";

describe("serializeToolResult", () => {
  const skill = {
    name: "large-skill",
    description: "Large skill",
    source: "user",
    readOnly: false,
    content: `---\nname: large-skill\n---\n${"1. Step kept for skill_update.\n".repeat(600)}`,
  };

  it.each(["current", "retrieval"] as const)(
    "returns a large skill read verbatim with the %s strategy",
    (strategy) => {
      const text = serializeToolResult(skill, strategy, "skill_read", { name: skill.name });
      expect(text.length).toBeGreaterThan(12_000);
      expect(JSON.parse(text)).toEqual(skill);
    },
  );

  it("still bounds other large tool results", () => {
    const text = serializeToolResult({ output: "x".repeat(20_000) }, "current", "shell", {});
    expect(text.length).toBeLessThan(20_000);
  });

  it.each(["current", "retrieval"] as const)(
    "returns fresh research preparation context beyond 12k verbatim with %s",
    (strategy) => {
      const result = {
        status: "prepared",
        roleContext: "Exact role criteria and actual adopted preferences.\n".repeat(400),
        contextArtifact: { artifactId: "context", sha256: "a".repeat(64) },
      };
      const text = serializeToolResult(result, strategy, "recruiting_research", {
        operation: "prepare",
      });
      expect(text.length).toBeGreaterThan(12_000);
      expect(JSON.parse(text)).toEqual(result);
    },
  );

  it("keeps unrelated MCP results bounded even when they contain a roleContext field", () => {
    const result = { roleContext: "Untrusted provider text.\n".repeat(1000) };
    const text = serializeToolResult(result, "retrieval", "mcp__other__research", {});
    expect(text.length).toBeLessThan(JSON.stringify(result).length);
  });
});
