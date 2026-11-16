import { describe, expect, it } from "vitest";
import {
  draftAskedBeforeShown,
  narratesRecords,
  DECLINE_RETRY_NOTE,
  declinedSentence,
  declineRetry,
  questionStatesWork,
  REPORT_BEFORE_ASK,
  lastOwnUpdate,
  restatesUpdate,
  withoutRepeatedClosing,
  readsOnly,
  CLAIMS_CARD_PENDING,
  retryReason,
  TEXT_QUESTION_NOTE,
  TurnReportLedger,
  turnReportText,
  turnWork,
  droppedDay,
  repastedDraft,
  withoutRepastedDraft,
  sequenceForOneEmail,
  quotesMessage,
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
      turnWork(
        "instantly__mail__ensure_role_campaign",
        { steps: [{ subject: "Hi", body: "Hello" }] },
        { ok: true, readOnly: false },
      ),
    ).toBe("draft");
    expect(
      turnWork(
        "instantly__mail__ensure_role_campaign",
        {},
        { ok: true, readOnly: false, result: { structuredContent: { created: true } } },
      ),
    ).toBe("draft");
    // Staging 11-13: each status check that only found the existing campaign reported a saved draft.
    expect(
      turnWork(
        "instantly__mail__ensure_role_campaign",
        {},
        { ok: true, readOnly: false, result: { structuredContent: { created: false } } },
      ),
    ).toBeUndefined();
    // A send returns only after its card was confirmed: it went out, it is no draft.
    const sentCall = { ok: true, readOnly: false } as const;
    expect(turnWork("instantly__mail__activate_campaign", {}, sentCall)).toBe("sent");
    expect(turnWork("native_instantly_activate_campaign", {}, sentCall)).toBe("sent");
    expect(turnWork("mcp__gmail__send_message", {}, sentCall)).toBe("sent");
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
    // Checking the sending email reads it; only propose or confirm can change anything.
    expect(
      turnWork("instantly__mail__ensure_sender", { operation: "read" }, wrote),
    ).toBeUndefined();
    // Through the catalog the operation is nested in the call's arguments.
    expect(
      turnWork(
        "connectors_execute_tool",
        { id: "srv:native_instantly_ensure_sender", arguments: { operation: "read" } },
        wrote,
      ),
    ).toBeUndefined();
    expect(turnWork("instantly__mail__ensure_sender", { operation: "confirm" }, wrote)).toBe(
      "sender",
    );
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

  it("reports in Chinese to a recruiter writing Chinese", () => {
    expect(turnReportText(["feedback", "people_search"], 12, true)).toBe(
      "已完成：记下了你的反馈、搜索了候选人。这个岗位现在存了 12 人。",
    );
    expect(turnReportText(["feedback"], 12, true)).not.toMatch(/[A-Za-z]/);
  });

  // 11-12: "查了联系方式、在已连接的应用里做了修改" told the recruiter nothing.
  it("names a sender setup and drops the vague connected-app line beside named work", () => {
    expect(
      turnWork(
        "instantly__instantly__ensure_sender",
        { operation: "confirm" },
        {
          ok: true,
          readOnly: false,
          result: {},
        },
      ),
    ).toBe("sender");
    expect(turnReportText(["contacts", "connected"], undefined, true)).toBe(
      "已完成：查了联系方式。",
    );
    expect(turnReportText(["connected"])).toBe("Done: made changes in a connected app.");
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
    // 11-12: a one-off email outside a role, blamed on a permission.
    ["当前权限不支持创建一次性邮件，因此无法提交发送确认。", "decline"],
    ["需要开通支持单封邮件发送的权限后才能完成。", "decline"],
    ["I'm not permitted to send a one-off email from this conversation.", "decline"],
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
    "已发起连接请求，授权后就能读取你的日历。",
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

  // Gate 51d043cc, change-mind-mid-run: a template with no subject line was retried for its
  // "Would you be open…?", and the change came 26 s after the coordinator's line.
  it("reads an email without a subject line as the draft, not as a question", () => {
    expect(
      declinedSentence(
        "**首次触达邮件模板**\n\nHi {{firstName}},\n\nThe base is RMB 700,000–900,000. Would you be open to a brief conversation to learn more?\n\nBest,\nAlex Morgan",
      ),
    ).toBeUndefined();
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

  it("names calendar tools for a booking, not routine schedules", () => {
    const retry = declineRetry({
      reply: "I can't book this interview yet.",
      request: "帮第一个人约下周三下午的面试",
      tools: [{ name: "schedule_create" }, { name: "cal__main__create_booking" }],
      teammates: [],
    });
    expect(retry?.note).toContain("cal__main__create_booking");
    expect(retry?.note).not.toContain("schedule_create");
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

  it("does not read a lookup that rules out sending as a send request", () => {
    const reply =
      "Found 9 saved emails and checked the one gap.\n\nNo email was sent or activated.";
    expect(
      retryReason(reply, "Look up emails for the first 10 people. Do not send anything."),
    ).toBeUndefined();
    expect(retryReason(reply, "找邮箱，先不要发")).toBeUndefined();
    // A coordinator's handoff words its limit in other ways.
    for (const request of [
      "Goal: find contacts for the ten. No emails will be sent yet.",
      "Look up contact details; nothing should be sent.",
      "Find their emails before anything is sent.",
      "Get contacts. No outreach or sending.",
      "找联系方式，不发邮件",
    ])
      expect(retryReason(reply, request)).toBeUndefined();
    expect(retryReason(reply, "send them the email")?.kind).toBe("decline");
    expect(retryReason(reply, "Find contacts, then send them the email")?.kind).toBe("decline");
    // A teammate's brief that mentions sending is read against the recruiter's own words.
    const brief = "Goal: find contacts for the ten so we can send outreach after review.";
    expect(
      retryReason("Found 7 emails. No messages were sent.", brief, "找contact"),
    ).toBeUndefined();
    expect(retryReason("Found 7 emails. No messages were sent.", brief, "发20个人")?.kind).toBe(
      "decline",
    );
  });

  // Stage 5fcecbb8, first-timer-no-gmail: 「不连邮箱能直接发邮件给候选人吗」 was answered 「不能…」,
  // then retried as a declined send, and the recruiter got the same answer twice more.
  it("does not read whether something can be done without a precondition as a request for it", () => {
    const reply =
      "不能。邮件必须从你的 Gmail 发出；连接后，我会先给你确认发送的邮件卡片，只有你按下“发送”才会发出。";
    for (const request of [
      "不连邮箱能直接发邮件给候选人吗",
      "没有 Gmail 可以发邮件吗？",
      "Can I send emails without connecting Gmail?",
    ])
      expect(retryReason(reply, request)).toBeUndefined();
    for (const request of ["能帮我发给他吗", "可以直接发给 Wei 吗", "can you send it to her?"])
      expect(retryReason(reply, request)?.kind).toBe("decline");
  });

  it("does not read a question about interviews as a booking request", () => {
    const reply =
      "Two interviews are coming up: Ana on Tuesday at 10:00 and Li on Thursday at 14:00. No invitation is sent.";
    for (const request of [
      "what interviews are coming up",
      "When is she available?",
      "show me my calendar this week",
      "下周有哪些面试",
    ])
      expect(retryReason(reply, request)).toBeUndefined();
    for (const request of [
      "schedule an interview with Ana",
      "cancel the interview",
      "reschedule Li to Friday",
      "book Ana for Tuesday",
      "帮我约她下周面试",
      "取消这个面试",
    ])
      expect(retryReason(reply, request)?.kind).toBe("decline");
  });

  it("catches a past-tense refusal of a send", () => {
    expect(
      declinedSentence(
        "I couldn’t stage the exact one-off email for approval: Aiyi is already in the role’s existing email sequence.",
      ),
    ).toBeDefined();
    expect(
      declinedSentence("I couldn’t check for an existing draft, so this is newly prepared here."),
    ).toBeUndefined();
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

  it("keeps a worked answer about upcoming interviews, whatever its coverage aside", () => {
    const retry = (request: string) =>
      declineRetry({
        reply:
          "No confirmed interviews are booked. Google Calendar isn’t connected, so I can’t verify interviews outside the connected scheduling records.",
        request,
        tools: [],
        teammates: [],
        worked: true,
      });
    expect(retry("What interviews do I have coming up?")).toBeUndefined();
    expect(retry("Book an interview with Ana for Tuesday at 2 pm")?.note).toMatch(/declined/);
  });

  it("keeps an answer read for a question that asks for nothing to be done", () => {
    const retry = (request: string, read: boolean) =>
      declineRetry({
        reply:
          "No confirmed interviews are booked. Google Calendar is not connected, so I can’t verify your full calendar.",
        request,
        tools: [],
        teammates: [],
        read,
      });
    expect(retry("What interviews do I have coming up?", true)).toBeUndefined();
    expect(retry("What interviews do I have coming up?", false)?.note).toMatch(/declined/);
    expect(retry("Find 20 more people for this role", true)?.note).toMatch(/declined/);
  });

  // verify-musthave 11-14: "drop the ones that don't show kafka" after a roles read got
  // "There isn't a saved list, so I can't drop anyone" with no retry.
  it("retries a refused instruction even after a read", () => {
    expect(
      declineRetry({
        reply:
          "There isn’t a saved role or candidate list to update, so I can’t drop anyone from the pool.",
        request: "ok drop the ones that don't show kafka then",
        tools: [],
        teammates: [],
        read: true,
      })?.note,
    ).toMatch(/declined/);
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

describe("readsOnly", () => {
  it("tells reads from work, so a read after a handoff leaves the request with the teammate", () => {
    expect(readsOnly("recruiting_candidates", { operation: "list" })).toBe(true);
    expect(readsOnly("recruiting_role", { operation: "update" })).toBe(false);
    expect(readsOnly("mcp__instantly__list_campaigns", {})).toBe(true);
    expect(readsOnly("mcp__instantly__activate_campaign", {})).toBe(false);
  });
});

describe("CLAIMS_CARD_PENDING", () => {
  // Staging 11-12: after the recruiter confirmed the Send card and the email went out.
  it("reads a reply that says the card still waits or the email is not sent", () => {
    expect(
      CLAIMS_CARD_PENDING.test(
        "已核实：当前的审批卡仍待你确认；审批未完成前我不会重复创建或发送。",
      ),
    ).toBe(true);
    expect(CLAIMS_CARD_PENDING.test("核对结果：没有可确认的发送回执，目前状态为**未发送**。")).toBe(
      true,
    );
    expect(CLAIMS_CARD_PENDING.test("初次联系邮件已发出，收件人仅为 Noah Test。")).toBe(false);
  });
});

// Gate 19bf5552, progress-and-where: every answer ended with the same 「发来职位描述…」.
describe("withoutRepeatedClosing", () => {
  const earlier =
    "目前没有已保存的岗位，也没有候选人搜索或其他进展记录。发来职位描述，或提供职位名称、地点和必备条件，我就可以开始。";
  it("drops a closing line this bot already ended on", () => {
    expect(
      withoutRepeatedClosing(
        "候选人和回复分别在左侧的「候选人」和「收件箱」里查看；目前还没有资料或回复可看。发来职位描述，或职位名称、地点和必备条件，我就可以开始。",
        [earlier],
      ),
    ).toBe("候选人和回复分别在左侧的「候选人」和「收件箱」里查看；目前还没有资料或回复可看。");
  });
  it("drops the same invitation reworded, after a 「；」", () => {
    expect(
      withoutRepeatedClosing(
        "左侧「候选人」看候选人；点候选人姓名，再到「收件箱」看他/她的邮件和回复。现在还没有岗位或候选人记录；发来职位描述，或告诉我职位名称、地点和必备条件，我就可以开始。",
        [
          "目前没有已保存的岗位。把职位描述发给我，或告诉我职位名称、地点和必备条件，我就从这里开始。",
        ],
      ),
    ).toBe(
      "左侧「候选人」看候选人；点候选人姓名，再到「收件箱」看他/她的邮件和回复。现在还没有岗位或候选人记录。",
    );
  });
  it("keeps a new closing line, a question, and a reply that is only that line", () => {
    const fresh = "候选人在左侧的「候选人」里。现在把职位描述发来即可。";
    expect(withoutRepeatedClosing(fresh, [earlier])).toBe(fresh);
    const asked = "草稿在上面。Wei 的邮箱是什么？";
    expect(withoutRepeatedClosing(asked, ["我写好了草稿。Wei 的邮箱是什么？"])).toBe(asked);
    const only = "发来职位描述，或提供职位名称、地点和必备条件，我就可以开始。";
    expect(withoutRepeatedClosing(only, [earlier])).toBe(only);
  });
});

describe("restatesUpdate", () => {
  const update =
    "The search has brought the role’s Results pool to 122 people, above your target of 100. I included San Francisco Bay Area profiles as a preferred search segment while keeping Atlanta onsite as the role’s primary location.";

  it("drops a final reply that says the same thing again", () => {
    expect(
      restatesUpdate(
        "The search now has **122 people** in Results, exceeding your target of 100. I included San Francisco Bay Area profiles as a preferred search segment and kept Atlanta onsite as the primary location.",
        update,
      ),
    ).toBe(true);
    // A first round finished in the background said it once before its final reply.
    expect(
      restatesUpdate(
        "Recorded the first 10-person review set and saved the role brief, including **Chinese preferred; English assumed**. The candidates and their profile passages are shown above.",
        "Recorded the first 10-person review set for the Atlanta on-site Warehouse Operations Manager role, with Chinese preferred and English assumed. The role brief is saved; the first review set includes the candidates and profile passages shown above.",
      ),
    ).toBe(true);
    // The update already asked the question; the final reply asks it again.
    expect(
      restatesUpdate(
        "Which candidates should I email, and what should the email be about?",
        "I checked your active roles and existing outreach, and there are no candidates or prior emails available in this conversation to act on. Which candidates should I email, and what should the email be about?",
      ),
    ).toBe(true);
  });

  it("keeps a reply with new content or no update before it", () => {
    expect(
      restatesUpdate("Here is the draft email for Ada: Hi Ada, I saw your work at DHL.", update),
    ).toBe(false);
    expect(
      restatesUpdate(
        `${update} Here is the full list of all 122 people with their titles, locations, evidence and what is still unverified for each of them.`,
        update,
      ),
    ).toBe(false);
    expect(restatesUpdate("Found 122 people.", undefined)).toBe(false);
  });

  // send-at-night 11-14: each role report of the same timeout went out again in Chinese.
  it("compares Chinese by its characters, not as one long word", () => {
    const said =
      "0232 岗位刚刚再次检查：邮件服务仍然连接超时，Noah Liu 和 Ada Chen 的首封邮件都没有保存，也没有生成发送确认卡，因此目前两人都还没有收到邮件。阻塞原因仍是邮件服务连接问题。";
    expect(
      restatesUpdate(
        "0232 岗位检查时，邮件服务仍连接超时；Noah Liu 和 Ada Chen 的首封邮件都没有保存，也没有生成发送确认卡，两人都还没有收到邮件。仍被邮件服务连接问题卡住。",
        said,
      ),
    ).toBe(true);
    expect(restatesUpdate("Noah 的邮件已经发出，Ada 的明早 9 点发出。", said)).toBe(false);
  });
});

describe("lastOwnUpdate", () => {
  const text = (value: string) => [{ kind: "text", text: value }];
  const relay = [{ kind: "bot_message_received", text: "report" }];
  it("is this bot's newest reply when the recruiter has not written since", () => {
    expect(
      lastOwnUpdate(
        [
          { role: "user", botId: null, blocks: relay },
          { role: "assistant", botId: "main", blocks: text("still timing out") },
          { role: "user", botId: null, blocks: text("send it now") },
        ],
        "main",
      ),
    ).toBe("still timing out");
    expect(
      lastOwnUpdate(
        [
          { role: "user", botId: null, blocks: text("send it now") },
          { role: "assistant", botId: "main", blocks: text("still timing out") },
        ],
        "main",
      ),
    ).toBeUndefined();
    expect(
      lastOwnUpdate([{ role: "assistant", botId: "other", blocks: text("x") }], "main"),
    ).toBeUndefined();
  });
});

describe("TurnReportLedger.memorySaveFailed", () => {
  it("is true only when every memory save in the attempt failed", () => {
    const ledger = new TurnReportLedger(true);
    expect(ledger.memorySaveFailed()).toBe(false);
    ledger.tool("a", "remember", {});
    ledger.settle("a", { ok: false });
    ledger.tool("b", "save_shared_memory", {});
    ledger.settle("b", { ok: false });
    expect(ledger.memorySaveFailed()).toBe(true);
    ledger.tool("c", "remember", {});
    ledger.settle("c", { ok: true });
    expect(ledger.memorySaveFailed()).toBe(false);
  });
});

// Gate 398accae, change-mind: 「邮件里加每周五远程」 became "one remote workday each week".
describe("droppedDay", () => {
  const draft = (line: string) =>
    `Subject: Staff Frontend Engineer\n\nHi {{firstName}},\n\n${line}\n\nBest,\nAlex`;
  it("retries a draft that lost the weekday the recruiter named", () => {
    expect(
      droppedDay(
        draft("It includes one remote workday each week."),
        "base改70-90万，邮件里加每周五远程",
      ),
    ).toMatchObject({ note: expect.stringContaining("Friday") });
  });
  it("keeps a draft that names the day, and a count of days", () => {
    expect(droppedDay(draft("It is remote every Friday."), "邮件里加每周五远程")).toBeUndefined();
    expect(droppedDay(draft("It is on site five days a week."), "每周五天坐班")).toBeUndefined();
    expect(droppedDay("好的，已记下每周五远程。", "每周五远程")).toBeUndefined();
  });
});

// Gate f25185df, change-mind-mid-run: 「一句话说下改了啥，最终版是哪封」 got the line and the whole
// email pasted again.
// Gate 51d043cc, change-mind-mid-run: 「帮我写封首次触达邮件模板」 got a three-email sequence.
describe("sequenceForOneEmail", () => {
  const sequence =
    "**邮件 1｜第 0 天**\n**Subject:** Hi\n\nBody\n\n**邮件 2｜第 3 天**\n**Subject:** Re: Hi\n\nBody";
  it("retries a sequence when one email was asked for", () => {
    expect(sequenceForOneEmail(sequence, "帮我写封首次触达邮件模板")).toBeDefined();
    expect(sequenceForOneEmail(sequence, "write a short cold email")).toBeDefined();
  });
  it("keeps a sequence that was asked for", () => {
    expect(sequenceForOneEmail(sequence, "帮我写封邮件，再加两封跟进序列")).toBeUndefined();
    expect(sequenceForOneEmail(sequence, "写一个触达序列")).toBeUndefined();
  });
});

describe("repastedDraft", () => {
  const email =
    "**Subject:** Staff Frontend Engineer\n\nHi {{firstName}},\n\n• Working remotely every Friday\n\nBest,\nAlex";
  it("retries a reply that pastes an email already shown", () => {
    expect(
      repastedDraft(
        `改为 base 70–90万，加入每周五远程；最终版如下：\n\n${email.replace("•", "-")}`,
        [`${email}\n\nIf you'd rather not hear from me, just reply.`],
        "一句话说下改了啥，最终版是哪封",
      ),
    ).toMatchObject({ note: expect.stringContaining("already shown") });
  });
  it("keeps a changed email, and one the recruiter asked to see again", () => {
    expect(repastedDraft(email.replace("Friday", "Monday"), [email], "改成周一")).toBeUndefined();
    expect(repastedDraft(email, [email], "把完整版再发一遍")).toBeUndefined();
    // Gate 386f6a46: 「直接贴那一封」 got a description of the email instead of the email.
    expect(repastedDraft(email, [email], "到底哪封是最终？直接贴那一封")).toBeUndefined();
  });
});

// Gate 95185659: after the teammate reported, the coordinator handed it the same recruiter
// message again, and the second answer contradicted the first.
describe("quotesMessage", () => {
  it("finds the recruiter's words in a brief that quotes them", () => {
    const message = "给 Wei Zhang 写封邮件，fintech 那个职位 wei.zhang.test@example.com";
    expect(quotesMessage(`Goal: “${message}”。Where: this shared thread`, message)).toBe(true);
    expect(
      quotesMessage(
        "Goal: 更新模板，用户补充“base改70-90万 另外加一条每周五remote”。",
        "等等 base改70-90万 另外加一条每周五remote",
      ),
    ).toBe(true);
  });
  it("does not match a brief about something else, or a message too short to tell", () => {
    expect(
      quotesMessage("Goal: find contacts for the ten people above", "给 Wei Zhang 写封邮件"),
    ).toBe(false);
    expect(quotesMessage("Goal: 好的，继续", "好")).toBe(false);
  });
});

describe("draftAskedBeforeShown", () => {
  it("holds a question until the email asked for is written", () => {
    // Gates 808f4f31, df83586a, aceb80c9: questions about the role came before any draft.
    const ask = "帮我给 Wei Zhang 写封邮件，fintech 那个职位";
    expect(draftAskedBeforeShown(ask, "我先为 Wei Zhang 起草邮件。")).toBe(true);
    expect(draftAskedBeforeShown(ask, "**Subject:** Backend Go\n\nHi Wei,")).toBe(false);
    expect(draftAskedBeforeShown("帮我回复 Wei Zhang 的邮件", "")).toBe(false);
    expect(draftAskedBeforeShown("给前 10 个人发邮件", "")).toBe(false);
    expect(draftAskedBeforeShown("Draft an email to Wei Zhang", "")).toBe(true);
    expect(draftAskedBeforeShown("草稿还在吗", "")).toBe(false);
    expect(draftAskedBeforeShown("is the draft still there?", "")).toBe(false);
  });
});

// Gate e7805c70, change-mind: asked for one line on what changed, the reply pasted the same
// email again under its lead, and the recruiter had to ask a second time.
describe("withoutRepastedDraft", () => {
  const email =
    "**Subject:** Staff Frontend Engineer\n\nHi {{firstName}},\n\n- Remote every Friday\n\nBest,\nAlex";
  const shown = [`已将薪资改为 70–90万，并加入每周五远程：\n\n${email}`];
  it("keeps only the lead of a reply that pastes an email already shown", () => {
    expect(
      withoutRepastedDraft(
        `改为 base 70–90万，并加入每周五远程；最终版就是上面那封。以下是最终模板：\n\n${email}`,
        shown,
        "一句话说下改了什么，确认最终版是新的",
      ),
    ).toBe("改为 base 70–90万，并加入每周五远程；最终版就是上面那封。");
  });
  it.each([
    ["a changed email", `改了签名：\n\n${email.replace("Alex", "David")}`, "签名改成 David"],
    ["one asked for again", `完整版：\n\n${email}`, "把完整版再发一遍"],
    ["an email with no lead", email, "最终版是哪封"],
  ])("keeps %s", (_, reply, asked) => {
    expect(withoutRepastedDraft(reply, shown, asked)).toBe(reply);
  });
});

describe("narratesRecords", () => {
  it("catches a reply that reads out the records instead of answering", () => {
    // Gate e7805c70: change-mind-mid-run and first-timer-no-gmail.
    const ask = "一句话说下改了什么，确认最终版是新的";
    expect(narratesRecords(ask, "当前记录显示岗位和邮件序列均为 0；以下是修订后的最终模板")).toBe(
      true,
    );
    expect(narratesRecords("发了吗", "记录里没有这封邮件的发送。")).toBe(true);
    expect(narratesRecords("did it send?", "The records show no campaign yet.")).toBe(true);
    expect(narratesRecords(ask, "我把底薪改为 70万–90万元，并加了每周五远程。")).toBe(false);
    expect(narratesRecords("约了吗", "面试记录里还没有他。")).toBe(false);
    expect(narratesRecords("记录里有他吗", "记录里没有他。")).toBe(false);
    // Gate 686a9eae: first-timer-no-gmail.
    expect(narratesRecords("Sequence 页是干嘛的", "我查了当前记录：没有邮件序列记录。")).toBe(true);
    expect(narratesRecords("发了吗", "还没发，发送记录里会显示。")).toBe(false);
  });
});
