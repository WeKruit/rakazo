import { describe, expect, it } from "vitest";
import { asksForOutreach } from "./recruiting-defaults.js";

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
