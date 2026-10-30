import { describe, expect, it } from "vitest";
import type { AutomaticReplyKind, CandidateReplyText } from "./recruiting-reply-sorting.js";
import { automaticReplyVerdict } from "./recruiting-reply-sorting.js";

/**
 * A small labelled set of candidate replies (synthetic people and companies). `rule` is what the
 * free first stage must decide; null means the reply must reach the agent, which sorts it.
 */
const LABELLED: Array<CandidateReplyText & { label: string; rule: AutomaticReplyKind | null }> = [
  {
    label: "bounce from mailer-daemon",
    from: "Mail Delivery System <MAILER-DAEMON@mail.example.test>",
    subject: "Delivery Status Notification (Failure)",
    body: "Address not found.",
    rule: "bounce",
  },
  {
    label: "undeliverable subject",
    from: "postmaster@example.test",
    subject: "Undeliverable: Quick question about a staff engineer role",
    body: "",
    rule: "bounce",
  },
  {
    label: "outlook automatic reply",
    from: "Avery Stone <avery@example.test>",
    subject: "Automatic reply: Staff engineer role at Northwind",
    body: "I am out of the office until Monday with limited access to email.",
    rule: "automatic_reply",
  },
  {
    label: "out of office subject",
    from: "jordan@example.test",
    subject: "Out of Office Re: Platform lead",
    body: "Back on the 4th.",
    rule: "automatic_reply",
  },
  {
    label: "auto-reply opening in body",
    from: "riley@example.test",
    subject: "Re: Platform lead",
    body: "Hi, I am currently on parental leave and will reply when I return in January.",
    rule: "automatic_reply",
  },
  {
    label: "chinese automatic reply",
    from: "lin@example.test",
    subject: "自动回复: 关于平台负责人职位",
    body: "我正在休假，下周回复。",
    rule: "automatic_reply",
  },
  {
    label: "interested",
    from: "Casey Park <casey@example.test>",
    subject: "Re: Staff engineer role at Northwind",
    body: "Thanks for reaching out! I'd be open to a call this week. Does Thursday work?",
    rule: null,
  },
  {
    label: "interested but mentions a holiday",
    from: "morgan@example.test",
    subject: "Re: Platform lead",
    body: "Sounds interesting. I'm on vacation next week but happy to talk after. What's the range?",
    rule: null,
  },
  {
    label: "not interested",
    from: "taylor@example.test",
    subject: "Re: Staff engineer role",
    body: "Appreciate it, but I'm happy where I am for now.",
    rule: null,
  },
  {
    label: "asks to stop contact",
    from: "quinn@example.test",
    subject: "Re: Platform lead",
    body: "Please remove me from your list.",
    rule: null,
  },
  {
    label: "sends a resume",
    from: "drew@example.test",
    subject: "Re: Staff engineer role — resume attached",
    body: "Here is my resume. I'm out of the office Friday, so Monday works best for a call.",
    rule: null,
  },
  {
    label: "long reply that starts like an auto-reply",
    from: "sam@example.test",
    subject: "Re: Platform lead",
    body: `I am currently out of the office, but I wanted to answer quickly. ${"I have led platform teams for eight years and would like to hear more. ".repeat(15)}`,
    rule: null,
  },
];

describe("automaticReplyVerdict", () => {
  it.each(LABELLED)("$label", ({ label: _label, rule, ...reply }) => {
    expect(automaticReplyVerdict(reply)?.kind ?? null).toBe(rule);
  });

  it("gives a reason with every verdict", () => {
    for (const { label: _label, rule: _rule, ...reply } of LABELLED) {
      const verdict = automaticReplyVerdict(reply);
      if (verdict) expect(verdict.reason).toMatch(/\w/);
    }
  });
});
