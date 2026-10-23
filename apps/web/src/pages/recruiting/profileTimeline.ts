/**
 * Best-effort structure for the free-text experience and education a research agent wrote.
 * Nothing is invented or dropped: a segment that does not parse stays as its original words,
 * and every number comes only from dates found in the text.
 */

export type TimelineKind = "experience" | "education";

export type TimelineEntry = {
  /** The segment exactly as written (bullets trimmed). */
  text: string;
  /** False when the segment is kept as plain words. */
  structured: boolean;
  /** Position title, or school for education. */
  primary: string;
  /** Company, or degree for education. */
  secondary?: string;
  /** Remaining parts, such as a location. */
  detail?: string;
  /** Date text as written, for display. */
  dateLabel?: string;
  /** Whether the range runs to the present, and the start as written. */
  current?: boolean;
  startLabel?: string;
  /** Month indexes (year * 12 + month - 1) of a parsed range. */
  startIndex?: number;
  endIndex?: number;
  /** Whole months of a parsed range, only when both ends were found. */
  months?: number;
};

export type TimelineStats = { average: number; current: number | null; total: number };

const MONTH_NAME =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const YEAR = "(?:19|20)\\d{2}";
const MONTH_NUM = "(?:0?[1-9]|1[0-2])";
const DATE = `(?<!\\d)(?:${MONTH_NAME}\\.?,?\\s+${YEAR}|${YEAR}年\\s*${MONTH_NUM}月?|${YEAR}年|${MONTH_NUM}\\/${YEAR}|${YEAR}[-./]${MONTH_NUM}(?!\\d)|${YEAR})(?!\\d)`;
const PRESENT = "(?:Present|Current(?:ly)?|Now|Today|Ongoing|至今|现在|目前|迄今)";
const RANGE_SEP = "(?:\\s*[-–—－~〜至到]\\s*|\\s+(?:to|until|till)\\s+)";
const RANGE = new RegExp(`(${DATE})${RANGE_SEP}(${DATE}|${PRESENT})`, "gi");
const SINGLE = new RegExp(DATE, "gi");
const PRESENT_ONLY = new RegExp(`^${PRESENT}$`, "i");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MAX_SEGMENT = 160;
const SCHOOL = /universit|college|institute|school|academy|polytechnic|大学|学院|学校|研究院/i;
const DEGREE =
  /^(?:ph\.?d|doctor|m\.?s\.?c?|b\.?s\.?c?|b\.?a|m\.?a|mba|m\.?eng|b\.?eng|bachelor|master|associate|博士|硕士|学士|本科|研究生)/i;

/** Month index of one matched date, with a missing month taken as January. */
function dateIndex(raw: string) {
  const year = Number(/(?:19|20)\d{2}/.exec(raw)?.[0]);
  const name = /[a-z]{3}/i.exec(raw)?.[0]?.toLowerCase();
  let month = name ? MONTHS.indexOf(name) + 1 : 0;
  if (!month) {
    const rest = raw.replace(/(?:19|20)\d{2}/, " ");
    const number = /\d{1,2}/.exec(rest)?.[0];
    month = number ? Number(number) : 1;
  }
  return year * 12 + (month - 1);
}

function nowIndex(now: Date) {
  return now.getUTCFullYear() * 12 + now.getUTCMonth();
}

const TRIM = /^[\s,，、:：;；\-–—|·()（）]+|[\s,，、:：;；\-–—|·()（）]+$/g;

function tidy(text: string) {
  return text
    .replace(/[(（]\s*[)）]/g, " ")
    .replace(TRIM, "")
    .replace(/\s{2,}/g, " ");
}

function splitSegments(value: string) {
  return value
    .split(/\s*(?:[;；•]|\r?\n)\s*/)
    .map((part) => part.replace(/^\s*(?:[-*·]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

function splitParts(text: string): string[] {
  const at = /\s+(?:at|@)\s+/i.exec(text);
  if (at)
    return [
      ...splitParts(text.slice(0, at.index)),
      ...splitParts(text.slice(at.index + at[0].length)),
    ];
  return text
    .split(/\s*[,，、|·]\s*|\s+[-–—]\s+|\s*—\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseSegment(text: string, kind: TimelineKind, now: Date): TimelineEntry {
  const plain: TimelineEntry = { text, structured: false, primary: text };
  if (text.length > MAX_SEGMENT || /[.!?。]\s+\S.*[.!?。]/.test(text)) return plain;

  const ranges = [...text.matchAll(RANGE)];
  const singles = ranges.length ? [] : [...text.matchAll(SINGLE)];
  if (ranges.length > 1 || singles.length > 1) return plain;

  let rest = text;
  const dates: Partial<TimelineEntry> = {};
  const range = ranges[0];
  const single = singles[0];
  if (range) {
    const startIndex = dateIndex(range[1] ?? "");
    const present = PRESENT_ONLY.test((range[2] ?? "").trim());
    const endIndex = present ? nowIndex(now) : dateIndex(range[2] ?? "");
    rest = text.replace(range[0], " ");
    dates.dateLabel = range[0];
    if (present) Object.assign(dates, { current: true, startLabel: (range[1] ?? "").trim() });
    if (endIndex >= startIndex && startIndex <= nowIndex(now)) {
      Object.assign(dates, { startIndex, endIndex, months: endIndex - startIndex });
    }
  } else if (single) {
    rest = text.replace(single[0], " ");
    dates.dateLabel = single[0];
  }

  const parts = splitParts(tidy(rest));
  if (!parts.length) return plain;
  const hasDate = dates.dateLabel !== undefined;
  if (parts.length < 2 && !hasDate) return plain;

  let primary = parts[0] ?? text;
  let secondary: string | undefined;
  let others = parts.slice(1);
  if (kind === "education") {
    const school = parts.findIndex((part) => SCHOOL.test(part));
    if (school >= 0) {
      primary = parts[school] ?? primary;
      const remaining = parts.filter((_, index) => index !== school);
      secondary = remaining[0];
      others = remaining.slice(1);
    } else if (parts.length > 1 && DEGREE.test(primary)) {
      secondary = primary;
      primary = parts[1] ?? primary;
      others = parts.slice(2);
    } else {
      secondary = parts[1];
      others = parts.slice(2);
    }
  } else {
    secondary = parts[1];
    others = parts.slice(2);
  }
  return {
    ...dates,
    text,
    structured: true,
    primary,
    secondary,
    detail: others.length ? others.join(", ") : undefined,
  };
}

/** Splits one report value into entries, in the order written. */
export function parseTimeline(
  value: string | null | undefined,
  kind: TimelineKind,
  now: Date,
): TimelineEntry[] {
  return splitSegments(value ?? "").map((segment) => parseSegment(segment, kind, now));
}

/** Tenure figures from parsed positions only; null when no position has a usable range. */
export function timelineStats(entries: readonly TimelineEntry[]): TimelineStats | null {
  const spans = entries.flatMap((entry) =>
    entry.months &&
    entry.months > 0 &&
    entry.startIndex !== undefined &&
    entry.endIndex !== undefined
      ? [{ start: entry.startIndex, end: entry.endIndex, current: entry.current === true }]
      : [],
  );
  if (!spans.length) return null;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = Number.NEGATIVE_INFINITY;
  for (const span of sorted) {
    const from = Math.max(span.start, cursor);
    if (span.end > from) total += span.end - from;
    cursor = Math.max(cursor, span.end);
  }
  const lengths = spans.map((span) => span.end - span.start);
  const current = spans.filter((span) => span.current).sort((a, b) => b.start - a.start)[0];
  return {
    average: Math.round(lengths.reduce((sum, months) => sum + months, 0) / lengths.length),
    current: current ? current.end - current.start : null,
    total,
  };
}
