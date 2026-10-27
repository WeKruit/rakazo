import { describe, expect, it } from "vitest";
import { mayContainExplicitLink } from "./link-candidates";
import { plainTextLinkParts } from "./markdown";

const samples = [
  "Hello",
  "你好 世界",
  "123 456",
  "Hello!",
  "plain\ntext",
  "",
  "http://example.test",
  "https://例子.测试/路径",
  "https://xn--fsqu00a.xn--0zwm56d",
  "www.example.com",
  "example.com",
  "例子。测试",
  "example．com",
  "example｡com",
  "user@example.com",
  "用户@example.com",
  "user@例子.测试",
  "mailto:user@example.com",
  "tel:+123456",
  "ftp://example.com",
  "//example.com",
  "javascript:alert(1)",
  "data:text/html,<script>x</script>",
  "HTTPS://EXAMPLE.COM/a(b)",
  "http://localhost:3000",
  "http://[::1]/",
  "https://example.com/%22?q=a&b=c",
  "https：//example.com",
  "user＠example.com",
  "a\nb@example.com",
  "https:\n//example.com",
  "setup.py",
  "notes.md",
  "a:b",
  "first\u2028https://example.com",
  "x\u200b@y.com",
];

describe("deferred plain-text linking parity", () => {
  it("matches the existing parser for links, punctuation and mixed boundaries", () => {
    const wrappers = ["", " ", "\n", "(", "中文 ", "\u2028", "<", "\t"];
    for (const sample of samples)
      for (const prefix of wrappers)
        for (const suffix of wrappers) {
          const text = prefix + sample + suffix;
          const next = mayContainExplicitLink(text)
            ? plainTextLinkParts(text)
            : [{ type: "text", value: text }];
          expect(next, JSON.stringify(text)).toEqual(plainTextLinkParts(text));
        }
  });
  it("keeps the original explicit-only rule for bare domains and rejected schemes", () => {
    for (const text of [
      "example.com",
      "www.example.com",
      "setup.py",
      "ftp://example.com",
      "//example.com",
      "javascript:alert(1)",
    ]) {
      expect(plainTextLinkParts(text)).toEqual([{ type: "text", value: text }]);
    }
    expect(mayContainExplicitLink("A plain sentence without candidate punctuation!")).toBe(false);
  });
});
