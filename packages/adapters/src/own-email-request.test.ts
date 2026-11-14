import { describe, expect, it } from "vitest";
import {
  CLAIMS_CONNECTED,
  OUTREACH_MAILBOX_ONLY_NOTE,
  OWN_EMAIL_REQUEST,
  SEND_NOW_REQUEST,
  SEND_NOW_WITHOUT_GMAIL_NOTE,
  showsGmailCard,
} from "./instantly-senders.js";

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

// 11-14 gate: 「签名用 Noah。直接发」 got "I'll send it now" before the Gmail card, then
// "the draft is not confirmed as saved".
describe("send now before Gmail is connected", () => {
  it.each([
    "签名用 Noah。直接发",
    "现在就发给两个人",
    "ok send it now",
    "just send it",
    // 11-14 sim: the follow-up got a mailbox-draft-folder answer and "I'll check first".
    "连哪个？点了就能发？草稿还在吗",
    // Sim first-timer-no-gmail: "yes, Gmail isn't needed… if not connected, connect one first".
    "不连Gmail能直接给候选人发邮件吗",
    "can I email candidates without connecting Gmail?",
  ])("recognizes %s", (text) => expect(SEND_NOW_REQUEST.test(text)).toBe(true));

  it.each([
    "给 Wei Zhang 写封邮件",
    "write a first email for these two",
    "draft an email to Wei",
    "写个草稿给他",
  ])("leaves a drafting request alone: %s", (text) =>
    expect(SEND_NOW_REQUEST.test(text)).toBe(false),
  );

  it("opens with not sent and the one step, without the email again", () => {
    expect(SEND_NOW_WITHOUT_GMAIL_NOTE).toMatch(/open this reply with that/);
    expect(SEND_NOW_WITHOUT_GMAIL_NOTE).toMatch(/never write the email again/);
    expect(SEND_NOW_WITHOUT_GMAIL_NOTE).toMatch(/never say the draft is not saved/);
    expect(SEND_NOW_WITHOUT_GMAIL_NOTE).toMatch(/no check, tool call or progress line first/);
    expect(SEND_NOW_WITHOUT_GMAIL_NOTE).toMatch(/comes back on one Send card/);
    expect(SEND_NOW_WITHOUT_GMAIL_NOTE).toMatch(/never mention a mailbox draft folder/);
  });
});

describe("a Connect Gmail card already in the conversation", () => {
  const card = (name: string) => ({
    role: "bot",
    blocks: [{ kind: "ask", connection: { serverId: "s", name, reason: "r" } }],
  });
  it("is found only for a Gmail connect card from the agent", () => {
    expect(showsGmailCard([{ role: "user", blocks: [] }, card("Gmail")])).toBe(true);
    expect(showsGmailCard([card("Google Calendar")])).toBe(false);
    expect(showsGmailCard([{ role: "user", blocks: card("Gmail").blocks }])).toBe(false);
    expect(showsGmailCard([{ role: "bot", blocks: null }])).toBe(false);
  });
});

// Sim 11-14: 「邮箱已连接，草稿会保留」 went out right before the Connect Gmail card.
describe("a progress line that says the mailbox is connected", () => {
  it.each([
    "邮箱已连接，草稿会保留；我现在继续准备发送确认。",
    "Gmail is connected, preparing the send card.",
  ])("is caught: %s", (text) => expect(CLAIMS_CONNECTED.test(text)).toBe(true));
  it.each([
    "连接 Gmail 后，草稿会保留。",
    "Once Gmail is connected, the card shows the email.",
    "我先确认邮箱连接步骤和草稿状态。",
  ])("is left alone: %s", (text) => expect(CLAIMS_CONNECTED.test(text)).toBe(false));
});
