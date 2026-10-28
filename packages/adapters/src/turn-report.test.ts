import { describe, expect, it } from "vitest";
import {
  declinedSentence,
  declineRetry,
  questionStatesWork,
  REPORT_BEFORE_ASK,
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

describe("declineRetry", () => {
  const replyThread =
    "I can't send this message through the available approval flow: it requires replying to an existing email.";
  const notReady = "Not ready to send: contact history and suppression unknown.";
  it("detects the declines seen in regression runs", () => {
    expect(declinedSentence(replyThread)).toBe(replyThread);
    expect(declinedSentence(notReady)).toBe(
      "Not ready to send: contact history and suppression unknown.",
    );
    expect(declinedSentence("Added 70 people. The pool is now 139.")).toBeUndefined();
  });

  it("names this bot's own tool first", () => {
    const retry = declineRetry({
      reply: replyThread,
      request: "send this email to them",
      tools: [{ name: "recruiting_role" }, { name: "instantly__mail__activate_campaign" }],
      teammates: [],
    });
    expect(retry?.note).toContain("instantly__mail__activate_campaign");
    expect(retry?.note).toContain("confirmation card");
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

  it("keeps a decline nobody can do, or one about other work", () => {
    expect(
      declineRetry({ reply: notReady, request: "send it", tools: [], teammates: [] }),
    ).toBeUndefined();
    // The declined sentence is about verification, not the requested search.
    expect(
      declineRetry({
        reply: "Added 20 people. I can't verify tenure for three of them.",
        request: "find 20 more",
        tools: [{ name: "exa__web_search_advanced_exa" }],
        teammates: [],
      }),
    ).toBeUndefined();
  });
});
