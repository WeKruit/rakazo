import { describe, expect, it } from "vitest";
import { mergeAvailability } from "./availability-ranges";

const slot = (start: string, end: string, timeZone: string | null = "UTC") => ({
  start: `2026-10-26T${start}:00Z`,
  end: `2026-10-26T${end}:00Z`,
  timeZone,
});
const at = (time: string, day = "26") => Date.parse(`2026-10-${day}T${time}:00Z`);

describe("mergeAvailability", () => {
  it("merges adjacent half-hour slots into one range", () => {
    const groups = mergeAvailability([
      slot("08:30", "09:00"),
      slot("08:00", "08:30"),
      slot("09:00", "09:30"),
    ]);
    expect(groups).toEqual([
      {
        timeZone: "UTC",
        days: [{ day: "2026-10-26", ranges: [{ start: at("08:00"), end: at("09:30") }] }],
      },
    ]);
  });

  it("merges overlaps, keeps gaps apart and groups by day", () => {
    const [group] = mergeAvailability([
      slot("08:00", "10:00"),
      slot("09:00", "11:30"),
      slot("13:00", "13:30"),
      { start: "2026-10-27T08:00:00Z", end: "2026-10-27T08:30:00Z", timeZone: "UTC" },
    ]);
    expect(group!.days).toEqual([
      {
        day: "2026-10-26",
        ranges: [
          { start: at("08:00"), end: at("11:30") },
          { start: at("13:00"), end: at("13:30") },
        ],
      },
      { day: "2026-10-27", ranges: [{ start: at("08:00", "27"), end: at("08:30", "27") }] },
    ]);
  });

  it("uses the slot's time zone for the day and never merges across zones", () => {
    const groups = mergeAvailability([
      { start: "2026-10-27T02:00:00Z", end: "2026-10-27T02:30:00Z", timeZone: "America/New_York" },
      { start: "2026-10-27T02:30:00Z", end: "2026-10-27T03:00:00Z", timeZone: "UTC" },
    ]);
    expect(groups.map((group) => [group.timeZone, group.days[0]!.day])).toEqual([
      ["America/New_York", "2026-10-26"],
      ["UTC", "2026-10-27"],
    ]);
  });

  it("drops unreadable starts and treats a missing end as an instant", () => {
    const [group] = mergeAvailability([
      { start: "not a date", end: null },
      { start: "2026-10-26T08:00:00Z", end: null, timeZone: "UTC" },
    ]);
    expect(group!.days[0]!.ranges).toEqual([{ start: at("08:00"), end: at("08:00") }]);
  });
});
