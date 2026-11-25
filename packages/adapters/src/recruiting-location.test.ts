import { describe, expect, it } from "vitest";
import { localRolePlace, namedPlace } from "./recruiting-location.js";

describe("namedPlace", () => {
  const queries = [
    "Maintenance engineers within 30 miles of Linden, NJ 07036 with 3+ years",
    "Bilingual Mandarin-English engineers near Linden, New Jersey with PLC work",
    "Automation technicians in the Linden NJ area",
    "PLC technicians in New Jersey",
  ];

  it("finds the city the searches name, not a capitalised word before it", () => {
    expect(namedPlace(queries)?.label).toBe("Linden, NJ");
    expect(namedPlace(["Engineers in New York, NY", "New York, NY"])?.label).toBe("New York, NY");
    expect(namedPlace(["PLC technicians in New Jersey", "Remote engineers"])).toBe(undefined);
  });
});

describe("localRolePlace", () => {
  it("holds an on-site or commuting role to its city, never a remote or relocation one", () => {
    expect(localRolePlace(["On-site within 30 miles of Linden, NJ 07036"])?.label).toBe(
      "Linden, NJ",
    );
    expect(localRolePlace(["Engineers in Austin, TX"])).toBe(undefined);
    expect(localRolePlace(["On-site, not remote, near Austin, TX"])?.label).toBe("Austin, TX");
    expect(localRolePlace(["Hybrid near Austin, TX", "Relocation offered"])).toBe(undefined);
    expect(localRolePlace(["Remote; team based near Austin, TX"])).toBe(undefined);
  });
});
