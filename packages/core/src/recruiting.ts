import type {
  ReassessRecruitingAssessmentInput,
  RecruitingAssessment,
  RecruitingAssessmentJudgments,
  RecruitingAtomJudgment,
  RecruitingCriterionExpression,
  RecruitingEmploymentDate,
  RecruitingEmploymentDay,
  RecruitingEmploymentEvaluation,
  RecruitingEmploymentJudgment,
  RecruitingPreferenceFeedbackInput,
  RecruitingRoleRevision,
  SaveRecruitingAssessmentInput,
  Verdict,
} from "@rakazo/contracts";
import {
  ReassessRecruitingAssessmentInput as ReassessAssessmentInputSchema,
  RecruitingAssessmentJudgmentsSchema,
  RecruitingAssessmentSchema,
  RecruitingEmploymentDaySchema,
  SaveRecruitingAssessmentInput as SaveAssessmentInputSchema,
} from "@rakazo/contracts";

export class RecruitingAssessmentValidationError extends Error {}

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

export type { RecruitingEmploymentDate } from "@rakazo/contracts";

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
    throw new RecruitingAssessmentValidationError(
      "An explicit supported employment-month counting rule is required",
    );
  if (!Number.isSafeInteger(input.minimumMonths) || input.minimumMonths < 0)
    throw new RecruitingAssessmentValidationError(
      "Minimum employment months must be a nonnegative safe integer",
    );
  if (typeof input.historyComplete !== "boolean")
    throw new RecruitingAssessmentValidationError(
      "Employment history completeness must be explicit",
    );
  if (input.cutoff.precision !== "day")
    throw new RecruitingAssessmentValidationError("Employment cutoff must be an exact day");
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
      throw new RecruitingAssessmentValidationError("Employment start cannot follow its end");
    if (!["met", "unmet", "unknown"].includes(interval.qualifyingFullTime))
      throw new RecruitingAssessmentValidationError(
        "Employment eligibility must be a three-state verdict",
      );
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
    throw new RecruitingAssessmentValidationError(
      "Employment year must be an integer from 1 to 9999",
    );
  if (date.precision === "year")
    return [employmentDay(date.year, 1, 1), employmentDay(date.year, 12, 31)];
  if (date.precision !== "month" && date.precision !== "day")
    throw new RecruitingAssessmentValidationError(
      "Employment date precision must be year, month or day",
    );
  if (!Number.isInteger(date.month) || date.month < 1 || date.month > 12)
    throw new RecruitingAssessmentValidationError(
      "Employment month must be an integer from 1 to 12",
    );
  const lastDay = daysInEmploymentMonth(date.year, date.month);
  if (date.precision === "month")
    return [employmentDay(date.year, date.month, 1), employmentDay(date.year, date.month, lastDay)];
  if (!Number.isInteger(date.day) || date.day < 1 || date.day > lastDay)
    throw new RecruitingAssessmentValidationError("Employment day must be a valid calendar date");
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

function requireEmploymentClassifications(
  facts: SaveRecruitingAssessmentInput["facts"],
  evaluation: RecruitingEmploymentEvaluation,
): void {
  const classified = new Set(evaluation.intervals.map((interval) => interval.factId));
  if (facts.some((fact) => fact.kind === "employment" && !classified.has(fact.id)))
    throw new RecruitingAssessmentValidationError(
      "Every employment fact requires an explicit eligibility judgment",
    );
}

function recruitingRoleAtoms(role: Pick<RecruitingRoleRevision, "criteria">) {
  const definitions = new Map<string, Extract<RecruitingCriterionExpression, { kind: "atom" }>>();
  const collect = (expression: RecruitingCriterionExpression): string[] => {
    if (expression.kind === "atom") {
      const existing = definitions.get(expression.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(expression))
        throw new RecruitingAssessmentValidationError("An atom ID must have one definition");
      definitions.set(expression.id, expression);
      return [expression.id];
    }
    return expression.kind === "not" ? collect(expression.item) : expression.items.flatMap(collect);
  };
  const criterionAtoms = role.criteria.map((criterion) => collect(criterion.expression));
  if (new Set(role.criteria.map((criterion) => criterion.id)).size !== role.criteria.length)
    throw new RecruitingAssessmentValidationError("Criterion IDs must be unique");
  return { definitions, criterionAtoms };
}

/** The runtime supplies one frozen UTC assessment day; inputs never supply a cutoff or aggregate. */
export function evaluateRecruitingAssessment(
  role: Pick<RecruitingRoleRevision, "criteria" | "definitionQuestions">,
  untrusted: SaveRecruitingAssessmentInput,
  assessmentDate: RecruitingEmploymentDay,
): RecruitingAssessmentJudgments {
  const input = SaveAssessmentInputSchema.parse(untrusted);
  const trustedDay = RecruitingEmploymentDaySchema.parse(assessmentDate);
  const { definitions, criterionAtoms } = recruitingRoleAtoms(role);
  const semantics = new Map(input.atomJudgments.map((judgment) => [judgment.atomId, judgment]));
  const evaluations = new Map(
    input.employmentEvaluations.map((evaluation) => [evaluation.atomId, evaluation]),
  );
  for (const id of [...semantics.keys(), ...evaluations.keys()])
    if (!definitions.has(id))
      throw new RecruitingAssessmentValidationError("Unknown assessment atom ID");
  for (const [id, definition] of definitions) {
    if (
      definition.employmentRule
        ? !evaluations.has(id) || semantics.has(id)
        : !semantics.has(id) || evaluations.has(id)
    )
      throw new RecruitingAssessmentValidationError(
        "Every role atom requires exactly its semantic or employment input",
      );
  }
  const facts = new Map(input.facts.map((fact) => [fact.id, fact]));
  const sources = new Map(input.sourceRefs.map((source) => [source.id, source]));
  const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];
  const primary = (id: string): boolean => {
    const source = sources.get(id);
    return source?.readState === "read" && source.kind !== "provider_report";
  };
  const hasPrimary = (factId: string, evidence: readonly string[]): boolean =>
    facts.get(factId)!.sourceRefIds.some((id) => evidence.includes(id) && primary(id));
  const validateEvidence = (
    factIds: readonly string[],
    evidence: readonly string[],
    verdict: Verdict,
  ): void => {
    const connected = new Set(factIds.flatMap((id) => facts.get(id)!.sourceRefIds));
    if (evidence.some((id) => !connected.has(id)))
      throw new RecruitingAssessmentValidationError(
        "Judgment evidence must support a referenced fact",
      );
    if (verdict !== "unknown" && !factIds.some((id) => hasPrimary(id, evidence)))
      throw new RecruitingAssessmentValidationError(
        "Met or unmet judgments require primary read evidence supporting a fact",
      );
  };
  const atoms: RecruitingAtomJudgment[] = [];
  const employment: RecruitingEmploymentJudgment[] = [];
  for (const [atomId, definition] of definitions) {
    const rule = definition.employmentRule;
    if (!rule) {
      const judgment = semantics.get(atomId)!;
      validateEvidence(judgment.factIds, judgment.evidence, judgment.verdict);
      atoms.push(judgment);
      continue;
    }
    const evaluation = evaluations.get(atomId)!;
    requireEmploymentClassifications(input.facts, evaluation);
    const cutoff = rule.cutoff.kind === "fixed" ? rule.cutoff.date : trustedDay;
    const completeness =
      evaluation.historyCompletenessFactId === null
        ? null
        : facts.get(evaluation.historyCompletenessFactId)!;
    if (completeness && completeness.kind !== "history_completeness")
      throw new RecruitingAssessmentValidationError(
        "Employment completeness must reference a history completeness fact",
      );
    const factIds = [
      ...evaluation.intervals.map((interval) => interval.factId),
      ...(completeness ? [completeness.id] : []),
    ];
    validateEvidence(factIds, evaluation.evidence, "unknown");
    if (completeness && !hasPrimary(completeness.id, evaluation.evidence))
      throw new RecruitingAssessmentValidationError(
        "Employment history completeness requires primary read evidence",
      );
    const historyComplete =
      completeness?.complete === true &&
      employmentDateBounds(completeness.asOf)[0] >= employmentDateBounds(cutoff)[0];
    const intervals = evaluation.intervals.map((interval) => {
      const fact = facts.get(interval.factId)!;
      if (fact.kind !== "employment")
        throw new RecruitingAssessmentValidationError(
          "Employment interval must reference an employment fact",
        );
      validateEvidence([fact.id], interval.evidence, interval.qualifyingFullTime);
      // Unread dates cannot establish either bound, even with a complete-history claim.
      if (!hasPrimary(fact.id, interval.evidence))
        return { start: null, end: null, qualifyingFullTime: "unknown" as const };
      return { start: fact.start, end: fact.end, qualifyingFullTime: interval.qualifyingFullTime };
    });
    const result = qualifiedEmploymentMonths({ ...rule, cutoff, historyComplete, intervals });
    const evidence = unique([
      ...evaluation.evidence,
      ...evaluation.intervals.flatMap((interval) => interval.evidence),
    ]);
    const missing = unique([
      ...evaluation.missing,
      ...evaluation.intervals.flatMap((interval) => interval.missing),
      ...(!historyComplete && result.verdict === "unknown"
        ? ["Provide complete employment history through the rule cutoff"]
        : []),
    ]);
    employment.push({
      ...evaluation,
      ...result,
      cutoff,
      minimumMonths: rule.minimumMonths,
      countingRule: rule.countingRule,
      qualificationDefinition: rule.qualificationDefinition,
      factIds,
      evidence,
      missing,
    });
    atoms.push({ atomId, verdict: result.verdict, factIds, evidence, missing });
  }
  const byId = new Map(atoms.map((judgment) => [judgment.atomId, judgment]));
  const results = evaluateRecruitingCriteria(
    role,
    new Map(atoms.map((judgment) => [judgment.atomId, judgment.verdict])),
  );
  return RecruitingAssessmentJudgmentsSchema.parse({
    atoms,
    employment,
    hardGate: results.hardGate,
    criteria: results.criteria.map((result, index) => {
      const dependencies = unique(criterionAtoms[index]!).map((id) => byId.get(id)!);
      return {
        ...result,
        factIds: unique(dependencies.flatMap((judgment) => judgment.factIds)),
        evidence: unique(dependencies.flatMap((judgment) => judgment.evidence)),
        missing: unique([
          ...role.criteria[index]!.definitionQuestions,
          ...dependencies.flatMap((judgment) => judgment.missing),
        ]),
      };
    }),
  });
}

/** Reuse semantic inputs only while their exact saved evidence dependencies remain unchanged. */
export function mergeRecruitingReassessment(
  role: Pick<RecruitingRoleRevision, "id" | "roleId" | "criteria" | "definitionQuestions">,
  previousAssessment: RecruitingAssessment,
  untrusted: ReassessRecruitingAssessmentInput,
): SaveRecruitingAssessmentInput {
  const parsed = ReassessAssessmentInputSchema.safeParse(untrusted);
  const saved = RecruitingAssessmentSchema.safeParse(previousAssessment);
  if (!parsed.success || !saved.success)
    throw new RecruitingAssessmentValidationError(
      "Invalid reassessment facts, sources or judgment dependencies",
    );
  const input = parsed.data;
  const previous = saved.data;
  if (
    input.roleId !== role.roleId ||
    previous.roleId !== role.roleId ||
    input.roleRevisionId !== role.id ||
    previous.roleRevisionId !== role.id
  )
    throw new RecruitingAssessmentValidationError(
      "A changed role revision requires a complete assessment",
    );
  if (input.candidateKey !== previous.candidateKey || input.expectedRevision !== previous.version)
    throw new RecruitingAssessmentValidationError(
      "Reassessment must target the saved candidate and version",
    );
  const { definitions } = recruitingRoleAtoms(role);
  for (const judgment of input.atomJudgments)
    if (!definitions.has(judgment.atomId) || definitions.get(judgment.atomId)!.employmentRule)
      throw new RecruitingAssessmentValidationError("Unknown semantic assessment atom ID");
  for (const evaluation of input.employmentEvaluations)
    if (!definitions.get(evaluation.atomId)?.employmentRule)
      throw new RecruitingAssessmentValidationError("Unknown employment assessment atom ID");
  for (const atom of previous.judgments.atoms)
    if (!definitions.has(atom.atomId))
      throw new RecruitingAssessmentValidationError("Saved assessment contains an unknown atom ID");
  for (const evaluation of previous.judgments.employment)
    if (!definitions.get(evaluation.atomId)?.employmentRule)
      throw new RecruitingAssessmentValidationError(
        "Saved assessment contains an unknown employment atom ID",
      );
  const changedIds = <T extends { id: string }>(
    before: readonly T[],
    after: readonly T[],
  ): Set<string> => {
    const old = new Map(before.map((item) => [item.id, item]));
    const next = new Map(after.map((item) => [item.id, item]));
    return new Set(
      [...old.keys(), ...next.keys()].filter(
        (id) => JSON.stringify(old.get(id)) !== JSON.stringify(next.get(id)),
      ),
    );
  };
  const changedFacts = changedIds(previous.facts, input.facts);
  const changedSources = changedIds(previous.sourceRefs, input.sourceRefs);
  const previousFacts = new Map(previous.facts.map((fact) => [fact.id, fact]));
  const dependsOnChange = (factIds: readonly string[], evidence: readonly string[]): boolean =>
    factIds.some(
      (id) =>
        changedFacts.has(id) ||
        previousFacts.get(id)?.sourceRefIds.some((sourceId) => changedSources.has(sourceId)),
    ) || evidence.some((id) => changedSources.has(id));
  const employmentChanged = [...previous.facts, ...input.facts].some(
    (fact) => fact.kind === "employment" && changedFacts.has(fact.id),
  );
  const semanticOverrides = new Map(
    input.atomJudgments.map((judgment) => [judgment.atomId, judgment]),
  );
  const employmentOverrides = new Map(
    input.employmentEvaluations.map((evaluation) => [evaluation.atomId, evaluation]),
  );
  const previousAtoms = new Map(
    previous.judgments.atoms.map((judgment) => [judgment.atomId, judgment]),
  );
  const previousEmployment = new Map(
    previous.judgments.employment.map((evaluation) => [evaluation.atomId, evaluation]),
  );
  const atomJudgments: RecruitingAtomJudgment[] = [];
  const employmentEvaluations: RecruitingEmploymentEvaluation[] = [];
  for (const [atomId, definition] of definitions) {
    if (!definition.employmentRule) {
      const override = semanticOverrides.get(atomId);
      const prior = previousAtoms.get(atomId);
      if (!override && (!prior || dependsOnChange(prior.factIds, prior.evidence)))
        throw new RecruitingAssessmentValidationError(
          "Changed semantic dependencies require an explicit atom update",
        );
      atomJudgments.push(override ?? prior!);
      continue;
    }
    const override = employmentOverrides.get(atomId);
    const prior = previousEmployment.get(atomId);
    if (
      !override &&
      (!prior || employmentChanged || dependsOnChange(prior.factIds, prior.evidence))
    )
      throw new RecruitingAssessmentValidationError(
        "Changed employment dependencies require an explicit evaluation update",
      );
    const evaluation = override ?? prior!;
    requireEmploymentClassifications(input.facts, evaluation);
    employmentEvaluations.push({
      atomId,
      intervals: evaluation.intervals,
      historyCompletenessFactId: evaluation.historyCompletenessFactId,
      evidence: evaluation.evidence,
      missing: evaluation.missing,
    });
  }
  const merged = SaveAssessmentInputSchema.safeParse({
    ...input,
    atomJudgments,
    employmentEvaluations,
  });
  if (!merged.success)
    throw new RecruitingAssessmentValidationError(
      "Merged reassessment contains invalid fact or source dependencies",
    );
  return merged.data;
}
