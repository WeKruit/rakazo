import { t } from "@lingui/core/macro";

/** Recruiter wording for report columns the research commonly returns; others keep their name. */
const LABELS: Record<string, () => string> = {
  "fit rationale": () => t`Fit rationale`,
  "review rationale": () => t`Review rationale`,
  "criterion brief": () => t`Criterion summary`,
  "criterion findings": () => t`Criterion findings`,
  "current company": () => t`Current company`,
  "current title": () => t`Current title`,
  "current role": () => t`Current role`,
  languages: () => t`Languages`,
  language: () => t`Language`,
  "language evidence": () => t`Language evidence`,
  headline: () => t`Headline`,
  summary: () => t`Summary`,
  location: () => t`Location`,
  seniority: () => t`Seniority`,
  "years of experience": () => t`Years of experience`,
  "total years of experience": () => t`Years of experience`,
  "current role start": () => t`Current role start`,
  "current role start month": () => t`Current role start`,
  "time in current role": () => t`Time in current role`,
  industry: () => t`Industry`,
  degree: () => t`Degree`,
  highlights: () => t`Highlights`,
  concerns: () => t`Concerns`,
  risks: () => t`Risks`,
  "evidence quote": () => t`Evidence quote`,
  "evidence quotes": () => t`Evidence quote`,
  evidence: () => t`Evidence`,
  notes: () => t`Notes`,
  "research notes": () => t`Notes`,
  reason: () => t`Reason`,
  grade: () => t`Grade`,
  "grade reason": () => t`Grade reason`,
  "match reasons": () => t`Match reasons`,
  "fit reasons": () => t`Match reasons`,
  "core duties": () => t`Core duties`,
  "core work evidence": () => t`Core work evidence`,
  "previous companies": () => t`Previous companies`,
  "company type": () => t`Company type`,
  "selection basis": () => t`Selection basis`,
  "search query": () => t`Search query`,
};

export function fieldLabel(label: string): string {
  return (
    LABELS[
      label
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, " ")
    ]?.() ?? label
  );
}
