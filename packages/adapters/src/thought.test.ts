import { describe, expect, it } from "vitest";
import { sanitizeThought, THOUGHT_MAX_CHARS } from "./thought.js";

describe("sanitizeThought", () => {
  it("keeps the first meaningful line of a reasoning summary", () => {
    expect(
      sanitizeThought("**Checking the candidate list**\n\nI should look at the shortlist."),
    ).toBe("Checking the candidate list");
  });
  it("strips vendor names, tool names and ids", () => {
    const out = sanitizeThought(
      "Calling mcp__instantly__list_campaigns and recruiting_candidates via the Instantly API for lead ck9x2m4q8p0000abcd1234efgh (Cal.com, Gmail) next",
      ["recruiting_candidates"],
    );
    expect(out).not.toMatch(/instantly|cal\.com|gmail|api|mcp__|recruiting_candidates|ck9x2m4q8p/i);
    expect(out).toBe("Calling and via the for lead next");
  });
  it("truncates at 200 characters", () => {
    const out = sanitizeThought("word ".repeat(100));
    expect(out.length).toBe(THOUGHT_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns an empty string when nothing user-safe remains", () => {
    expect(sanitizeThought("API")).toBe("");
    expect(sanitizeThought("")).toBe("");
  });
});
