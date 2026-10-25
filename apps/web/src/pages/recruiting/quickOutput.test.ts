import { describe, expect, it } from "vitest";
import { historyNoteText, quickOutput, withoutProvenance } from "./quickOutput";

const field = (label: string, value: string) => ({ label, value, sourceUrls: [] });
const NOTE = "（来源 2026-10-23 provider档案保留引语（非本次读取；当前LinkedIn页面403））";

describe("quickOutput", () => {
  it("reads the Chinese-named columns as the research agent returns them", () => {
    const { quick, briefs, placed } = quickOutput([
      field(
        "Summary zh",
        "候选人A 现任 公司A 分公司经理（Branch Manager），所在地为 城市A；资料仅来自搜索索引片段（读取日期 2026-10-24）。",
      ),
      field(
        "Highlight tags zh",
        `自动化分拣设备实操（配置与校准分拣机，来源 2026-10-23 provider档案保留引语（非本次读取；当前LinkedIn页面403））；Microsoft Excel${NOTE}；末公里运营与 3PL 运营（个人标题片段，读取 2026-10-24）`,
      ),
      field(
        "Representative work zh",
        "记录中可引用的本人表述（均出自搜索索引片段，读取日期 2026-10-23）：1）“Configured and calibrated sorting machines;”——本人对分拣机的配置与校准；2）“ensured SOP execution”——SOP 执行与 KPI 管理。以上为片段引语，非完整履历；团队能力不等于本人实操。来源链接：https://example.com/in/a（页面 403）。",
      ),
      field(
        "Concerns zh",
        "1）资料局限：主页 https://example.com/in/a 于 2026-10-24 返回 403，原始档案不可得；2）一线团队管理（含劳务派遣人员）无逐字证据，仅见转述；3）长期下午/夜班意愿未知（过往班次不等于意愿）；4）美国工作授权未知。",
      ),
      field(
        "Criterion brief zh",
        `硬要求1 仓储/履约/末端运营经验：已证实 — “Managed warehouse”，标题为 Last-Mile Operations &amp;amp; 3pl${NOTE}；年限未标注。\n优先项2 OSHA/仓库安全：未知 — 记录中无相关证据。`,
      ),
      field(
        "Mentioned orgs zh",
        `任职公司：公司A（现职 Branch Manager，来源已保存现职信息，读取 2026-10-23）；公司B（Associate Manager 角色，来源 2026-10-23）。仅提及组织：公司A 官网 https://www.company-a.example/（一方主页，读取 2026-10-24）。学校（仅片段，非学历证明）：学校A（仅搜索索引片段，读取 2026-10-24）。`,
      ),
      field("Hometown", "kept"),
    ]);
    expect(quick.headline).toBe("候选人A 现任 公司A 分公司经理（Branch Manager），所在地为 城市A");
    expect(quick.highlights).toEqual([
      "自动化分拣设备实操",
      "Microsoft Excel",
      "末公里运营与 3PL 运营",
    ]);
    expect(quick.keyWorks.map((work) => work.title)).toEqual([
      "本人对分拣机的配置与校准",
      "SOP 执行与 KPI 管理",
    ]);
    expect(quick.concerns).toEqual([
      "资料局限：主页 于 2026-10-24 返回 403",
      "一线团队管理（含劳务派遣人员）无逐字证据",
      "长期下午/夜班意愿未知（过往班次不等于意愿）",
    ]);
    expect(briefs).toEqual([
      { key: null, index: 0, brief: { name: "仓储/履约/末端运营经验", verdict: "已证实" } },
      { key: null, index: 1, brief: { name: "OSHA/仓库安全", verdict: "未知" } },
    ]);
    expect(quick.entities).toEqual([
      {
        name: "公司A",
        kind: "任职公司",
        host: "www.company-a.example",
        description: "现职 Branch Manager",
      },
      { name: "公司B", kind: "任职公司", host: null, description: "Associate Manager 角色" },
      { name: "学校A", kind: "学校", host: null, description: null },
    ]);
    expect(placed.map((item) => item.label)).not.toContain("Hometown");
  });

  it("reads the requested English columns and their pipe entries", () => {
    const { quick, briefs } = quickOutput([
      field("Headline", "斯坦福博士，移动操作一作"),
      field("Highlights", "斯坦福 CS 博士\n湾区"),
      field("Key works", "BRS | CoRL 2025 | 一作 | https://example.test/brs"),
      field("Criteria brief", "rule_bay_area_based | 常驻湾区 | 人在湾区"),
      field("Entities", "Stanford University | school | https://www.stanford.edu | 湾区研究型大学"),
    ]);
    expect(quick).toMatchObject({
      headline: "斯坦福博士，移动操作一作",
      highlights: ["斯坦福 CS 博士", "湾区"],
      keyWorks: [{ title: "BRS", detail: "CoRL 2025 · 一作", url: "https://example.test/brs" }],
      entities: [
        {
          name: "Stanford University",
          kind: "school",
          host: "www.stanford.edu",
          description: "湾区研究型大学",
        },
      ],
    });
    expect(briefs[0]).toMatchObject({
      key: "rule_bay_area_based",
      brief: { name: "常驻湾区", verdict: "人在湾区" },
    });
  });

  it("keeps brackets that are not lookup notes exactly as written", () => {
    expect(withoutProvenance("Engineer, Acme (2021–Present, Remote)")).toBe(
      "Engineer, Acme (2021–Present, Remote)",
    );
  });
});

describe("historyNoteText", () => {
  it("reduces an education note to the school it names", () => {
    expect(
      historyNoteText(
        "Institution only (search-index snippet, checked 2026-10-24): 学校A. Degree, field and dates unknown (not in any readable source; LinkedIn page 403). Snippet-level association only.",
        true,
      ),
    ).toBe("学校A");
  });

  it("leaves ordinary history untouched", () => {
    const value =
      "Stanford University | M.S., Computer Science | https://stanford.example.edu | 2016 – 2018";
    expect(historyNoteText(value, true)).toBe(value);
  });
});
