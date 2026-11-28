import { describe, expect, it } from "vitest";
import {
  creditEstimateNote,
  RECRUITING_DEFAULT_BOTS,
  RECRUITING_DEFAULT_SKILLS,
  recruitingAgentScope,
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

  // Agent Skills' description limit, which Pi's loader enforces (pi-agent-core harness/skills.js).
  it.each(RECRUITING_DEFAULT_SKILLS)("$name description fits the skill listing", (skill) => {
    expect(skill.description.length).toBeLessThanOrEqual(1024);
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

describe("recruitingAgentScope", () => {
  const key = (name: string) => ({ spawnKey: `recruiting:user-1:${name}` });

  it("gives the account-wide conversation reads and the hand-off to a role only", () => {
    const kruit = recruitingAgentScope(key("main"), "recruiting-global-abc");
    // Staging handoff3: "Write an email or template" listed there had Kruit draft in the main chat.
    expect(kruit?.skills).toEqual([]);
    expect(kruit?.tools).toEqual(expect.arrayContaining(["delegate_work"]));
    for (const work of [
      "recruiting_feedback",
      "recruiting_role",
      "shell",
      "write_file",
      "remember",
    ])
      expect(kruit?.tools).not.toContain(work);
  });

  it("gives each role agent its own list, and every listed skill exists", () => {
    const skills = new Set([
      ...RECRUITING_DEFAULT_SKILLS.map((skill) => skill.name),
      "Tidy memory",
      "Work with data using code",
    ]);
    for (const bot of RECRUITING_DEFAULT_BOTS) {
      const scope = recruitingAgentScope(key(bot.key), "role-group");
      expect(scope).toBe(bot);
      for (const name of scope?.skills ?? []) expect(skills, name).toContain(name);
    }
    expect(recruitingAgentScope(key("scheduling"), "role-group")?.tools).not.toContain(
      "recruiting_research",
    );
    expect(recruitingAgentScope(key("reviewer"), "role-group")?.tools).toContain("ask_user");
    expect(recruitingAgentScope({ name: "Helper", spawnKey: null }, null)).toBeUndefined();
  });
});
