import { expect, it } from "vitest";
import type { InterviewCalendarEvent } from "./interviewCalendarModel";
import {
  calendarDay,
  calendarInstant,
  calendarWeek,
  layoutCalendarEvents,
  shiftCalendarDay,
  validCalendarZone,
} from "./interviewCalendarModel";

const event = (extra: Partial<InterviewCalendarEvent> = {}): InterviewCalendarEvent => ({
  id: "event",
  kind: "event",
  title: "Synthetic interview",
  start: "2026-10-20T09:00:00Z",
  end: "2026-10-20T10:00:00Z",
  timeZone: "UTC",
  attendees: [],
  status: "confirmed",
  location: null,
  url: null,
  ...extra,
});
const days = calendarWeek("2026-10-21");
it("uses Monday weeks and calendar days across DST", () => {
  expect(days).toEqual([
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
  ]);
  expect(shiftCalendarDay("2026-11-01", 1)).toBe("2026-11-02");
  expect(calendarDay(new Date("2026-10-20T01:00:00Z"), "America/Los_Angeles")).toBe("2026-10-19");
  expect(validCalendarZone("Mars/City")).toBeNull();
});
it("places actual instants in the explicitly selected timezone", () => {
  const result = layoutCalendarEvents([event()], days, "America/New_York");
  expect(result.segments[0]).toMatchObject({ day: "2026-10-20", startMinute: 300, endMinute: 360 });
});
it("splits overnight source ranges without inventing an all-day flag", () => {
  const result = layoutCalendarEvents(
    [event({ start: "2026-10-20T23:30:00Z", end: "2026-10-21T01:00:00Z" })],
    days,
    "UTC",
  );
  expect(
    result.segments.map((row) => [
      row.day,
      row.startMinute,
      row.endMinute,
      row.continuesBefore,
      row.continuesAfter,
    ]),
  ).toEqual([
    ["2026-10-20", 1410, 1440, false, true],
    ["2026-10-21", 0, 60, true, false],
  ]);
  const dayRange = layoutCalendarEvents(
    [event({ start: "2026-10-20T00:00:00Z", end: "2026-10-21T00:00:00Z" })],
    days,
    "UTC",
  );
  expect(dayRange.segments).toHaveLength(1);
  expect(dayRange.segments[0]).toMatchObject({ startMinute: 0, endMinute: 1440 });
});
it("keeps missing and invalid ends as markers, preserving the original source", () => {
  for (const end of [null, "invalid", "2026-10-19T10:00:00Z"]) {
    const original = event({ end });
    const segment = layoutCalendarEvents([original], days, "UTC").segments[0]!;
    expect(segment.endMinute).toBeNull();
    expect(segment.event).toBe(original);
    expect(segment.issue).toBe(end === null ? "missing_end" : "invalid_end");
  }
});
it("keeps date-only, invalid, and offset-less start values out of the hourly grid", () => {
  const source = [
    event({ start: "2026-10-20" }),
    event({ id: "bad", start: "invalid" }),
    event({ id: "local", start: "2026-10-20T09:00:00" }),
  ];
  const result = layoutCalendarEvents(source, days, "UTC");
  expect(result.segments).toEqual([]);
  expect(result.unplaced.map((row) => row.issue)).toEqual([
    "date_only",
    "invalid_start",
    "invalid_start",
  ]);
  expect(calendarInstant("2026-10-20T09:00:00")).toBeNull();
  expect(calendarInstant("2026-02-30T09:00:00Z")).toBeNull();
  expect(calendarInstant("2026-10-20T24:00:00Z")).toBeNull();
});
it("keeps repeated-hour DST ranges honest instead of drawing a negative duration", () => {
  const result = layoutCalendarEvents(
    [event({ start: "2026-11-01T01:45:00-04:00", end: "2026-11-01T01:15:00-05:00" })],
    calendarWeek("2026-11-01"),
    "America/New_York",
  );
  expect(result.segments[0]).toMatchObject({
    startMinute: 105,
    endMinute: null,
    issue: "clock_change",
  });
});
it("assigns separate lanes to overlapping events and availability without changing times", () => {
  const result = layoutCalendarEvents(
    [
      event(),
      event({ id: "availability", kind: "availability", start: "2026-10-20T09:30:00Z" }),
      event({ id: "later", start: "2026-10-20T11:00:00Z", end: "2026-10-20T12:00:00Z" }),
    ],
    days,
    "UTC",
  );
  expect(result.segments.map((row) => [row.lane, row.lanes])).toEqual([
    [0, 2],
    [1, 2],
    [0, 1],
  ]);
  expect(result.segments[1]?.event.kind).toBe("availability");
});
