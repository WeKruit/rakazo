import { describe, expect, it } from "vitest";
import { projectMessageReactions } from "./message-reactions.js";
import { nextPlaybookStep } from "./recruiting-playbook.js";
import { scrubVendorBlocks, scrubVendorNames } from "./vendor-names.js";

describe("scrubVendorNames", () => {
  it("replaces vendor names in Chinese text without leaving spaces", () => {
    expect(scrubVendorNames("回复到同一个 Autumn 任务，由它处理反馈")).toBe(
      "回复到同一个搜寻任务，由它处理反馈",
    );
    expect(scrubVendorNames("Autumn 返回了 10 人，ContactOut 补全了邮箱")).toBe(
      "搜寻返回了 10 人，联系方式补全补全了邮箱",
    );
  });

  it("uses English words in English text and keeps ordinary words", () => {
    expect(scrubVendorNames("Autumn's shortlist came back via Coresignal.")).toBe(
      "search shortlist came back via profile data.",
    );
    expect(scrubVendorNames("Instantly, we saw replies in autumn.")).toBe(
      "Instantly, we saw replies in autumn.",
    );
    expect(scrubVendorNames("see https://autumn.example/x and ann@autumn.ai")).toBe(
      "see https://autumn.example/x and ann@autumn.ai",
    );
  });

  it("scrubs readable blocks but leaves approval asks and connect cards byte-exact", () => {
    const approval = {
      kind: "ask" as const,
      text: "Send to Autumn?",
      approvalEvidenceHash: "a".repeat(64),
    };
    const connect = { kind: "connect" as const, provider: "autumn", name: "Autumn" } as never;
    const [text, ask, kept, card] = scrubVendorBlocks([
      { kind: "text", text: "Autumn 正在找人" },
      approval,
      connect,
      { kind: "card", lines: [{ k: "来源", v: "LeadMagic" }] },
    ]);
    expect(text).toEqual({ kind: "text", text: "搜寻正在找人" });
    expect(ask).toBe(approval);
    expect(kept).toBe(connect);
    expect(card).toEqual({ kind: "card", lines: [{ k: "来源", v: "contact lookup" }] });
  });
});

describe("vendor-free recruiter surfaces", () => {
  it("no playbook step names a vendor", () => {
    for (const stage of ["intake", "calibration_10", "feedback", "scale", "enrichment"] as const) {
      const step = nextPlaybookStep(stage, { title: "x", hasBrief: true, savedCandidates: 10 });
      expect(`${step?.label}${step?.prompt}`).not.toMatch(/Autumn|Coresignal|ContactOut/);
    }
  });

  it("hides server-generated continuations from the conversation", () => {
    const { visibleMessages } = projectMessageReactions([
      { id: "a", role: "user", blocks: [{ kind: "text", text: "hi" }] },
      { id: "b", role: "system", internal: true, blocks: [{ kind: "text", text: "继续下一步" }] },
    ]);
    expect(visibleMessages.map((message) => message.id)).toEqual(["a"]);
  });
});
