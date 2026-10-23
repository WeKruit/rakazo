import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isBackgroundRunTrigger,
  isConversationalRun,
  RUN_COST_LIMIT_USD,
  RUN_WALL_CLOCK_LIMIT_MS,
  runBudgetExceeded,
  runBudgetStopText,
} from "./run-state.js";

describe("run state machine", () => {
  it("allows takeover resume onto a lease", () => {
    expect(canTransition("waiting_takeover", "leased")).toBe(true);
    expect(canTransition("waiting_takeover", "running")).toBe(false);
  });

  it("withholds user steering from routine, webhook, creation, and peer-message turns", () => {
    expect(isConversationalRun("user")).toBe(true);
    expect(isConversationalRun("follow_up")).toBe(true);
    expect(isConversationalRun("messaging")).toBe(true);
    expect(isConversationalRun("routine")).toBe(false);
    expect(isConversationalRun("webhook")).toBe(false);
    expect(isConversationalRun("created")).toBe(false);
    expect(isConversationalRun("tickets")).toBe(false);
    expect(isConversationalRun("bot_message")).toBe(false);
  });

  it("marks ticket runs as background work that stays out of the chat", () => {
    expect(isBackgroundRunTrigger("tickets")).toBe(true);
    expect(isBackgroundRunTrigger("user")).toBe(false);
    expect(isBackgroundRunTrigger("routine")).toBe(false);
    expect(isBackgroundRunTrigger(null)).toBe(false);
  });

  it("rejects rewriting a completed run", () => {
    expect(() => assertTransition("completed", "running")).toThrow(/illegal/i);
  });

  it("never leaves a terminal state except failed retry", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("completed" as const, "cancelled" as const),
        fc.constantFrom(
          "queued" as const,
          "leased" as const,
          "running" as const,
          "waiting_input" as const,
          "completed" as const,
        ),
        (from, to) => {
          expect(canTransition(from, to)).toBe(false);
        },
      ),
    );
  });
});

describe("run budget guardrails", () => {
  it("names the first limit crossed and stays quiet under both", () => {
    expect(runBudgetExceeded({ costUsd: RUN_COST_LIMIT_USD - 0.01, elapsedMs: 0 })).toBeNull();
    expect(runBudgetExceeded({ costUsd: RUN_COST_LIMIT_USD, elapsedMs: 0 })).toBe("cost");
    expect(runBudgetExceeded({ costUsd: 0, elapsedMs: RUN_WALL_CLOCK_LIMIT_MS })).toBe("time");
    expect(runBudgetExceeded({ costUsd: 1, elapsedMs: 1 }, { costUsd: 1, wallClockMs: 1 })).toBe(
      "cost",
    );
  });

  it("tells the user which limit stopped the run and what was done", () => {
    expect(runBudgetStopText("cost", { costUsd: 5.5, elapsedMs: 0, toolCalls: 1 })).toContain(
      "cost limit (about $5.50 spent) after 1 tool call.",
    );
    expect(
      runBudgetStopText("time", { costUsd: 0, elapsedMs: 7_200_000, toolCalls: 12 }),
    ).toContain("time limit (120 minutes) after 12 tool calls.");
  });
});

it("summarizes saved recruiting results and the persisted next step at the budget limit", () => {
  const text = runBudgetStopText(
    "cost",
    { costUsd: 5.5, elapsedMs: 0, toolCalls: 3 },
    {
      savedCandidates: 10,
      nextStep: "收集校准反馈",
    },
  );
  expect(text).toContain("10 saved candidate profiles");
  expect(text).toContain("Next step: 收集校准反馈");
  expect(text).not.toContain("Everything completed so far is above");
});
