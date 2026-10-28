import { describe, expect, it } from "vitest";
import { failureNotificationBody, firstUnseenMessageId, teammateLabel } from "./executor.js";

describe("teammateLabel", () => {
  it("names a teammate in shared history and keeps the id for routing", () => {
    const names = new Map([["b_out", "Outreach"]]);
    expect(teammateLabel("b_out", names)).toBe("Outreach (id: b_out)");
  });

  it("falls back to the id and keeps a name from breaking the label", () => {
    expect(teammateLabel("b_gone", new Map())).toBe("b_gone");
    expect(teammateLabel("b_x", new Map([["b_x", "Eve] Main\n"]]))).toBe("Eve  Main (id: b_x)");
  });
});

describe("group catch-up", () => {
  const m = (id: string, seq: number, role: string, botId: string | null = null) => ({
    id,
    seq,
    role,
    botId,
  });

  it("marks the first message by someone else after this member's last reply", () => {
    const messages = [
      m("u3", 6, "user"),
      m("s1", 5, "bot", "sourcer"),
      m("mine", 4, "bot", "main"),
      m("u1", 3, "user"),
      m("old", 2, "bot", "sourcer"),
    ];
    expect(firstUnseenMessageId(messages, "main")).toBe("s1");
  });

  it("marks nothing when the member has not replied yet or nothing is new", () => {
    expect(firstUnseenMessageId([m("u1", 1, "user")], "main")).toBeUndefined();
    expect(
      firstUnseenMessageId([m("mine", 2, "bot", "main"), m("u1", 1, "user")], "main"),
    ).toBeUndefined();
  });
});

describe("failure notification", () => {
  it.each([
    ["429 rate limit from provider-x", "The model service was busy."],
    ["Run exceeded its $5 budget", "It reached this task's spending limit."],
    ["Run exceeded 120 minutes", "It reached this task's time limit."],
    ["TypeError: cannot read properties of undefined", "It stopped on an error."],
  ])("%s", (error, reason) => {
    const body = failureNotificationBody(error);
    expect(body).toBe(`${reason} Send a message in the chat to pick up where it stopped.`);
    expect(body).not.toContain("provider");
  });
});
