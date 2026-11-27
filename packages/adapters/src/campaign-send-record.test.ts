import { expect, it } from "vitest";
import { sentCount } from "./campaign-send-record.js";

it("counts everyone the provider contacted as sent while its totals lag", () => {
  // 11-14 staging: two people contacted at 01:38 and 01:39 while the total still read 0.
  expect(sentCount(0, 2)).toBe(2);
  expect(sentCount(5, 2)).toBe(5);
  expect(sentCount(null, 0)).toBeNull();
  expect(sentCount(null, 1)).toBe(1);
});
