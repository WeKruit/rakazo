import { describe, expect, it } from "vitest";
import { isStatusQuestion, statusAnswer } from "./live-work.js";

describe("isStatusQuestion", () => {
  it("matches short progress questions", () => {
    for (const text of [
      "进度怎么样了",
      "到哪了？",
      "how's it going?",
      "any update",
      "还要多久",
      "status?",
    ])
      expect(isStatusQuestion(text)).toBe(true);
  });

  it("leaves requests and feedback to the agent", () => {
    for (const text of [
      "find 50",
      "发20个人的先",
      "status of the second candidate is wrong, he is in Austin not Dallas",
      "",
      undefined,
    ])
      expect(isStatusQuestion(text)).toBe(false);
  });
});

describe("statusAnswer", () => {
  it("names the work and how long it has run", () => {
    expect(statusAnswer({ activity: "research", elapsedMs: 72_000 })).toBe(
      "Still working: searching candidates, 1m 12s so far. The result will appear here when it's ready.",
    );
  });
});
