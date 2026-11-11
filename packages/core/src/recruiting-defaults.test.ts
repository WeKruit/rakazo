import { describe, expect, it } from "vitest";
import {
  creditEstimateNote,
  isChineseText,
  isEnglishText,
  RECRUITER_LANGUAGE,
  RECRUITING_CALIBRATION_QUICK_SEARCH,
  RECRUITING_DEFAULT_BOTS,
  RECRUITING_DEFAULT_SKILLS,
  RECRUITING_PDF_RENDERING,
  RECRUITING_ROUND_NEXT_STEP,
  RECRUITING_SCALE_START,
  RECRUITING_SEARCH_BRIEF_TEMPLATE,
  RECRUITING_SEARCH_SAVED_NEXT_STEP,
  recruiterLanguageText,
  recruitingBriefConfirmedNextStep,
  recruitingNextStepCard,
} from "./recruiting-defaults.js";

describe("calibration fast path", () => {
  it("hands the new revision on with the confirmed brief", () => {
    expect(recruitingBriefConfirmedNextStep(5)).toContain("expectedRoleRevision 5");
  });

  it("keeps the pick off files and shell", () => {
    expect(RECRUITING_SEARCH_SAVED_NEXT_STEP).toContain("calibration_round");
    expect(RECRUITING_SEARCH_SAVED_NEXT_STEP).toContain("no files, shell");
  });
});

// Behavior rules that fixed a real bug are pinned in recruiting-rules.test.ts.
describe("maintained recruiting defaults", () => {
  // Same budget Workloop uses: a longer prompt dilutes every rule in it. Shorten before adding.
  it.each(RECRUITING_DEFAULT_BOTS)("$name instructions stay within 12,000 characters", (bot) => {
    expect(bot.instructions.length).toBeLessThanOrEqual(12_000);
  });

  it.each(RECRUITING_DEFAULT_SKILLS)("$name skill stays within 8,000 characters", (skill) => {
    expect(skill.body.length).toBeLessThanOrEqual(8_000);
  });

  // Each shared rule has one source: the executor adds recruiter language to every recruiting
  // run and the role context carries the calibration, scale and PDF rules.
  it.each([
    RECRUITER_LANGUAGE,
    RECRUITING_CALIBRATION_QUICK_SEARCH,
    RECRUITING_ROUND_NEXT_STEP,
    RECRUITING_SCALE_START,
    RECRUITING_PDF_RENDERING,
  ])("keeps a shared rule out of bot instructions and skills (%#)", (rule) => {
    for (const bot of RECRUITING_DEFAULT_BOTS) expect(bot.instructions).not.toContain(rule);
    for (const skill of RECRUITING_DEFAULT_SKILLS) expect(skill.body).not.toContain(rule);
  });

  // Skills ship with the code, so accounts with customized bot text still get the template.
  it("carries the search brief template in the sourcing skill", () => {
    const sourcing = RECRUITING_DEFAULT_SKILLS.find(
      (skill) => skill.name === "Recruitment sourcing continuation",
    )!;
    expect(sourcing.body).toContain(RECRUITING_SEARCH_BRIEF_TEMPLATE);
  });

  it("keeps account reads with Main before specialist work", () => {
    const main = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!;
    expect(main.instructions).toContain(
      "Answer read-only interviews, shortlist, replies, sequences and roles questions with recruiting_candidates yourself; do not hand off",
    );
    expect(main.instructions).toContain(
      "Without a linked role default to all active roles and name each role",
    );
    expect(main.instructions).toContain("For specialist work beyond those reads");
    expect(main.instructions.indexOf("do not hand off")).toBeLessThan(
      main.instructions.indexOf("call handoff_to_bot"),
    );
  });

  it("gives Sourcer the scale stage order", () => {
    const sourcer = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "sourcer")!;
    const order = [
      "accepted round and every round's feedback",
      "agent runs (agent_run) toward the target",
      "previousRunId set",
      "feedback of any scope",
      "next wave's query",
    ].map((step) => sourcer.instructions.indexOf(step));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("isChineseText", () => {
  // Staging eval 11-11: 「发给 alex.chen.test@example.com」 got English replies.
  it("ignores email addresses and links when reading the language", () => {
    expect(isChineseText("发给 alex.chen.test@example.com")).toBe(true);
    expect(isEnglishText("发给 alex.chen.test@example.com")).toBe(false);
    expect(isChineseText("看看这个 https://www.linkedin.com/in/some-person-name")).toBe(true);
    expect(recruiterLanguageText(["发给 alex.chen.test@example.com", "Write a template"])).toBe(
      "发给 alex.chen.test@example.com",
    );
    expect(isEnglishText("Send it to alex.chen.test@example.com please")).toBe(true);
  });

  it("reads mostly-Han text as Chinese", () => {
    expect(isChineseText("仓库运营经理职位的中文要求应如何设定？")).toBe(true);
    expect(isChineseText("以后都用中文回复我")).toBe(true);
    expect(isChineseText("帮我找应届生，USC 的，CS 专业，会做 AI agent")).toBe(true);
  });

  it("reads English that quotes a Chinese phrase as English", () => {
    expect(isChineseText("Should Chinese (中文) be required, preferred or not needed?")).toBe(
      false,
    );
    expect(isChineseText("")).toBe(false);
  });
});

describe("isEnglishText", () => {
  it("reads an English request as English, and Chinese or a bare name as neither", () => {
    expect(isEnglishText("Book Adam Test for Nov 3 at 2pm Central")).toBe(true);
    expect(isEnglishText("帮我找应届生，USC 的，CS 专业，会做 AI agent")).toBe(false);
    expect(isEnglishText("Adam Test")).toBe(false);
    expect(
      isEnglishText("测试固定 · Senior Backend Engineer in New York, 6+ years of Go or Java"),
    ).toBe(true);
  });
});

describe("recruiterLanguageText", () => {
  it("keeps the conversation's language for a short answer such as a company name", () => {
    expect(recruiterLanguageText(["Acme Test Co", "我想开始给候选人发邮件"])).toBe(
      "我想开始给候选人发邮件",
    );
  });

  it("follows a recruiter who switches to an English sentence", () => {
    const english = "Please write the rest of this in English for me";
    expect(recruiterLanguageText([english, "我想开始给候选人发邮件"])).toBe(english);
  });

  it("falls back to the latest message when none has a clear language", () => {
    expect(recruiterLanguageText(["OK"])).toBe("OK");
    expect(recruiterLanguageText([])).toBe("");
  });
});

describe("creditEstimateNote", () => {
  it("tells the agent the balance and what each step usually costs, without asking permission", () => {
    const note = creditEstimateNote(9876.4);
    expect(note).toContain("9,876 left");
    expect(note).toContain("150 people about 600 to 1,000");
    expect(note).toContain("Never ask permission because of cost alone");
  });
});

describe("recruitingNextStepCard", () => {
  it("asks in the recruiter's language, so a Chinese chat gets no English card", () => {
    const card = recruitingNextStepCard(true);
    expect(`${card.text}${card.options.join("")}`).not.toMatch(/[A-Za-z]/);
    expect(card.options).toHaveLength(3);
    expect(recruitingNextStepCard().options[0]).toBe("Find 150 similar people");
  });
});

describe("global recruiting overview", () => {
  // Staging eval 11-11: "email alex… ask if he's free next week" opened a new role to send it.
  it("hands a one-off email to Outreach without opening a role", () => {
    const body = RECRUITING_DEFAULT_SKILLS.find(
      (skill) => skill.name === "Global recruiting overview",
    )?.body;
    expect(body).toContain("goes to Outreach in this conversation with handoff_to_bot");
    expect(body).toContain("never open a role for it");
    // Staging eval 11-11: after that line a pasted JD opened no role.
    expect(body).toContain("a new role, a JD or hiring requirements still go to start_role");
    // Staging eval 11-11: "write me a cold outreach email…" was answered with "who should I address it to?"
    expect(body).toContain("never ask who it is addressed to first");
    // Staging eval 11-11: the request went to Outreach, which still asked who it was for.
    const outreach = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "outreach")!;
    expect(outreach.instructions).toContain("else the role's first result; else a template with blanks");
  });
});
