import { disabledBuiltinToolSet } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { SKILL_CATALOG_DESCRIPTION_MAX } from "./agent-skill.js";
import {
  accountWideSkill,
  creditEstimateNote,
  RECRUITER_LANGUAGE,
  RECRUITING_DEFAULT_BOTS,
  RECRUITING_DEFAULT_SKILLS,
  RECRUITING_UNUSED_BUILTIN_TOOLS,
  screenLanguage,
  screenNote,
  unfilledPlaceholder,
} from "./recruiting-defaults.js";

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

describe("creditEstimateNote", () => {
  it("tells the agent the balance and what each step usually costs", () => {
    const note = creditEstimateNote(9876.4);
    expect(note).toContain("9,876 left");
    expect(note).toContain("150 people about 600 to 1,000");
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
  it("names the menu in the screen's language", () => {
    expect(screenLanguage("zh-CN")).toBe("zh");
    expect(screenLanguage("ko")).toBe("en");
    expect(screenLanguage(undefined)).toBeUndefined();
    expect(screenNote("en")).not.toContain("邮件序列");
    expect(screenNote("zh")).toContain("邮件序列");
  });
});

describe("accountWideSkill", () => {
  it("lists only the user's own skills there", () => {
    // Staging handoff3: "Write an email or template" listed there had Kruit draft in the main chat.
    const listed = RECRUITING_DEFAULT_SKILLS.map((skill) => skill.name).filter(accountWideSkill);
    expect(listed).toEqual([]);
    expect(accountWideSkill("Progress across roles")).toBe(false);
    expect(accountWideSkill("My weekly summary")).toBe(true);
  });
});
