import { expect, it } from "vitest";
import {
  isInShortlistWeek,
  readShortlistWeekFilter,
  writeShortlistWeekFilter,
} from "./dashboard-drilldown";

const filter = {
  kind: "shortlisted-week" as const,
  roleId: "role-a",
  from: "2026-10-19T00:00:00Z",
  before: "2026-10-26T00:00:00Z",
  observedThrough: "2026-10-23T12:00:00Z",
};

it("roundtrips readable exact boundaries and clears only this filter", () => {
  const params = writeShortlistWeekFilter(
    new URLSearchParams({ view: "contacts", detail: "notes.person" }),
    filter,
  );
  expect(readShortlistWeekFilter(new URLSearchParams(params.toString()))).toEqual(filter);
  expect(writeShortlistWeekFilter(params).toString()).toBe("view=contacts&detail=notes.person");
  for (const changes of [
    { shortlistBefore: filter.from },
    { shortlistFrom: "invalid" },
    { shortlistRole: "" },
  ]) {
    const invalid = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) invalid.set(key, value);
    expect(readShortlistWeekFilter(invalid)).toBeUndefined();
  }
});

it("filters actual shortlist dates with exclusive next week and no undated or future records", () => {
  const matches = (date: string | null, shortlisted = true) =>
    isInShortlistWeek({ shortlistedAt: date, shortlisted }, filter);
  expect(matches(filter.from)).toBe(true);
  expect(matches(filter.observedThrough)).toBe(true);
  for (const date of [null, "bad", "2026-10-18T23:59:59Z", filter.before, "2026-10-23T12:00:01Z"])
    expect(matches(date)).toBe(false);
  expect(matches(filter.from, false)).toBe(false);
});
