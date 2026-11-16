import { describe, expect, it } from "vitest";
import { dropScratchReasoning } from "./scratch-reasoning.js";

describe("dropScratchReasoning", () => {
  it("drops English planning the model wrote after a Chinese answer", () => {
    // Staging 2026-11-16, fresh account asking 「我现在有哪些在招的职位？」 with thinking off.
    expect(
      dropScratchReasoning(
        '目前没有在招职位。 a role 不会…… Need Chinese only. "当前没有在招职位。" maybe next step as rule: one next step JD or title etc. Answer.',
      ),
    ).toBe("目前没有在招职位。");
  });

  it("keeps an English email inside a Chinese reply", () => {
    const reply =
      "下面是模板。\n\nSubject: Thank you\n\nHi {{firstName}},\n\nI should be glad to answer any questions. We need a time that works for you.\n\nBest,\nAlex";
    expect(dropScratchReasoning(reply)).toBe(reply);
  });

  it("leaves English replies and replies without planning alone", () => {
    expect(dropScratchReasoning("No open roles yet. Need English only? Sure.")).toBe(
      "No open roles yet. Need English only? Sure.",
    );
    expect(dropScratchReasoning("目前没有在招职位，发我 JD 就能开始。")).toBe(
      "目前没有在招职位，发我 JD 就能开始。",
    );
  });

  it("keeps the reply when nothing Chinese comes before the planning", () => {
    expect(dropScratchReasoning("Need Chinese only. 目前没有在招职位。")).toBe(
      "Need Chinese only. 目前没有在招职位。",
    );
  });
});
