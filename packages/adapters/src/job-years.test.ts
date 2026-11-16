import { describe, expect, it } from "vitest";
import {
  askedForRoleInsteadOfOpening,
  describesRole,
  intakeFields,
  intakeFieldsNote,
  jobStatesYears,
  openFactAsked,
  settledFactAsked,
} from "./intake-open-fields.js";

describe("jobStatesYears", () => {
  it("finds a stated years requirement", () => {
    expect(jobStatesYears("Requires 3+ years of CAD work")).toBe(true);
    expect(jobStatesYears("2-5 years in livestream ops")).toBe(true);
    expect(jobStatesYears("5 yrs experience")).toBe(true);
    expect(jobStatesYears("3年以上经验")).toBe(true);
  });

  it("treats a JD with no years as open", () => {
    expect(
      jobStatesYears("R&D Engineer, Dallas TX. $80K–100K. 3D-scan vehicles and export STP files."),
    ).toBe(false);
  });
});

describe("intakeFields", () => {
  // Staging 11-15 gates 398accae and 95185659 asked about all three for this JD.
  it("leaves nothing open when the JD states the place with its work mode, years and no second language", () => {
    const fields = intakeFields(
      "Senior Data Engineer — Seattle, WA (hybrid, 3 days on site). Requirements: 6+ years of data engineering. Salary $170k–$200k.",
    );
    expect(fields.open).toEqual([]);
    expect(fields.settled[0]).toContain("Seattle, WA, within 50 miles");
  });

  it("settles a Chinese JD's 常驻 city and years", () => {
    expect(
      intakeFields("新岗位：华东区销售总监，常驻上海，医疗器械行业，10年以上销售经验").open,
    ).toEqual([]);
  });

  it("leaves the work mode, years and a named language open when the JD does not settle them", () => {
    const fields = intakeFields("R&D Engineer, Dallas TX. Mandarin speakers welcome. $80K–100K.");
    expect(fields.open).toHaveLength(3);
  });
});

describe("settledFactAsked", () => {
  const seattle =
    "Senior Data Engineer — Seattle, WA (hybrid, 3 days on site). Requirements: 6+ years of data engineering.";
  const shanghai =
    "新岗位：华东区销售总监，常驻上海，10年以上销售经验。必须会说普通话和英语，必须有三甲医院渠道资源。";

  // The cards staging gate 2e9712be still showed for these JDs.
  it("finds a question about a fact the recruiter's words settle", () => {
    expect(
      settledFactAsked(
        "For the required 6+ years in data engineering, what upper experience range should I target?",
        seattle,
      ),
    ).toBe("years");
    expect(settledFactAsked("你更希望把岗位设为哪个工作范围？", seattle)).toBe("location");
    expect(
      settledFactAsked(
        "这个岗位的普通话和英语，您希望都作为必须条件，还是英语优先即可？",
        shanghai,
      ),
    ).toBe("language");
  });

  it("lets a question about an open fact through", () => {
    expect(
      settledFactAsked(
        "这个岗位的工作地点和办公方式是什么？",
        "奥斯汀 backend 工程师，要会 Go，五年以上经验",
      ),
    ).toBeUndefined();
    expect(
      settledFactAsked("Which peer companies should I target first?", seattle),
    ).toBeUndefined();
  });
});

// 11-15 card tap 「先出前十个，再问」: search first; one open fact may be asked beside the ten.
describe("search first, then ask", () => {
  it("tells the first step to search with no question, even with facts open", () => {
    const note = intakeFieldsNote("Backend engineer, Go, payments. $190k–$230k.");
    expect(note).toContain("issue the calibration people searches now");
    expect(note).toContain("After the ten are recorded");
    expect(note).not.toContain("Ask the first clarifying question");
  });

  it("lets the one question beside the ten ask an open fact, not a settled one", () => {
    const words = "Backend engineer in Austin, TX, Go, 5+ years";
    expect(openFactAsked("Is this role onsite, hybrid or remote?", words)).toBe("location");
    expect(openFactAsked("What years range should I target?", words)).toBeUndefined();
  });

  it("asks first only when the recruiter has not said what role it is", () => {
    expect(describesRole("find me some people")).toBe(false);
    expect(describesRole("Senior SRE, Austin TX onsite, 6+ years")).toBe(true);
    expect(describesRole("那我第一步该干嘛，想找个后端的")).toBe(true);
  });

  it("catches a reply that asks for a described role's JD instead of opening it", () => {
    // Gate b2005684, progress-and-where.
    const ask = "那我第一步该干嘛，想找个后端的";
    expect(askedForRoleInsteadOfOpening(ask, "把职位描述贴给我，或发一行地点和必备条件。")).toBe(
      true,
    );
    expect(askedForRoleInsteadOfOpening(ask, "已开始找后端工程师，十个人很快就到。")).toBe(false);
    expect(askedForRoleInsteadOfOpening("最近进展怎么样了", "把职位描述发来，我就可以开始。")).toBe(
      false,
    );
  });
});
