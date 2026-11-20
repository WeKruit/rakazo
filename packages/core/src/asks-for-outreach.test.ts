import { describe, expect, it } from "vitest";
import {
  asksForOutreach,
  asksForTemplate,
  recruitingBotKey,
} from "./recruiting-defaults.js";

describe("asksForOutreach", () => {
  it("matches contact, draft and send requests", () => {
    for (const text of [
      "发20个人的先",
      "找contact",
      "来个campign draft看看",
      "根据这些人选修改第一封邮件草稿",
      "send to these 5",
      "find their emails",
    ])
      expect(asksForOutreach(text)).toBe(true);
  });

  it("leaves search and feedback alone", () => {
    for (const text of ["lets find 50", "开发经验太少", "发现这几个人不合适", "Run another round"])
      expect(asksForOutreach(text)).toBe(false);
  });
});

describe("recruitingBotKey", () => {
  it("knows a teammate by spawn key, or by name on an older crew", () => {
    expect(recruitingBotKey({ name: "Main", spawnKey: "recruiting:u1:main" })).toBe("main");
    expect(recruitingBotKey({ name: "Outreach", spawnKey: null })).toBe("outreach");
    // An older crew's lead keeps its onboarding key.
    expect(recruitingBotKey({ name: "Main", spawnKey: "onboarding:first" })).toBe("main");
    expect(recruitingBotKey({ name: "Outreach", spawnKey: "recruiting:u1:main" })).toBe("main");
    expect(recruitingBotKey({ name: "Writer", spawnKey: null })).toBeUndefined();
  });
});


describe("asksForTemplate", () => {
  // Gate 9fd9c2ff, change-mind-mid-run: a one-email template went to the writer, and only
  // "I'll write a version first" showed before the recruiter changed the pay.
  it("tells a one-email template from a sequence", () => {
    for (const text of [
      "帮我写封首次触达邮件模板",
      "write me an outreach template for a staff role",
    ])
      expect(asksForTemplate(text)).toBe(true);
    for (const text of [
      "写一个三封的邮件序列模板",
      "campaign template for these 5",
      "lets find 50",
    ])
      expect(asksForTemplate(text)).toBe(false);
  });
});
