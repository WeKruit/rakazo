import { describe, expect, it } from "vitest";
import { isAgentBrief, withoutAgentBrief } from "./silent-reply.js";

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
