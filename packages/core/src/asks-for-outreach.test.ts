import { describe, expect, it } from "vitest";
import {
  asksAboutThesePeople,
  asksForOutreach,
  asksForPeople,
  asksForTemplate,
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

describe("asksForPeople", () => {
  it("tells a request for people from a question about requirements", () => {
    // Staging 11-15: "so where are the new ones? want to see them" got a hand-written list
    // that relisted people the recruiter had already seen.
    for (const text of [
      "给我看看这些人",
      "下一页",
      "show me the candidates",
      "who is in the list?",
      "so where are the new ones? want to see them",
      "新的呢",
    ])
      expect(asksForPeople(text)).toBe(true);
    for (const text of ["现在must-have有哪些", "What are the must-haves now?"])
      expect(asksForPeople(text)).toBe(false);
  });

  // Staging 11-15: "一共找到多少人？" posted a one-person page under the answer "19".
  it("takes a question about how many as a count, not a request to see people", () => {
    for (const text of ["一共找到多少人？", "how many people so far?", "找到几个了"])
      expect(asksForPeople(text)).toBe(false);
    for (const text of ["多少人？给我看看名单", "how many? show me them"])
      expect(asksForPeople(text)).toBe(true);
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
