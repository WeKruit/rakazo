import { describe, expect, it } from "vitest";
import {
  draftAskedBeforeShown,
  questionStatesWork,
  REPORT_BEFORE_ASK,
  lastOwnUpdate,
  restatesUpdate,
  withoutRepeatedClosing,
  withoutRepeatedOpening,
  readsOnly,
  CLAIMS_CARD_PENDING,
  TurnReportLedger,
  turnReportText,
  turnWork,
  repastedDraft,
  withoutRepastedDraft,
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

// Sim cannot-do-that-honestly on 982a0ac9: Kruit said 「这里无法发送 LinkedIn InMail，也没有发送任何
// 内容。」, then the writer's retried reply opened with the same line before its draft.
describe("withoutRepeatedOpening", () => {
  const shown = ["这里无法发送 LinkedIn InMail，也没有发送任何内容。"];
  const draft =
    "以下是可直接粘贴的消息：\n\n**主题：Staff ML 职位**\n\nHi Li Wei,\n\nA role.\n\nBest,\nAlex Morgan";
  it("drops an opening line the chat already shows", () => {
    expect(
      withoutRepeatedOpening(`无法发送 LinkedIn InMail；没有发送任何内容。${draft}`, shown),
    ).toBe(draft);
  });
  it("keeps a new opening and a reply that is only that line", () => {
    const fresh = `未找到 Li Wei 的已保存资料。${draft}`;
    expect(withoutRepeatedOpening(fresh, shown)).toBe(fresh);
    const only = "无法发送 LinkedIn InMail；没有发送任何内容。";
    expect(withoutRepeatedOpening(only, shown)).toBe(only);
  });
  // Gate 4a731582, change-mind-mid-run 3/10 and 4/10: the revised template's Subject line matched
  // the first draft's and was dropped, so every later paste showed the email without it.
  it("keeps a draft's own lines, whatever the chat already shows", () => {
    const subject = "**Subject:** Staff Frontend Engineer | React | Beijing";
    const revised = `${subject}\n\nHi {{firstName}},\n\nThe base is RMB 700,000–900,000.\n\nBest,\nAlex`;
    expect(withoutRepeatedOpening(revised, [`${subject}\n\nHi {{firstName}},`])).toBe(revised);
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
