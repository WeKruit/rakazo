import type {
  RecruitingCriterionExpression,
  RecruitingPreferenceFeedbackInput,
  RecruitingRoleRevision,
  Verdict,
} from "@rakazo/contracts";

export function applyRecruitingPreferenceEdit(
  content: string,
  preference: RecruitingPreferenceFeedbackInput,
): { content: string; anchor: { start: number; end: number; quote: string } | null } {
  if (preference.operation === "add") {
    const prefix = content ? `${content}\n\n` : "";
    return {
      content: prefix + preference.content,
      anchor: {
        start: prefix.length,
        end: prefix.length + preference.content.length,
        quote: preference.content,
      },
    };
  }
  const { start, end, quote } = preference.anchor;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > content.length ||
    content.slice(start, end) !== quote ||
    splitsSurrogatePair(content, start) ||
    splitsSurrogatePair(content, end)
  )
    throw new Error("Preference anchor does not match the loaded memory revision");
  const replacement = preference.operation === "replace" ? preference.content : "";
  return {
    content: content.slice(0, start) + replacement + content.slice(end),
    anchor: replacement ? { start, end: start + replacement.length, quote: replacement } : null,
  };
}

function splitsSurrogatePair(content: string, index: number): boolean {
  const before = content.charCodeAt(index - 1);
  const after = content.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function allOf(items: readonly Verdict[]): Verdict {
  if (items.includes("unmet")) return "unmet";
  return items.length > 0 && items.every((item) => item === "met") ? "met" : "unknown";
}

export function anyOf(items: readonly Verdict[]): Verdict {
  if (items.includes("met")) return "met";
  return items.length > 0 && items.every((item) => item === "unmet") ? "unmet" : "unknown";
}

export function not(value: Verdict): Verdict {
  return value === "unknown" ? "unknown" : value === "met" ? "unmet" : "met";
}

/** Callers supply only hard results, including unknown for unresolved definitions. */
export function hardGate(items: readonly Verdict[]): Verdict {
  return allOf(items);
}

/** Atom judgments are semantic inputs; only expression combination belongs here. */
export function evaluateRecruitingCriteria(
  role: Pick<RecruitingRoleRevision, "criteria" | "definitionQuestions">,
  atoms: ReadonlyMap<string, Verdict>,
): { criteria: { criterionId: string; verdict: Verdict }[]; hardGate: Verdict } {
  const evaluate = (expression: RecruitingCriterionExpression): Verdict => {
    switch (expression.kind) {
      case "atom":
        return atoms.get(expression.id) ?? "unknown";
      case "all":
        return allOf(expression.items.map(evaluate));
      case "any":
        return anyOf(expression.items.map(evaluate));
      case "not":
        return not(evaluate(expression.item));
    }
  };
  const criteria = role.criteria.map((criterion) => ({
    criterionId: criterion.id,
    verdict:
      criterion.definitionQuestions.length > 0
        ? ("unknown" as const)
        : evaluate(criterion.expression),
  }));
  const hardResults = criteria.flatMap((result, index) =>
    role.criteria[index]?.priority === "hard" ? [result.verdict] : [],
  );
  if (role.definitionQuestions.length > 0) hardResults.push("unknown");
  return { criteria, hardGate: hardGate(hardResults) };
}

export type RecruitingEmploymentDate =
  | Readonly<{ precision: "year"; year: number }>
  | Readonly<{ precision: "month"; year: number; month: number }>
  | Readonly<{ precision: "day"; year: number; month: number; day: number }>;

export type RecruitingEmploymentInterval = Readonly<{
  start: RecruitingEmploymentDate | null;
  end: RecruitingEmploymentDate | "present" | null;
  /** Sourced semantic judgment of the role's full-time and eligible-work definitions. */
  qualifyingFullTime: Verdict;
}>;

/**
 * Only supports an explicitly supplied whole-calendar-month rule, with inclusive
 * dates and cutoff. Missing partial-month semantics must be clarified by the agent.
 * Imprecise dates bound possibilities; they never become asserted exact dates.
 */
export function qualifiedEmploymentMonths(input: {
  countingRule: "complete_calendar_months";
  minimumMonths: number;
  cutoff: Extract<RecruitingEmploymentDate, { precision: "day" }>;
  historyComplete: boolean;
  intervals: readonly RecruitingEmploymentInterval[];
}): { lowerMonths: number; upperMonths: number | null; verdict: Verdict } {
  if (input.countingRule !== "complete_calendar_months")
    throw new Error("An explicit supported employment-month counting rule is required");
  if (!Number.isSafeInteger(input.minimumMonths) || input.minimumMonths < 0)
    throw new Error("Minimum employment months must be a nonnegative safe integer");
  if (typeof input.historyComplete !== "boolean")
    throw new Error("Employment history completeness must be explicit");
  if (input.cutoff.precision !== "day") throw new Error("Employment cutoff must be an exact day");
  const cutoff = employmentDateBounds(input.cutoff)[0];
  const guaranteed: [number, number][] = [];
  const possible: [number, number][] = [];
  let upperUnbounded = !input.historyComplete;
  for (const interval of input.intervals) {
    const start = interval.start === null ? null : employmentDateBounds(interval.start);
    const end =
      interval.end === "present"
        ? ([cutoff, cutoff] as const)
        : interval.end === null
          ? null
          : employmentDateBounds(interval.end);
    if (start && end && interval.end !== "present" && start[0] > end[1])
      throw new Error("Employment start cannot follow its end");
    if (!["met", "unmet", "unknown"].includes(interval.qualifyingFullTime))
      throw new Error("Employment eligibility must be a three-state verdict");
    if (interval.qualifyingFullTime === "unmet") continue;
    const possibleEnd = Math.min(end?.[1] ?? cutoff, cutoff);
    if (!start) {
      upperUnbounded = true;
      continue;
    }
    if (start[0] > possibleEnd) continue;
    possible.push([start[0], possibleEnd]);
    const guaranteedEnd = end && Math.min(end[0], cutoff);
    if (
      interval.qualifyingFullTime === "met" &&
      guaranteedEnd !== null &&
      start[1] <= guaranteedEnd
    )
      guaranteed.push([start[1], guaranteedEnd]);
  }
  const lowerMonths = completeCalendarMonths(guaranteed);
  const upperMonths = upperUnbounded ? null : completeCalendarMonths(possible);
  return {
    lowerMonths,
    upperMonths,
    verdict:
      lowerMonths >= input.minimumMonths
        ? "met"
        : upperMonths !== null && upperMonths < input.minimumMonths
          ? "unmet"
          : "unknown",
  };
}

function daysInEmploymentMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const employmentDayMs = 86_400_000;

function employmentDay(year: number, month: number, day: number): number {
  // setUTCFullYear preserves years 1–99, unlike Date.UTC's 1900 offset.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime() / employmentDayMs;
}

function employmentDateBounds(date: RecruitingEmploymentDate): readonly [number, number] {
  if (!Number.isInteger(date.year) || date.year < 1 || date.year > 9999)
    throw new Error("Employment year must be an integer from 1 to 9999");
  if (date.precision === "year")
    return [employmentDay(date.year, 1, 1), employmentDay(date.year, 12, 31)];
  if (date.precision !== "month" && date.precision !== "day")
    throw new Error("Employment date precision must be year, month or day");
  if (!Number.isInteger(date.month) || date.month < 1 || date.month > 12)
    throw new Error("Employment month must be an integer from 1 to 12");
  const lastDay = daysInEmploymentMonth(date.year, date.month);
  if (date.precision === "month")
    return [employmentDay(date.year, date.month, 1), employmentDay(date.year, date.month, lastDay)];
  if (!Number.isInteger(date.day) || date.day < 1 || date.day > lastDay)
    throw new Error("Employment day must be a valid calendar date");
  const value = employmentDay(date.year, date.month, date.day);
  return [value, value];
}

function completeCalendarMonths(intervals: [number, number][]): number {
  const merged: [number, number][] = [];
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1] + 1)
      previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged.reduce((months, [start, end]) => {
    const first = new Date(start * employmentDayMs);
    const last = new Date(end * employmentDayMs);
    const firstMonth =
      first.getUTCFullYear() * 12 + first.getUTCMonth() + (first.getUTCDate() === 1 ? 0 : 1);
    const lastMonth =
      last.getUTCFullYear() * 12 +
      last.getUTCMonth() +
      (last.getUTCDate() === daysInEmploymentMonth(last.getUTCFullYear(), last.getUTCMonth() + 1)
        ? 1
        : 0);
    return months + Math.max(0, lastMonth - firstMonth);
  }, 0);
}
