import { describe, expect, it } from "vitest";
import { peopleTargetFrom, requestedPeopleTarget } from "./executor.js";
import { askAfterPeopleTarget } from "./people-target.js";

describe("requested people target", () => {
  it.each([
    ["lets find 50 ", 50],
    ["Find 100 similar people", 100],
    ["找100个", 100],
    ["scale up to 200", 200],
    ["I need 30 more candidates", 30],
    // Long-search-finishes 11-15: no verb before the number.
    ["帮我找个 Senior SRE，Austin 坐班，6年以上，base 170-210k。最多20个，找完告诉我", 20],
    ["Senior SRE in Austin, up to 20, tell me when done", 20],
    // Staging 11-20 (2a781497): asked for 5 or 2, the role got 19 to 26.
    ["再来5个，上海的，别带那三个", 5],
    ["再来2个，别带那三个", 2],
    ["find 3 more people like the first two", 3],
    // Branch a2d787f8: a count quoted back in a question is not the ask (it read 14).
    ["再来5个，刚才那三个别再出现。另外你说有14个候选人？首轮不是10个吗", 5],
    ["能再找20个吗？", 20],
  ])("%s → %s", (text, target) => {
    expect(requestedPeopleTarget(text)).toBe(target);
  });

  it.each([
    "find emails for 20 people",
    "send to the first 20",
    "Run another round",
    "find 5",
    "Look up full work history, education and photo for these 11 people",
    "Senior SRE，Austin，6年以上，base 170-210k，入职 3个月内",
    "这3个不要，前3个不错",
    "drop these 3 people",
    "每周3天到岗，5年以上批流pipeline",
    "你说有14个候选人？首轮不是10个吗",
  ])("%s has no search target", (text) => {
    expect(requestedPeopleTarget(text)).toBeUndefined();
  });

  it.each([
    ["lets find 50", 69, 119],
    ["lets find 50", 20, 50],
    ["find 50 total", 69, 50],
    ["一共找100个", 120, 100],
    ["再找20个人", 10, 30],
    ["继续找 10 位", 24, 34],
    ["多找10个", 24, 34],
    ["find 30 more candidates", 40, 70],
    ["再来5个，上海的", 10, 15],
  ])("%s with %s saved → %s", (text, before, target) => {
    expect(peopleTargetFrom(text, before)).toBe(target);
  });
});

describe("a number the recruiter asked for", () => {
  // Long-search-finishes 11-15: "find 20, tell me when done" with 64 saved still asked
  // "report, or 20 more?".
  it("reports instead of asking once the role holds it, and keeps going below it", () => {
    expect(askAfterPeopleTarget(20, 64)).toMatch(/request is done/);
    expect(askAfterPeopleTarget(20, 20)).toMatch(/request is done/);
    expect(askAfterPeopleTarget(20, 10)).toMatch(/keep searching toward 20 without asking/);
    expect(askAfterPeopleTarget(undefined, 64)).toBeUndefined();
    expect(askAfterPeopleTarget(20, undefined)).toBeUndefined();
  });
});
