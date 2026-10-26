import { describe, expect, it } from "vitest";
import { isRegionOnlyLocation } from "./recruiting-location.js";

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
