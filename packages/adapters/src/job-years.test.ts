import { describe, expect, it } from "vitest";
import { jobStatesYears } from "./executor";

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
