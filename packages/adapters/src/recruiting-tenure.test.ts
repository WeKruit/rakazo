import { describe, expect, it } from "vitest";
import { shortCurrentTenure } from "./recruiting-tenure.js";

const now = new Date("2026-10-27T00:00:00Z");

describe("shortCurrentTenure", () => {
  it("flags a current role started under six months ago", () => {
    expect(
      shortCurrentTenure("May 2026 - Present (4 months) in Azle, Texas, United States", now),
    ).toBe(4);
    expect(shortCurrentTenure("Started Jul 2026 – Present at Acme", now)).toBe(3);
  });

  it("leaves longer, ended or unstated roles alone", () => {
    expect(shortCurrentTenure("Jan 2026 - Present (9 months) in Dallas", now)).toBeNull();
    expect(shortCurrentTenure("Aug 2022 - Present (4 years and 2 months)", now)).toBeNull();
    expect(shortCurrentTenure("Mar 2015 - Jan 2022 (6 years and 10 months)", now)).toBeNull();
    expect(shortCurrentTenure("CMM programmer with Zeiss experience", now)).toBeNull();
    expect(shortCurrentTenure(null, now)).toBeNull();
  });

  it("keeps someone whose main current role is long beside a new side role", () => {
    expect(
      shortCurrentTenure(
        "Jul 2015 - Present (11 years and 2 months) ... Aug 2026 - Present (2 months) consultant",
        now,
      ),
    ).toBeNull();
  });
});
