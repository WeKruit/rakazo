import { describe, expect, it } from "vitest";
import { OUTREACH_MAILBOX_ONLY_NOTE, OWN_EMAIL_REQUEST } from "./instantly-senders.js";

describe("own-email requests on accounts with an outreach mailbox", () => {
  it.each([
    "Send one test email from my own Gmail to jo@example.test",
    "send it from my email instead",
    "用我自己的邮箱发给他",
    "从我的邮箱发",
  ])("recognizes %s", (text) => expect(OWN_EMAIL_REQUEST.test(text)).toBe(true));

  it.each(["Send the emails to these five people", "给这几个人发邮件"])(
    "leaves an ordinary send alone: %s",
    (text) => expect(OWN_EMAIL_REQUEST.test(text)).toBe(false),
  );

  it("offers the outreach mailbox and never asks to connect email", () => {
    expect(OUTREACH_MAILBOX_ONLY_NOTE).toMatch(/offer to send through the outreach mailbox/);
    expect(OUTREACH_MAILBOX_ONLY_NOTE).toMatch(/never suggest connecting or reconnecting/);
  });
});
