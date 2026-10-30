import { describe, expect, it } from "vitest";
import {
  asksAboutThesePeople,
  asksForOutreach,
  asksToSendTo,
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

describe("asksAboutThesePeople", () => {
  it("spots a draft for the people already found", () => {
    expect(asksAboutThesePeople("根据这些人选修改第一封邮件草稿")).toBe(true);
    expect(asksAboutThesePeople("write the email for these candidates")).toBe(true);
    expect(asksAboutThesePeople("来个campign draft看看")).toBe(false);
  });
});

// 2026-10-28: Main handed "发20个人的先" on as "prepare drafts, do not send" and no card appeared.
describe("asksToSendTo", () => {
  it("reads the number of people to send to", () => {
    expect(asksToSendTo("发20个人的先")).toBe(20);
    expect(asksToSendTo("先发给 15 位")).toBe(15);
    expect(asksToSendTo("send it to 20 people first")).toBe(20);
    expect(asksToSendTo("找contact")).toBeUndefined();
    expect(asksToSendTo("lets find 50")).toBeUndefined();
    expect(asksToSendTo("找50个类似的人")).toBeUndefined();
  });
});
