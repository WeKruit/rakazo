import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_CONTINUATION,
  isAgentBrief,
  NEXT_STEP_LEAD,
  personWrote,
  withoutAgentBrief,
  withoutNudge,
} from "./silent-reply.js";

// Staging eval 11-11: Kruit posted its handoff brief to the recruiter, twice.
const BRIEF = `Goal: Draft and send an email to Alex Chen asking whether he is available next week.
Where: 后端工程师 role.
Done when: Use the verified contact to prepare the exact email and present its send-approval card.
Context: Recruiter's exact words: "帮我给 alex.chen.test@example.com 发封邮件".
Don't: Don't send without the native approval.
ask in this conversation if blocked.`;

describe("agent brief in a reply", () => {
  it("recognizes a handoff brief, bold labels included", () => {
    expect(isAgentBrief(BRIEF)).toBe(true);
    expect(isAgentBrief("**Goal:** find 10 people\n**Done when:** ten are saved")).toBe(true);
  });

  it("leaves ordinary replies alone", () => {
    expect(isAgentBrief("Goal: 150 people. I found 40 so far.")).toBe(false);
    expect(isAgentBrief("我已让后端工程师团队准备这封邮件。")).toBe(false);
    expect(isAgentBrief("Context: the role is remote.\nWhere: Austin")).toBe(false);
  });

  it("drops only the brief from the final reply", () => {
    const line = "我已让后端工程师团队准备发给 Alex 的邮件。";
    expect(
      withoutAgentBrief(`${BRIEF}\n\n${line}`, [
        { kind: "text", text: BRIEF },
        { kind: "text", text: line },
      ]),
    ).toEqual({ assembled: line, blocks: [{ kind: "text", text: line }] });
    expect(withoutAgentBrief(line, [{ kind: "text", text: line }])).toEqual({
      assembled: line,
      blocks: [{ kind: "text", text: line }],
    });
  });
});

// Staging eval 11-11 (vague-en): the same question in text and then on its card.
// Staging eval 11-11 (mixed-language-ask): the brief came as one line, labels after each sentence.
describe("isAgentBrief on one line", () => {
  it("finds labels that follow a sentence end", () => {
    expect(
      isAgentBrief(
        "Goal: 按招聘者原话“帮我找几个奥斯汀的 backend 工程师”继续招聘流程。Done when: 展示十位新人。Context: 先前保存被拒绝。",
      ),
    ).toBe(true);
    expect(isAgentBrief("The goal: find ten people. Where we stand: two found.")).toBe(false);
    expect(isAgentBrief("我的目标是找人。Context: none")).toBe(false);
  });
});

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
      withoutAgentBrief(`${answer} ${nudge}`, [
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
      expect(withoutAgentBrief(text, [{ kind: "text", text }]).blocks).toEqual([]);
  });

  it("leaves ordinary words about next steps alone", () => {
    const line = "Next step: review the first 10 people with you.";
    expect(withoutNudge(line)).toBe(line);
  });
});
