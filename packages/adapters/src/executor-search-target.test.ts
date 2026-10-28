import { describe, expect, it } from "vitest";
import { peopleTargetFrom, requestedPeopleTarget } from "./executor.js";

describe("requested people target", () => {
  it.each([
    ["lets find 50 ", 50],
    ["Find 100 similar people", 100],
    ["找100个", 100],
    ["scale up to 200", 200],
    ["I need 30 more candidates", 30],
  ])("%s → %s", (text, target) => {
    expect(requestedPeopleTarget(text)).toBe(target);
  });

  it.each(["find emails for 20 people", "send to the first 20", "Run another round", "find 5"])(
    "%s has no search target",
    (text) => {
      expect(requestedPeopleTarget(text)).toBeUndefined();
    },
  );

  it.each([
    ["lets find 50", 69, 119],
    ["lets find 50", 20, 50],
    ["find 50 total", 69, 50],
    ["一共找100个", 120, 100],
    ["再找20个人", 10, 30],
    ["find 30 more candidates", 40, 70],
  ])("%s with %s saved → %s", (text, before, target) => {
    expect(peopleTargetFrom(text, before)).toBe(target);
  });
});
