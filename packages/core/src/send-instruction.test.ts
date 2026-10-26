import { describe, expect, it } from "vitest";
import { recruiterInstructedSend, sendBodyText } from "./send-instruction.js";

const body = "Hi Alex,\n\nTuesday at 2 pm works. Talk soon.";

describe("recruiter-instructed sends", () => {
  it("sends without a card when the recruiter says send after seeing the exact draft", () => {
    expect(
      recruiterInstructedSend({
        instruction: "可以，发吧",
        shownBefore: `草稿：\n> Hi Alex,\n>\n> Tuesday at 2 pm works. Talk soon.`,
        body,
      }),
    ).toBe(true);
  });

  it("sends when the recruiter wrote the exact text themselves", () => {
    expect(
      recruiterInstructedSend({
        instruction: `回复他：${body}`,
        shownBefore: null,
        body,
      }),
    ).toBe(true);
  });

  it("keeps the card when the text being sent was never shown", () => {
    expect(
      recruiterInstructedSend({
        instruction: "发吧",
        shownBefore: "我准备回复他周二可以。",
        body,
      }),
    ).toBe(false);
  });

  it("keeps the card without an explicit send instruction", () => {
    for (const instruction of ["好的", "看起来不错", "先不要发", "don't send it yet"])
      expect(recruiterInstructedSend({ instruction, shownBefore: body, body })).toBe(false);
  });

  it("keeps the card for an empty body", () => {
    expect(recruiterInstructedSend({ instruction: "发吧", shownBefore: body, body: "" })).toBe(
      false,
    );
  });

  it("reads plain and structured bodies", () => {
    expect(sendBodyText({ body: "x" })).toBe("x");
    expect(sendBodyText({ body: { text: "y", html: "<p>y</p>" } })).toBe("y");
    expect(sendBodyText({ body_text: "z" })).toBe("z");
    expect(sendBodyText({})).toBeNull();
  });
});
