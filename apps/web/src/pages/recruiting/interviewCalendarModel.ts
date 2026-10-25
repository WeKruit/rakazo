import type { RecruitingCorrespondence } from "@rakazo/contracts";

export type InterviewCalendarEvent = RecruitingCorrespondence["events"][number];
export type CalendarTimeIssue =
  | "date_only"
  | "invalid_start"
  | "missing_end"
  | "invalid_end"
  | "clock_change";
export type CalendarSegment = {
  key: string;
  event: InterviewCalendarEvent;
  day: string;
  startMinute: number;
  endMinute: number | null;
  continuesBefore: boolean;
  continuesAfter: boolean;
  issue: CalendarTimeIssue | null;
  lane: number;
  lanes: number;
};

export function validCalendarZone(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Calendar arithmetic uses dates, never 24-hour jumps across a timezone's DST boundary. */
export function shiftCalendarDay(day: string, offset: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function calendarWeek(day: string): string[] {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const monday = shiftCalendarDay(day, -((weekday + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => shiftCalendarDay(monday, index));
}

function calendarParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return {
    day: `${value("year")}-${value("month")}-${value("day")}`,
    minute: Number(value("hour")) * 60 + Number(value("minute")),
  };
}

export function calendarDay(date: Date, timeZone: string) {
  return calendarParts(date, timeZone).day;
}

export function calendarMinute(date: Date, timeZone: string) {
  return calendarParts(date, timeZone).minute;
}

export function calendarInstant(value: string | null): Date | null {
  // Do not assign the viewer's timezone to an offset-less or date-only source value.
  if (!value || !/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value))
    return null;
  const sourceDay = value.slice(0, 10);
  const sourceDate = new Date(`${sourceDay}T00:00:00Z`);
  if (
    !Number.isFinite(sourceDate.getTime()) ||
    sourceDate.toISOString().slice(0, 10) !== sourceDay ||
    Number(value.slice(11, 13)) > 23
  )
    return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** A display layout only. It never changes source times, creates bookings or infers all-day flags. */
export function layoutCalendarEvents(
  events: readonly InterviewCalendarEvent[],
  days: readonly string[],
  timeZone: string,
) {
  const segments: CalendarSegment[] = [];
  const unplaced: Array<{ event: InterviewCalendarEvent; issue: "date_only" | "invalid_start" }> =
    [];
  events.forEach((event, index) => {
    const start = calendarInstant(event.start);
    if (!start) {
      unplaced.push({
        event,
        issue: /^\d{4}-\d{2}-\d{2}$/.test(event.start) ? "date_only" : "invalid_start",
      });
      return;
    }
    const first = calendarParts(start, timeZone);
    const end = calendarInstant(event.end);
    const validEnd = end && end.getTime() >= start.getTime() ? end : null;
    const last = validEnd ? calendarParts(validEnd, timeZone) : first;
    const issue = !event.end ? "missing_end" : !validEnd ? "invalid_end" : null;
    for (const day of days) {
      if (day < first.day || day > last.day) continue;
      if (day === last.day && day !== first.day && last.minute === 0) continue;
      const startMinute = day === first.day ? first.minute : 0;
      const endMinute = validEnd ? (day === last.day ? last.minute : 1440) : null;
      const clockChange = endMinute !== null && endMinute < startMinute;
      segments.push({
        key: `${index}:${event.id}:${day}`,
        event,
        day,
        startMinute,
        endMinute: clockChange ? null : endMinute,
        continuesBefore: day > first.day,
        continuesAfter: day < last.day && endMinute === 1440,
        issue: clockChange ? "clock_change" : issue,
        lane: 0,
        lanes: 1,
      });
    }
  });
  for (const day of days) {
    const rows = segments
      .filter((segment) => segment.day === day)
      .sort((a, b) => a.startMinute - b.startMinute || a.key.localeCompare(b.key));
    let group: CalendarSegment[] = [];
    let laneEnds: number[] = [];
    const finish = () => {
      for (const row of group) row.lanes = laneEnds.length;
      group = [];
      laneEnds = [];
    };
    for (const row of rows) {
      if (laneEnds.length && laneEnds.every((end) => end <= row.startMinute)) finish();
      let lane = laneEnds.findIndex((end) => end <= row.startMinute);
      if (lane === -1) lane = laneEnds.length;
      row.lane = lane;
      // Reserve room for the label; this does not claim a duration for an undated end.
      laneEnds[lane] = Math.max(row.endMinute ?? row.startMinute, row.startMinute + 30);
      group.push(row);
    }
    finish();
  }
  return { segments, unplaced };
}
