import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { userTurnInstructions } from "./executor.js";

// The system prompt and tool list are the cached prefix of every request. Anything that changes
// with the clock or the run (times, ids, counters) belongs in the user turn, not here.
const parts = () => ({
  botInstructions: "You are Main, the recruiting coordinator.",
  groupContext: "Members: Main, Sourcer, Outreach.",
  messagingContext: undefined,
  hasHistoricalContext: true,
  historyRetrievalEnabled: true,
  computerInstruction: "",
  pageBrowserAllowed: false,
  workspaceInstruction: "Use the workspace files.",
  agentEnvironmentInstruction: undefined,
  botDirectory: undefined,
  pluginLine: undefined,
  agentSkillsLine: undefined,
  taughtSkillsLine: undefined,
  replyGuidance: "Reply briefly.",
});

const prefix = () =>
  JSON.stringify({
    system: userTurnInstructions(parts()).filter(Boolean).join("\n\n"),
    tools: builtinAgentTools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  });

afterEach(() => vi.useRealTimers());

describe("prompt prefix", () => {
  it("is byte-identical across time for the same bot and tools", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T09:00:00Z"));
    const morning = prefix();
    vi.setSystemTime(new Date("2026-07-19T23:59:59Z"));
    expect(prefix()).toBe(morning);
  });

  it("carries no timestamps or generated ids", () => {
    const text = prefix();
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\dT\d\d:/);
    expect(text).not.toMatch(/\bc[a-z0-9]{24}\b/);
  });
});
