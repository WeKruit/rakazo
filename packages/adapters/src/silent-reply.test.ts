import { describe, expect, it } from "vitest";
import { personWrote } from "./silent-reply.js";

describe("one question at a time beside a teammate's card", () => {
  it("does not count a teammate's relayed brief as the person's answer", () => {
    expect(personWrote([{ kind: "bot_message_received", text: "Goal: apply the update" }])).toBe(
      false,
    );
    expect(personWrote([{ kind: "text", text: "对了，远程也可以" }])).toBe(true);
  });
});
