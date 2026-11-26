import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_CONTINUATION,
  NEXT_STEP_LEAD,
  personWrote,
  withoutEchoedNudge,
  withoutNudge,
} from "./silent-reply.js";

describe("one question at a time beside a teammate's card", () => {
  it("does not count a teammate's relayed brief as the person's answer", () => {
    expect(personWrote([{ kind: "bot_message_received", text: "Goal: apply the update" }])).toBe(
      false,
    );
    expect(personWrote([{ kind: "text", text: "对了，远程也可以" }])).toBe(true);
  });
});

describe("the server's continuation nudge in a reply", () => {
  // Older conversations still hold the next-step nudge the server used to push.
  const nudge = `${NEXT_STEP_LEAD} Review the first 10 people. (${AUTOMATIC_CONTINUATION})`;

  it("keeps the answer and drops the nudge the model echoed after it", () => {
    const answer = "Aurora-0t1c";
    expect(
      withoutEchoedNudge(`${answer} ${nudge}`, [
        { kind: "text", text: "我正在确认你给团队定的称呼。" },
        { kind: "text", text: `${answer} ${nudge}` },
      ]),
    ).toEqual({
      assembled: `我正在确认你给团队定的称呼。${answer}`,
      blocks: [
        { kind: "text", text: "我正在确认你给团队定的称呼。" },
        { kind: "text", text: answer },
      ],
    });
  });

  it("drops a reply that is only the nudge, in every form the server writes", () => {
    for (const text of [nudge])
      expect(withoutEchoedNudge(text, [{ kind: "text", text }]).blocks).toEqual([]);
  });

  it("leaves ordinary words about next steps alone", () => {
    const line = "Next step: review the first 10 people with you.";
    expect(withoutNudge(line)).toBe(line);
  });
});
