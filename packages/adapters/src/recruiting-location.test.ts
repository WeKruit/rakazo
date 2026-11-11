import { describe, expect, it } from "vitest";
import {
  beyondCommute,
  isRegionOnlyLocation,
  localRolePlace,
  locate,
  locationOutliers,
  namedPlace,
  outsideSearchArea,
} from "./recruiting-location.js";

describe("isRegionOnlyLocation", () => {
  it.each(["United States", "USA", "Georgia, United States", "Texas", "", null, undefined])(
    "treats %s as only a country or a state",
    (location) => expect(isRegionOnlyLocation(location)).toBe(true),
  );
  it.each([
    "Atlanta, Georgia, United States",
    "Greater Atlanta Area",
    "Hoschton, Georgia, United States",
    "New York, New York, United States",
  ])("keeps %s", (location) => expect(isRegionOnlyLocation(location)).toBe(false));
});

describe("locationOutliers", () => {
  const atlanta: [string, string][] = [
    ["a", "Atlanta, Georgia, United States"],
    ["b", "Marietta, Georgia, United States"],
    ["c", "Greater Atlanta Area"],
    ["d", "Alpharetta, GA"],
    ["e", "Atlanta Metropolitan Area"],
    ["f", "Duluth, Georgia, United States"],
    ["g", "McDonough, Georgia, United States"],
    ["i", "Sandy Springs, Georgia, United States"],
  ];

  it("keeps suburbs and points at a profile in another state", () => {
    const people = new Map([...atlanta, ["h", "Greensboro--Winston-Salem--High Point Area"]]);
    expect(locationOutliers(people)).toEqual(["h"]);
  });

  it("points at a town in the same state beyond commuting distance", () => {
    const people = new Map([...atlanta, ["h", "LaGrange, Georgia, United States"]]);
    expect(locationOutliers(people)).toEqual(["h"]);
  });

  it("uses the named state for a city name shared across states", () => {
    expect(locate("Duluth, Georgia, United States")?.[0]).toBeCloseTo(34, 0);
    expect(locate("Duluth, Minnesota, United States")?.[0]).toBeCloseTo(46.8, 0);
  });

  it("leaves a place the named state lacks unknown instead of using another state's", () => {
    expect(locate("Rex, Georgia, United States")).toBeUndefined();
    const people = new Map([...atlanta, ["h", "Rex, Georgia, United States"]]);
    expect(locationOutliers(people)).toEqual([]);
  });

  it("names no one when too few locations are known", () => {
    const people = new Map([
      ["a", "Austin, Texas, United States"],
      ["b", "Somewhere Unknown"],
    ]);
    expect(locationOutliers(people)).toEqual([]);
  });
});

// 2026-10-27: a country-only pick from the planned rows was bounced and the ten were recorded again.
describe("outsideSearchArea", () => {
  const atlanta: [string, string | null][] = [
    ["a", "Atlanta, Georgia, United States"],
    ["b", "Marietta, Georgia, United States"],
    ["c", "Decatur, Georgia, United States"],
    ["d", "Alpharetta, GA"],
    ["e", "McDonough, Georgia, United States"],
    ["f", "Duluth, Georgia, United States"],
  ];

  it("leaves out far, country-only and unlocated rows of a local search", () => {
    const rows = new Map([
      ...atlanta,
      ["far", "Haslet, Texas, United States"],
      ["us", "United States"],
      ["none", null],
    ]);
    expect([...outsideSearchArea(rows)].sort()).toEqual(["far", "none", "us"]);
  });

  it("leaves everyone in when the rows spread out, as for a remote role", () => {
    const rows = new Map<string, string | null>([
      ["a", "Atlanta, Georgia, United States"],
      ["b", "Austin, Texas, United States"],
      ["c", "Denver, Colorado, United States"],
      ["d", "Seattle, Washington, United States"],
      ["e", "Boston, Massachusetts, United States"],
      ["us", "United States"],
    ]);
    expect(outsideSearchArea(rows).size).toBe(0);
  });
});

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

  it("holds the area to the named place even when most rows are far from it", () => {
    const place = namedPlace(queries);
    const rows = new Map([
      ["a", "Dallas, Texas, United States"],
      ["b", "Edison, New Jersey, United States"],
      ["c", "Philadelphia, Pennsylvania, United States"],
      ["d", "Providence, Rhode Island, United States"],
      ["e", "Newark, New Jersey, United States"],
    ]);
    expect([...outsideSearchArea(rows, place)].sort()).toEqual(["a", "c", "d"]);
    // Without a named place, rows this spread out read as a nationwide search.
    expect(outsideSearchArea(rows).size).toBe(0);
    expect(beyondCommute("Staten Island, New York, United States", place!)).toBe(false);
    expect(beyondCommute("Greater Boston", place!)).toBe(true);
    // Places outside the US are outside a US city's area too.
    for (const abroad of [
      "Burnaby, British Columbia, Canada",
      "Canada",
      "Greater Kitchener-Cambridge-Waterloo Metropolitan Area",
      "Singapore",
    ])
      expect(beyondCommute(abroad, place!)).toBe(true);
    expect(beyondCommute("Paris, Texas, United States", place!)).toBe(true);
    expect(beyondCommute("Somewhere unknown", place!)).toBe(false);
    expect([...outsideSearchArea(new Map([["x", "Singapore"]]), place)]).toEqual(["x"]);
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
