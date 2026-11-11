import { describe, expect, it } from "vitest";
import { beforeCardQuestion, isAgentBrief, withoutAgentBrief } from "./silent-reply.js";

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
describe("beforeCardQuestion", () => {
  it("keeps what leads up to the question the card asks", () => {
    expect(
      beforeCardQuestion(
        "I'm ready to move quickly, but I don't have a role yet. What role should I find people for? A JD is fastest.",
      ),
    ).toBe("I'm ready to move quickly, but I don't have a role yet.");
    expect(beforeCardQuestion("我还没有岗位信息。你要找什么岗位的人？")).toBe("我还没有岗位信息。");
    expect(beforeCardQuestion("Which city?")).toBe("");
    expect(beforeCardQuestion("I opened the role.")).toBe("I opened the role.");
  });
});

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
