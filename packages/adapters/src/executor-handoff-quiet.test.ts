import { describe, expect, it } from "vitest";
import { takesBackHandoff } from "./executor.js";

describe("after a handoff", () => {
  it("waiting for the teammate or reading leaves the reply to the teammate", () => {
    // Staging 11-13: Main waited for Outreach's template, then posted it a second time.
    expect(takesBackHandoff("wait_for_work", { mode: "all" }, undefined)).toBe(false);
    expect(takesBackHandoff("read_history", {}, undefined)).toBe(false);
    expect(takesBackHandoff("save_memory", {}, undefined)).toBe(false);
  });

  it("new work takes the request back", () => {
    expect(takesBackHandoff("ask_user", {}, undefined)).toBe(true);
    expect(takesBackHandoff("recruiting_research", { operation: "start" }, undefined)).toBe(true);
  });
});
