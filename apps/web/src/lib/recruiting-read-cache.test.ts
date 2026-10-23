import { expect, it } from "vitest";
import { clearRecruitingReads, rememberRecruitingRead } from "./recruiting-read-cache";

it("bounds saved reads and rejects an in-flight write after scoped invalidation", () => {
  const cache = { entries: new Map<string, unknown>(), epoch: 0 };
  for (let index = 0; index < 21; index++)
    rememberRecruitingRead(cache, `actor:space:other:${index}`, index, 0);
  expect(cache.entries.size).toBe(20);
  expect(cache.entries.has("actor:space:other:0")).toBe(false);
  rememberRecruitingRead(cache, "actor:space:role:candidates", ["saved"], 0);
  const before = cache.epoch;
  clearRecruitingReads(cache, "actor:space:role");
  expect(cache.entries.has("actor:space:role:candidates")).toBe(false);
  expect(cache.entries.has("actor:space:other:20")).toBe(true);
  rememberRecruitingRead(cache, "actor:space:role:candidates", ["late"], before);
  expect(cache.entries.has("actor:space:role:candidates")).toBe(false);
  clearRecruitingReads(cache);
  expect(cache.entries.size).toBe(0);
});
