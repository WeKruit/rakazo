import { describe, expect, it } from "vitest";
import type { Receipts } from "./claim-receipts.js";
import { claimsIn, unbackedClaim } from "./claim-receipts.js";

const none: Receipts = { work: new Set(), delegated: false, read: false, results: "" };

describe("claims of what happened", () => {
  it.each([
    // Sim 11-14 save-template: nothing was saved and the Sequence page was empty.
    ["The first-outreach template is saved and ready to use in Sequence.", "saved"],
    // Sim 11-14: right before the Connect Gmail card.
    ["邮箱已连接，草稿会保留；我现在继续准备发送确认。", "connected"],
    ["Gmail is connected, preparing the send card.", "connected"],
    ["已发送给 Ada。", "sent"],
    ["1 sent, Ada queued for 9:00.", "sent"],
    ["面试已经约好了，周三下午三点。", "booked"],
    ["I've passed it to the scheduling team.", "handed"],
    ["已经交给岗位团队去查。", "handed"],
    // Sim 11-14 send-at-night: said it asked the role, and no answer ever came.
    ["I asked the role to check Noah's email.", "handed"],
  ])("finds %s", (text, kind) => expect(claimsIn(text)[0]?.kind).toBe(kind));

  it.each([
    "连接 Gmail 后，草稿会保留。",
    "Once Gmail is connected, the card shows the email.",
    "我先确认邮箱连接步骤和草稿状态。",
    "The email was not sent yet.",
    "还没有发送，等你确认。",
    "I'll save it as a template now.",
    "Did it get sent?",
  ])("leaves alone %s", (text) => expect(claimsIn(text)).toEqual([]));
});

describe("unbackedClaim", () => {
  it("holds a claim no result of the turn backs", () => {
    const text = "The first-outreach template is saved and ready to use in Sequence.";
    expect(unbackedClaim(text, none)?.kind).toBe("saved");
    expect(unbackedClaim(text, { ...none, work: new Set(["draft"]) })).toBeUndefined();
    // A teammate that did the work reports it itself.
    expect(unbackedClaim(text, { ...none, delegated: true })).toBeUndefined();
    // A read answers a status question, not an instruction to save.
    expect(unbackedClaim(text, { ...none, read: true })?.kind).toBe("saved");
    expect(unbackedClaim(text, { ...none, read: true }, { question: true })).toBeUndefined();
  });

  it("holds a handoff no tool made, whatever else the turn did", () => {
    const text = "I've passed it to the scheduling team.";
    expect(unbackedClaim(text, { ...none, work: new Set(["scheduling"]) })?.kind).toBe("handed");
    expect(unbackedClaim(text, { ...none, delegated: true })).toBeUndefined();
  });

  it("holds a count no result has (sim 11-14: said 1 sent when the records showed 2)", () => {
    const read = { ...none, read: true, results: '{"sent":2,"pending":0}' };
    expect(unbackedClaim("1 sent, Ada queued.", read, { question: true })?.count).toBe(1);
    expect(unbackedClaim("2 sent, none waiting.", read, { question: true })).toBeUndefined();
  });
});
