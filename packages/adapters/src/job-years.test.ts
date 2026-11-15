import { describe, expect, it } from "vitest";
import { intakeFields, jobStatesYears } from "./intake-open-fields.js";

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
    const fields = intakeFields("R&D Engineer, Dallas TX. Mandarin a plus. $80K–100K.");
    expect(fields.open).toHaveLength(3);
  });
});
