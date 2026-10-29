import { describe, expect, it } from "vitest";
import {
  DECLINE_RETRY_NOTE,
  declinedSentence,
  declineRetry,
  questionStatesWork,
  REPORT_BEFORE_ASK,
  TEXT_QUESTION_NOTE,
  TurnReportLedger,
  turnReportText,
  turnWork,
} from "./turn-report.js";

describe("turnWork", () => {
  it("counts searches, saves and business changes, never reads or failures", () => {
    expect(turnWork("exa__web_search_advanced_exa", { query: "x" })).toBe("people_search");
    expect(turnWork("recruiting_research", { operation: "save_search" })).toBe("people_saved");
    expect(turnWork("recruiting_research", { operation: "calibration_round" })).toBe("round");
    expect(turnWork("recruiting_research", { operation: "rows" })).toBeUndefined();
    expect(turnWork("recruiting_role", { operation: "read" })).toBeUndefined();
    expect(turnWork("recruiting_role", { operation: "update" })).toBe("role");
    expect(turnWork("recruiting_candidates", { operation: "list" })).toBeUndefined();
    expect(turnWork("read_file", {})).toBeUndefined();
    expect(turnWork("recruiting_role", { operation: "update" }, { ok: false })).toBeUndefined();
    expect(
      turnWork("instantly__mail__ensure_role_campaign", {}, { ok: true, readOnly: false }),
    ).toBe("draft");
    expect(turnWork("cal__main__create_booking", {}, { ok: true, readOnly: false })).toBe(
      "scheduling",
    );
    expect(turnWork("mcp__x__get_email", {}, { ok: true, readOnly: true })).toBeUndefined();
    // A catalog read without a read-only hint is still a read, named by its id.
    const wrote = { ok: true, readOnly: false } as const;
    expect(turnWork("connectors_execute_tool", { id: "srv:get_bookings" }, wrote)).toBeUndefined();
    expect(turnWork("connectors_execute_tool", { id: "srv:whoami" }, wrote)).toBeUndefined();
    expect(
      turnWork("connectors_execute_tool", { id: "srv:native_instantly_list_emails" }, wrote),
    ).toBeUndefined();
    expect(turnWork("connectors_execute_tool", { id: "srv:create_booking" }, wrote)).toBe(
      "scheduling",
    );
    const lookup = { structuredContent: { source: "local_contact_lookup", summary: { found: 3 } } };
    expect(turnWork("contacts__find", {}, { ok: true, result: lookup, readOnly: true })).toBe(
      "contacts",
    );
  });
});

describe("TurnReportLedger", () => {
  it("owes a report for work after the last visible text, in stream order", () => {
    const ledger = new TurnReportLedger(true);
    ledger.report(); // narration before the call is not its report
    ledger.tool("1", "exa__web_search_advanced_exa", { query: "x" });
    ledger.tool("2", "recruiting_research", { operation: "save_search" });
    ledger.settle("1", { ok: true });
    ledger.settle("2", { ok: true });
    expect(ledger.owed()).toEqual(["people_search", "people_saved"]);
    ledger.report();
    expect(ledger.owed()).toEqual([]);
    expect(ledger.owedWithoutFinalReply()).toEqual(["people_search", "people_saved"]);
    expect(ledger.worked()).toBe(true);
    expect(ledger.lastWork()).toBe("people_saved");
  });

  it("treats a recorded round and shown picks as their own report", () => {
    const ledger = new TurnReportLedger(true);
    ledger.tool("1", "exa__web_search_advanced_exa", { query: "x" });
    ledger.tool("2", "recruiting_research", { operation: "show_picks" });
    ledger.settle("2", { ok: true });
    expect(ledger.owed()).toEqual([]);
    ledger.tool("3", "recruiting_research", { operation: "calibration_round" });
    expect(ledger.owed()).toEqual([]);
    expect(ledger.lastWork()).toBe("round");
  });

  it("bounces one unreported question per attempt, never one that states the work", () => {
    const ledger = new TurnReportLedger(true);
    ledger.tool("1", "recruiting_crm_target", { operation: "update" });
    expect(ledger.bounceAsk("The pool is now 139 people. Keep going?")).toBeUndefined();
    expect(ledger.bounceAsk("What next?")).toBe(REPORT_BEFORE_ASK);
    expect(ledger.bounceAsk("What next?")).toBeUndefined();
  });

  it("lets intake ask right after saving the role or the recruiter's answers", () => {
    const ledger = new TurnReportLedger(true);
    ledger.tool("1", "recruiting_role", { operation: "update" });
    ledger.tool("2", "recruiting_feedback", { operation: "record" });
    expect(ledger.bounceAsk("Which city?")).toBeUndefined();
    expect(ledger.owed()).toEqual(["role", "feedback"]);
  });

  it("owes nothing when disabled (routines, silent wakes)", () => {
    const ledger = new TurnReportLedger(false);
    ledger.tool("1", "recruiting_role", { operation: "update" });
    expect(ledger.owed()).toEqual([]);
  });

  it("waits for the executor to reach the asked question, bounded", async () => {
    const ledger = new TurnReportLedger(true);
    const waited = ledger.caughtUpToAsk(1_000);
    ledger.tool("a", "ask_user", {});
    await waited;
    const started = Date.now();
    await ledger.caughtUpToAsk(50);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("turnReportText", () => {
  it("names the work and the saved count", () => {
    expect(turnReportText(["people_search", "people_search", "people_saved"], 139)).toBe(
      "Done: searched for people, saved people to the role. 139 people are saved for this role.",
    );
    expect(turnReportText(["draft"])).toBe("Done: saved the email draft.");
  });
});

it("questionStatesWork", () => {
  expect(questionStatesWork("What next?")).toBe(false);
  expect(questionStatesWork("Added 70 people. Keep going?")).toBe(true);
});

describe("declinedSentence", () => {
  // Final replies seen in dispatch acceptance runs and earlier recruiter chats.
  const declines: [string, string][] = [
    [
      "I can't verify whether other contact details are saved from the records available here.",
      "decline",
    ],
    [
      "I can't safely use the available approval flow for a send to Abe alone because it would include the other recipients.",
      "decline",
    ],
    [
      "I can't find the original email thread or the saved outreach record, so I can't prepare a send-ready message or approval card yet.",
      "decline",
    ],
    ["Not ready to send: contact history and suppression unknown.", "decline"],
    ["我无法确认这些人的邮箱是否已保存。", "decline"],
    ["我不能直接发送这封邮件。", "decline"],
    ["我没法查到他的联系方式。", "decline"],
    ["I haven't looked up their emails yet. Do you want me to do that now?", "defer"],
    ["Would you like me to draft the first email?", "defer"],
    ["Want me to book Wednesday afternoon?", "defer"],
    ["需要你先确认收件人，我再准备邮件。", "defer"],
    ["要不要我先帮你查一下他们的邮箱？", "defer"],
    ["Which people should I send this to?", "pick"],
    ["Which people?", "pick"],
    ["Which of them do you want me to email?", "pick"],
    ["你想发给哪些人？", "pick"],
  ];
  it.each(declines)("flags %s", (reply, kind) => {
    expect(declinedSentence(reply)?.kind).toBe(kind);
  });

  // Reports, results and real questions that are not a decline.
  const reports = [
    "Added 70 people. The pool is now 139.",
    "I didn't send anything.",
    "Nothing was sent.",
    "No emails were sent yet; the send card is waiting for you.",
    "Found emails for 4 of the first 5 people; Dana Li has none on file.",
    "Here are the ten for this round.",
    "已为前5个人找到邮箱，其中1人没有找到。",
    "Booked Wednesday at 2 PM; the confirmation card is above.",
    "The send card is above; once you confirm, the five emails go out.",
  ];
  it.each(["Which of these look closest to what you want?", "下周三约哪天下午比较方便？"])(
    "reads %s as a question for a card, not a refusal",
    (reply) => {
      expect(declinedSentence(reply)?.kind).toBe("text_question");
    },
  );
  it.each(reports)("leaves %s alone", (reply) => {
    expect(declinedSentence(reply)).toBeUndefined();
  });
  it("reads only the reply's own words before a drafted email", () => {
    const draft = (intro: string) =>
      `${intro}\n\n**Email 1 — Day 0**\n**Subject:** TikTok LIVE role\n\nHi Adrian,\n\nWould you be open to a brief conversation?\n\nSubject: Following up\n\nCan't make it this week?`;
    expect(declinedSentence(draft("The three-email sequence is prepared."))).toBeUndefined();
    expect(declinedSentence(draft("I can't find the saved draft."))?.kind).toBe("decline");
  });

  it("returns the declining sentence itself", () => {
    expect(
      declinedSentence("Added 20 people. I can't verify tenure for three of them.")?.sentence,
    ).toBe("I can't verify tenure for three of them.");
  });
});

describe("declineRetry", () => {
  const replyThread =
    "I can't send this message through the available approval flow: it requires replying to an existing email.";
  const notReady = "Not ready to send: contact history and suppression unknown.";

  it("asks for a best-guess action or one question card, never a decline", () => {
    const retry = declineRetry({ reply: notReady, request: "send it", tools: [], teammates: [] });
    expect(retry?.note).toContain(DECLINE_RETRY_NOTE);
    expect(DECLINE_RETRY_NOTE).toContain("Do not decline or defer");
    expect(DECLINE_RETRY_NOTE).toContain("ask one clear question with ask_user");
    expect(DECLINE_RETRY_NOTE).toContain("the recipients, the email, the time");
    expect(DECLINE_RETRY_NOTE).toContain("shows its own card");
  });

  it("names this bot's own tool first", () => {
    const retry = declineRetry({
      reply: replyThread,
      request: "send this email to them",
      tools: [{ name: "recruiting_role" }, { name: "instantly__mail__activate_campaign" }],
      teammates: [],
    });
    expect(retry?.note).toContain("instantly__mail__activate_campaign");
  });

  it("sends a clarifying question typed into the reply to a question card", () => {
    const reply =
      "The draft is a three-email sequence for 16 recipients.\n\nWhich do you mean?\n- Start it for all 16\n- Send a one-off email instead";
    expect(declinedSentence(reply)?.kind).toBe("text_question");
    const retry = declineRetry({ reply, request: "发一下", tools: [], teammates: [] });
    expect(retry?.note).toContain("Ask it with ask_user");
    // After real work, a closing question stands.
    expect(
      declineRetry({ reply, request: "发一下", tools: [], teammates: [], worked: true }),
    ).toBeUndefined();
  });

  it("catches a past-tense refusal of a send", () => {
    expect(
      declinedSentence(
        "I couldn’t stage the exact one-off email for approval: Aiyi is already in the role’s existing email sequence.",
      ),
    ).toBeDefined();
    // An honest shortfall is a report, not a refusal.
    expect(
      declinedSentence("I couldn't find anyone new in Austin, so the total is still 40."),
    ).toBeUndefined();
  });

  it("points a contact decline at the saved-email lookup, which reuses earlier results", () => {
    const retry = declineRetry({
      reply:
        "I can't verify whether other contact details are saved from the records available here.",
      request: "前5个人的contact",
      tools: [{ name: "mcp__wekruit__find_emails" }],
      teammates: [],
    });
    expect(retry?.note).toContain("mcp__wekruit__find_emails");
  });

  it("hands off to a teammate who can", () => {
    const retry = declineRetry({
      reply: notReady,
      request: "把这封邮件发给他",
      tools: [{ name: "recruiting_role" }],
      teammates: [
        { id: "bot-s", name: "Scheduler", about: "Interview scheduling" },
        { id: "bot-o", name: "Outreach", about: "Contacts, email drafts and sends" },
      ],
    });
    expect(retry?.note).toContain("handoff_to_bot (bot_id bot-o)");
  });

  it("retries a vague ask the agent deferred or handed back as a pick", () => {
    expect(
      declineRetry({
        reply: "Which people should I contact?",
        request: "处理一下前几个",
        tools: [],
        teammates: [],
      })?.note,
    ).toMatch(/^Your reply asked the user to choose/);
    expect(
      declineRetry({
        reply: "I haven't drafted it yet. Do you want me to?",
        request: "改一下邮件",
        tools: [],
        teammates: [],
      })?.note,
    ).toMatch(/^Your reply deferred the request/);
  });

  it("keeps a reply that shows the drafted email, whatever its aside", () => {
    expect(
      declineRetry({
        reply:
          "The separate draft search wasn't available, so I can't confirm whether an older draft exists.\n\n**Email 1 — Day 0**\nSubject: TikTok LIVE role\n\nHi Adrian,",
        request: "The recruiter's exact words are “来个campign draft看看”.",
        tools: [],
        teammates: [],
      }),
    ).toBeUndefined();
  });

  it("moves a closing question after a shown draft to a card, keeping the draft", () => {
    const draft =
      "Here is the saved draft.\n\nSubject: TikTok LIVE role\n\nHi Abe,\n\nWould you be open to a brief conversation?\n\nBest,\nRecruiting Team";
    const retry = declineRetry({
      reply: `${draft}\n\nWhat would you like changed? For example: shorter, or a different tone.`,
      request: "改一下邮件",
      tools: [],
      teammates: [],
    });
    expect(retry?.note).toContain(TEXT_QUESTION_NOTE);
    expect(retry?.keep).toBe(draft);
    // The candidate's own question closing the draft is not one for the recruiter.
    expect(declineRetry({ reply: draft, request: "改一下邮件", tools: [], teammates: [] })).toBe(
      undefined,
    );
  });

  it("reads a choice asked as an instruction as a question for a card", () => {
    expect(
      declinedSentence(
        "“Arrange it” doesn’t specify which slot, so please choose a 30-minute time: 11:00, 11:30 or 12:00 p.m.",
      )?.kind,
    ).toBe("text_question");
  });

  it("retries a send that ended without its card however the reply words it", () => {
    const reply =
      "I couldn’t find a saved email draft for Acery to send. I haven’t sent anything. Please provide or save the intended draft, and I can present it for approval.";
    expect(declinedSentence(reply)).toBeUndefined();
    const retry = declineRetry({
      reply,
      request: "send this email to them",
      tools: [{ name: "activate_campaign" }],
      teammates: [],
      worked: true,
    });
    expect(retry?.note).toContain("the one written in this conversation");
    // Not a send or booking request: the same words stand.
    expect(
      declineRetry({ reply, request: "这个人怎么样", tools: [], teammates: [] }),
    ).toBeUndefined();
  });

  it("retries a send that ended without its card, even after other work", () => {
    expect(
      declineRetry({
        reply:
          "The saved pool has 134 people, so I can't treat all 20 as eligible by default. I need the original ordered first-20 list.",
        request: "发20个人的先",
        tools: [{ name: "activate_campaign" }],
        teammates: [],
        worked: true,
      })?.note,
    ).toContain("activate_campaign");
  });

  it("keeps an aside or an offer after real work", () => {
    // The declined sentence is about verification, not the requested search.
    expect(
      declineRetry({
        reply: "Added 20 people. I can't verify tenure for three of them.",
        request: "find 20 more",
        tools: [{ name: "exa__web_search_advanced_exa" }],
        teammates: [],
        worked: true,
      }),
    ).toBeUndefined();
    expect(
      declineRetry({
        reply: "Added 20 people; the pool is now 70. Want me to find 30 more?",
        request: "find 20 more",
        tools: [{ name: "exa__web_search_advanced_exa" }],
        teammates: [],
        worked: true,
      }),
    ).toBeUndefined();
    // Refusing the asked kind of work is retried even after other work.
    expect(
      declineRetry({
        reply: "Drafted the email. I can't send it from here.",
        request: "send this email to them",
        tools: [{ name: "activate_campaign" }],
        teammates: [],
        worked: true,
      })?.note,
    ).toContain("activate_campaign");
  });
});
