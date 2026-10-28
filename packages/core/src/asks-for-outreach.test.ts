import { describe, expect, it } from "vitest";
import { asksAboutThesePeople, asksForOutreach, recruitingBotKey } from "./recruiting-defaults.js";

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
  it("knows a teammate by spawn key, or by name when an older crew has none", () => {
    expect(recruitingBotKey({ name: "Main", spawnKey: "recruiting:u1:main" })).toBe("main");
    expect(recruitingBotKey({ name: "Outreach", spawnKey: null })).toBe("outreach");
    expect(recruitingBotKey({ name: "Outreach", spawnKey: "onboarding:first" })).toBeUndefined();
    expect(recruitingBotKey({ name: "Writer", spawnKey: null })).toBeUndefined();
  });
});

describe("asksAboutThesePeople", () => {
  it("spots a draft for the people already found", () => {
    expect(asksAboutThesePeople("根据这些人选修改第一封邮件草稿")).toBe(true);
    expect(asksAboutThesePeople("write the email for these candidates")).toBe(true);
    expect(asksAboutThesePeople("来个campign draft看看")).toBe(false);
  });
});
