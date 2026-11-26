import { disabledBuiltinToolSet } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { SKILL_CATALOG_DESCRIPTION_MAX } from "./agent-skill.js";
import {
  creditEstimateNote,
  isChineseText,
  isEnglishText,
  RECRUITER_LANGUAGE,
  RECRUITING_DEFAULT_BOTS,
  RECRUITING_DEFAULT_SKILLS,
  RECRUITING_UNUSED_BUILTIN_TOOLS,
  recruiterLanguage,
  recruiterLanguageText,
  recruitingBriefConfirmedNextStep,
  replyLanguageNote,
  screenLanguage,
  textLanguage,
  unfilledPlaceholder,
} from "./recruiting-defaults.js";

describe("calibration fast path", () => {
  it("hands the new revision on with the confirmed brief", () => {
    expect(recruitingBriefConfirmedNextStep(5)).toContain("expectedRoleRevision 5");
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

  // The catalog cuts a longer description, and the model routes by it.
  it.each(RECRUITING_DEFAULT_SKILLS)("$name description fits the skill catalog", (skill) => {
    expect(skill.description.length).toBeLessThanOrEqual(SKILL_CATALOG_DESCRIPTION_MAX);
  });
});

describe("unfilledPlaceholder", () => {
  it("finds a merge field the sending account does not fill", () => {
    expect(unfilledPlaceholder("Hi {{firstName}},\n\nA role.")).toBeUndefined();
    expect(unfilledPlaceholder("Hi {{ first_name }} at {{companyName}}.")).toBeUndefined();
    // A merge field nobody fills goes out as written, in any language.
    expect(unfilledPlaceholder("{{회사명}}에서 진행 중인 역할")).toBe("{{회사명}}");
    expect(unfilledPlaceholder("Join {{Company}} in Seoul.")).toBe("{{Company}}");
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
    // Staging 11-13: this brief got English status lines.
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
    // Sim 11-14: a Korean recruiter quoting the 收件箱 menu got a Chinese first line.
    expect(
      isChineseText("收件箱는 중국어잖아요. 한국어로 말해주세요. 메뉴 이름이 정확히 뭔가요?"),
    ).toBe(false);
    expect(isChineseText("受信箱はどこですか")).toBe(false);
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

describe("textLanguage", () => {
  it("names the language a message is clearly in", () => {
    expect(textLanguage("对了，远程也可以")).toBe("zh");
    expect(textLanguage("New role from our client Northwind Pay. Please start sourcing")).toBe(
      "en",
    );
    // Sim 11-14: an English spec with the recruiter's own Chinese instruction got English lines.
    expect(
      textLanguage(
        "Staff Backend Engineer, Go, payments infra, NY hybrid, 200-250k, series C fintech. 模板用 Hi {{firstName}}，不是发给某个人的",
      ),
    ).toBe("zh");
    // A Korean recruiter quoting a Chinese menu name got Chinese and English lines.
    expect(textLanguage("收件箱는 중국어잖아요. 한국어로 말해주세요.")).toBe("ko");
    expect(textLanguage("テンプレートをお願いします")).toBe("ja");
    expect(textLanguage("Acme Test Co")).toBeUndefined();
  });

  it("keeps the recruiter's last clear language through short answers", () => {
    expect(recruiterLanguage(["200-250k", "영어 버전으로 부탁드립니다"])).toBe("ko");
    expect(recruiterLanguage(["OK"])).toBe("en");
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

describe("recruiting tool list", () => {
  it("drops only real built-in tools and keeps every tool the playbook names", () => {
    expect(disabledBuiltinToolSet(RECRUITING_UNUSED_BUILTIN_TOOLS).size).toBe(
      RECRUITING_UNUSED_BUILTIN_TOOLS.length,
    );
    const playbook = [
      RECRUITER_LANGUAGE,
      ...RECRUITING_DEFAULT_BOTS.map((bot) => bot.instructions),
      ...RECRUITING_DEFAULT_SKILLS.map((skill) => skill.body),
    ].join("\n");
    for (const name of RECRUITING_UNUSED_BUILTIN_TOOLS)
      expect(playbook, name).not.toMatch(new RegExp(`\\b${name}\\b`));
  });
});

describe("screenLanguage", () => {
  // Staging 11-14: a Chinese chat was told "Sequence" while the screen showed 邮件序列; the
  // screen's own locale decides the menu names, and only the Chinese catalog translates them.
  it("names the menu in the screen's language, not the message's", () => {
    expect(screenLanguage("zh-CN")).toBe("zh");
    expect(screenLanguage("ko")).toBe("en");
    expect(screenLanguage(undefined)).toBeUndefined();
    expect(replyLanguageNote("zh", screenLanguage("en"))).not.toContain("邮件序列");
    expect(replyLanguageNote("en", screenLanguage("zh-CN"))).toContain("邮件序列");
  });
});
