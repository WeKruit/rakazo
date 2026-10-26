import { describe, expect, it } from "vitest";
import { isRegionOnlyLocation, locationOutliers } from "./recruiting-location.js";

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
  it("points at everyone outside the group's city, suburbs included, never by shared state", () => {
    const people = new Map([
      ["a", "Atlanta, Georgia, United States"],
      ["b", "Marietta, Georgia, United States"],
      ["c", "Greater Atlanta Area"],
      ["d", "Alpharetta, Georgia, United States"],
      ["e", "Atlanta Metropolitan Area"],
      ["f", "Duluth, Georgia, United States"],
      ["g", "McDonough, Georgia, United States"],
      ["h", "Greensboro--Winston-Salem--High Point Area"],
    ]);
    expect(locationOutliers(people)).toEqual(["b", "d", "f", "g", "h"]);
  });

  it("does not count a shared state as the same place", () => {
    const people = new Map([
      ["a", "Atlanta, Georgia, United States"],
      ["b", "Atlanta, GA"],
      ["c", "Greater Atlanta Area"],
      ["d", "LaGrange, Georgia, United States"],
      ["e", "Atlanta Metropolitan Area"],
    ]);
    expect(locationOutliers(people)).toEqual(["d"]);
  });

  it("names no one when the group has no common place", () => {
    const people = new Map([
      ["a", "Austin, Texas, United States"],
      ["b", "Denver, Colorado, United States"],
      ["c", "Boston, Massachusetts, United States"],
    ]);
    expect(locationOutliers(people)).toEqual([]);
  });
});
