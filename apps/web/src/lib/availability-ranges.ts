export type AvailabilitySlot = { start: string; end?: string | null; timeZone?: string | null };
export type AvailabilityRange = { start: number; end: number };
export type AvailabilityDay = { day: string; ranges: AvailabilityRange[] };
export type AvailabilityGroup = { timeZone: string | null; days: AvailabilityDay[] };

function validTimeZone(timeZone: string | null | undefined) {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/** The calendar day (YYYY-MM-DD) of an instant in a time zone; the viewer's zone when unknown. */
export function availabilityDay(ms: number, timeZone?: string | null) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

/**
 * Merges adjacent or overlapping availability slots into ranges, grouped by time zone and then
 * by the day each range starts. Slots with an unreadable start are dropped.
 */
export function mergeAvailability(slots: readonly AvailabilitySlot[]): AvailabilityGroup[] {
  const byZone = new Map<string | null, AvailabilityRange[]>();
  for (const slot of slots) {
    const start = Date.parse(slot.start);
    if (Number.isNaN(start)) continue;
    const parsedEnd = slot.end ? Date.parse(slot.end) : Number.NaN;
    const end = Number.isNaN(parsedEnd) ? start : Math.max(start, parsedEnd);
    const zone = slot.timeZone || null;
    const list = byZone.get(zone) ?? [];
    list.push({ start, end });
    byZone.set(zone, list);
  }
  return [...byZone].map(([timeZone, ranges]) => {
    const merged: AvailabilityRange[] = [];
    for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
      const last = merged.at(-1);
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    const days: AvailabilityDay[] = [];
    for (const range of merged) {
      const day = availabilityDay(range.start, timeZone);
      const current = days.at(-1);
      if (current?.day === day) current.ranges.push(range);
      else days.push({ day, ranges: [range] });
    }
    return { timeZone, days };
  });
}
