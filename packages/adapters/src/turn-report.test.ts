import { describe, expect, it } from "vitest";
import { readsOnly, TurnReportLedger, turnReportText, turnWork } from "./turn-report.js";

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

  it("treats a recorded round as its own report", () => {
    const ledger = new TurnReportLedger(true);
    ledger.tool("1", "exa__web_search_advanced_exa", { query: "x" });
    ledger.tool("3", "recruiting_research", { operation: "calibration_round" });
    expect(ledger.owed()).toEqual([]);
    expect(ledger.lastWork()).toBe("round");
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
  it("names the work and no head count", () => {
    expect(turnReportText(["people_search", "people_search", "people_saved"])).toBe(
      "Done: searched for people, saved people to the role.",
    );
    expect(turnReportText(["draft"])).toBe("Done: saved the email draft.");
  });

  it("reports in Chinese to a recruiter writing Chinese", () => {
    expect(turnReportText(["feedback", "people_search"], true)).toBe(
      "已完成：记下了你的反馈、搜索了候选人。",
    );
    expect(turnReportText(["feedback"], true)).not.toMatch(/[A-Za-z]/);
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
    expect(turnReportText(["contacts", "connected"], true)).toBe("已完成：查了联系方式。");
    expect(turnReportText(["connected"])).toBe("Done: made changes in a connected app.");
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
