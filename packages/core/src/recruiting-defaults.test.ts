import { disabledBuiltinToolSet } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  creditEstimateNote,
  greetsByName,
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
  RECRUITING_UNUSED_BUILTIN_TOOLS,
  recruiterLanguageText,
  recruitingBriefConfirmedNextStep,
  isRecruitingNextStepCard,
  recruitingNextStepCard,
  roleOpenedNote,
  signedAsTeam,
  unfilledPlaceholder,
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

describe("recruiter language", () => {
  it("answers a how-to question with steps, not a question card", () => {
    // Staging 11-13: "what do I do first" got three question cards in a row and no steps.
    expect(RECRUITER_LANGUAGE).toContain("two to four short numbered steps");
    expect(RECRUITER_LANGUAGE).toContain("never answer it with a question card");
    expect(RECRUITER_LANGUAGE).toContain("never a role");
  });
});

describe("unfilledPlaceholder", () => {
  it("finds a bracketed blank left in an email", () => {
    expect(unfilledPlaceholder("Hi [Candidate Name],\n\nA role.")).toBe("[Candidate Name]");
    expect(unfilledPlaceholder("<p>Best,</p><p>[Your name]</p>")).toBe("[Your name]");
    expect(unfilledPlaceholder("您好 [候选人姓名]，")).toBe("[候选人姓名]");
    expect(unfilledPlaceholder("Hi {{firstName}},\n\nA role.")).toBeUndefined();
    expect(unfilledPlaceholder("See [our site](https://example.com) for more.")).toBeUndefined();
    expect(unfilledPlaceholder("Rated [1] of 5.")).toBeUndefined();
  });
});

describe("greetsByName", () => {
  it("flags a shared email written to one named person", () => {
    // Staging 11-13: "Hi Noah," made Kruit split Noah and Ada into two campaigns, so the
    // first card listed only Noah.
    expect(greetsByName("Hi Noah, I'm reaching out about a role.\n\nBest,\nNoah Liu")).toBe(true);
    expect(greetsByName("<p>Dear Ada:</p><p>Hello</p>")).toBe(true);
    expect(greetsByName("Hi {{firstName}},\n\nA role in Seattle.")).toBe(false);
    expect(greetsByName("Hi there,\n\nA role in Seattle.")).toBe(false);
    expect(greetsByName("I'm reaching out about a role, Noah.")).toBe(false);
  });
});

describe("signedAsTeam", () => {
  it("refuses an email signed as Kruit", () => {
    // Staging 11-13: a template written "from my voice" was signed "Kruit".
    expect(signedAsTeam("Hi {{firstName}},\n\nA role.\n\nBest,\nKruit")).toBe(true);
    expect(signedAsTeam("Hi {{firstName}},\n\nA role.\n\nBest,\nDavid Chen")).toBe(false);
  });

  it("finds an email signed by a team instead of a person", () => {
    expect(signedAsTeam("Hi Noah,\n\nWould you be open to a chat?\n\nBest,\nRecruiting")).toBe(
      true,
    );
    expect(signedAsTeam("Hi Noah,\n\nBest,\nThe Recruiting Team.")).toBe(true);
    expect(signedAsTeam("Hi Noah,\n\nBest,\nJules Hou")).toBe(false);
    expect(signedAsTeam("Hi Noah, are you open to recruiting work?")).toBe(false);
  });
});

describe("isChineseText", () => {
  // Staging eval 11-11: 「发给 alex.chen.test@example.com」 got English replies.
  it("ignores email addresses and links when reading the language", () => {
    expect(isChineseText("发给 alex.chen.test@example.com")).toBe(true);
    expect(isEnglishText("发给 alex.chen.test@example.com")).toBe(false);
    // The email body the recruiter dictates is the candidate's language, not theirs.
    const dictated =
      "请给 alex.chen.test@example.com 发一封简短的邮件，主题写 Quick chat，正文：Hi Alex, do you have time next week to talk about a backend role?";
    expect(isChineseText(dictated)).toBe(true);
    expect(isEnglishText(dictated)).toBe(false);
    expect(isEnglishText('Send Alex "你好，下周有空吗" please, thanks a lot')).toBe(true);
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
    // Staging 11-13: this brief got "Got it, on it." and English status lines.
    const brief =
      "新role Senior Data Engineer，Seattle，ref 1801，hybrid每周3天，6年+，Spark Kafka生产经验，base 180-220k。两个人：Noah Liu noah-scheduling+noah1801@mail.grokbot.com，Ada Chen noah-scheduling+ada1801@mail.grokbot.com";
    expect(isChineseText(brief)).toBe(true);
    expect(isEnglishText(brief)).toBe(false);
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
    expect(recruitingNextStepCard(false, true).options[0]).toBe("Search deeper");
    expect(recruitingNextStepCard(true, true).options[0]).toBe("深挖一次");
  });

  // Simulated long-search-finishes 11-14: "找20个" got "我去找 150 个类似的人".
  it("offers the number the recruiter asked for, and is still known as the next-step card", () => {
    const card = recruitingNextStepCard(true, false, 20);
    expect(card.options[0]).toBe("一共找 20 个类似的人");
    expect(card.text).not.toContain("150");
    expect(recruitingNextStepCard(false, true, 20).options[1]).toBe(
      "Find 20 similar people in total",
    );
    for (const known of [card, recruitingNextStepCard(), recruitingNextStepCard(false, true, 40)])
      expect(isRecruitingNextStepCard(known.text)).toBe(true);
    expect(isRecruitingNextStepCard("Should hybrid attendance be required?")).toBe(false);
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
    expect(body).toContain("never a candidate thanking an interviewer");
    // Staging eval 11-11: the request went to Outreach, which still asked who it was for.
    const outreach = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "outreach")!;
    expect(outreach.instructions).toContain(
      "else the role's first result; else a template with blanks",
    );
    // Staging gate 11-11: Kruit handed it to Outreach, which wrote a three-email sequence.
    const main = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!;
    expect(main.instructions).toContain("an email or template naming no one you write yourself");
  });
});

describe("roleOpenedNote", () => {
  it("gives its example in the language of the recruiter's newest message", () => {
    expect(roleOpenedNote(true)).toContain("「岗位已经开好");
    expect(roleOpenedNote(true)).not.toContain("I opened the role");
    expect(roleOpenedNote(false)).toContain("I opened the role");
  });
});

describe("recruiting tool list", () => {
  it("drops only real built-in tools and keeps every tool the playbook names", () => {
    expect(disabledBuiltinToolSet(RECRUITING_UNUSED_BUILTIN_TOOLS).size).toBe(
      RECRUITING_UNUSED_BUILTIN_TOOLS.length,
    );
    const playbook = [
      RECRUITER_LANGUAGE,
      RECRUITING_CALIBRATION_QUICK_SEARCH,
      RECRUITING_SCALE_START,
      RECRUITING_ROUND_NEXT_STEP,
      ...RECRUITING_DEFAULT_BOTS.map((bot) => bot.instructions),
      ...RECRUITING_DEFAULT_SKILLS.map((skill) => skill.body),
    ].join("\n");
    for (const name of RECRUITING_UNUSED_BUILTIN_TOOLS)
      expect(playbook, name).not.toMatch(new RegExp(`\\b${name}\\b`));
  });
});
