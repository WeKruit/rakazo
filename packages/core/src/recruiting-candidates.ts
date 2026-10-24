import type { RecruitingCandidateProfile, RecruitingCandidateReport } from "@rakazo/contracts";
import {
  isRecruitingCandidateReportField,
  RECRUITING_CANDIDATE_OUTPUT_JSON_SCHEMA,
  RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
  RecruitingCandidateOutputRowSchema,
  RecruitingCandidateProfileSchema,
  RecruitingCandidateReportSchema,
} from "@rakazo/contracts";
import { isMatchScoreKey, matchScore100, matchScoreScale } from "./match-score.js";
import { recruitingCalibrationIdentity } from "./recruiting-playbook.js";

/**
 * Flat profile columns the recruiter's profile view renders. They stay outside the frozen
 * identity contract, so older rows without them remain valid.
 */
export const RECRUITING_CANDIDATE_PROFILE_COLUMNS = [
  "Also return these profile columns with exactly these names, null when nothing is found:",
  '- experience: list[str], one entry per position, newest first, formatted "Title | Company | company website URL | Start – End | Location" (use "Present" for a current role; keep the dates as precise as the source).',
  '- education: list[str], one entry per degree, formatted "School | Degree, field of study | school website URL | Start – End".',
  "- profile_image_url: url of the person's own profile photo.",
  "- current_company_url: url of the current employer's own website.",
  '- current_company_industry: str, a short industry label such as "Logistics".',
  '- current_company_size: str, the employee count or range only, such as "1,001-5,000".',
  "Write the following in Simplified Chinese except proper names (people, schools, companies, papers, venues stay as written):",
  "- headline: str, one line of at most 30 characters on who the person is for this role.",
  "- highlights: list[str], 3 to 6 tags of at most 12 characters each (school, location, first-author record, awards, notable employers).",
  '- key_works: list[str], up to 4, each "Title | Venue Year or kind | role such as 一作 | URL".',
  "- concerns: list[str], up to 3 open questions or gaps from your own assessment, at most 20 characters each.",
  '- criteria_brief: list[str], one per assessed criterion, "criterion column name exactly as returned | short name of at most 8 characters | verdict of at most 20 characters".',
  '- entities: list[str], every organization named in highlights, experience, education or key_works, "Name as written in those fields | company/school/lab/award/venue | official website URL | one-line description of at most 20 characters".',
  "Each cell holds only its value: put sources in source_id, not check dates, caveats or provenance notes inside the value. Leave an unknown part of an entry empty rather than guessing it or replacing the entry with prose. These columns summarize the assessment; keep full reasoning in its usual cells.",
].join("\n");

export const RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS = [
  `Canonical candidate output schema: ${RECRUITING_CANDIDATE_OUTPUT_SCHEMA}`,
  JSON.stringify(RECRUITING_CANDIDATE_OUTPUT_JSON_SCHEMA),
  "Return one person per row with these exact column names. Keep additional requested role signals in additional columns. Native sourced cells may retain {value, source_id} and _sources metadata.",
  "Use null for unknown fields, including unknown evidence_urls; an empty evidence_urls array means no evidence links were supplied. Do not invent identities, resumes or emails. Do not collect phone numbers. linkedin_url must identify the person's HTTPS LinkedIn /in/ profile. evidence_urls and resume_url must be actual supplied HTTP(S) links.",
  "match_score is a number from 0 to 100 (100 = strongest fit). Never use a 0–10 or 0–1 scale.",
  RECRUITING_CANDIDATE_PROFILE_COLUMNS,
  "All returned rows are provider_report observations. Provider labels do not establish qualification; preserve source links for subsequent evidence assessment.",
].join("\n");

const emptyProfile = (): RecruitingCandidateProfile => ({
  name: null,
  title: null,
  company: null,
  location: null,
  linkedinUrl: null,
  resumeUrl: null,
  evidenceUrls: null,
  issues: [],
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function webUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

/** Project only the frozen output contract; raw bytes and source-cell metadata stay in the Artifact. */
export function normalizeRecruitingCandidateRow(
  row: unknown,
  options: { schemaKnown: boolean },
): RecruitingCandidateProfile & { candidateKey: string | null } {
  if (!options.schemaKnown)
    return { ...emptyProfile(), issues: ["historical_schema_unknown"], candidateKey: null };
  if (!record(row)) return { ...emptyProfile(), issues: ["invalid_row"], candidateKey: null };
  const issues: string[] = [];
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(RecruitingCandidateOutputRowSchema.shape) as Array<
    keyof typeof RecruitingCandidateOutputRowSchema.shape
  >) {
    if (!Object.hasOwn(row, key)) {
      values[key] = null;
      issues.push(`missing_field:${key}`);
      continue;
    }
    const cell = row[key];
    const value = record(cell) && Object.hasOwn(cell, "value") ? cell.value : cell;
    const parsed = RecruitingCandidateOutputRowSchema.shape[key].safeParse(value);
    if (!parsed.success) {
      values[key] = null;
      issues.push(`invalid_field:${key}`);
    } else if (typeof parsed.data === "string" && !parsed.data.trim()) {
      values[key] = null;
      issues.push(`blank_field:${key}`);
    } else {
      values[key] = parsed.data;
    }
  }
  let candidateKey: string | null = null;
  if (typeof values.linkedin_url === "string") {
    const url = webUrl(values.linkedin_url);
    const identity = url && !url.port ? recruitingCalibrationIdentity(values.linkedin_url) : null;
    if (identity) candidateKey = `linkedin:${identity}`;
    else {
      values.linkedin_url = null;
      issues.push("invalid_url:linkedin_url");
    }
  }
  if (!candidateKey && Object.hasOwn(row, "profile_url")) {
    const cell = row.profile_url;
    const value = record(cell) && Object.hasOwn(cell, "value") ? cell.value : cell;
    const url = typeof value === "string" ? webUrl(value) : null;
    if (url) {
      if (/(^|\.)linkedin\.com\.?$/.test(url.hostname)) {
        const identity = !url.port ? recruitingCalibrationIdentity(url.href) : null;
        if (identity) candidateKey = `linkedin:${identity}`;
      }
    }
  }
  if (typeof values.resume_url === "string" && !webUrl(values.resume_url)) {
    values.resume_url = null;
    issues.push("invalid_url:resume_url");
  }
  if (
    Array.isArray(values.evidence_urls) &&
    !values.evidence_urls.every((value) => typeof value === "string" && webUrl(value))
  ) {
    values.evidence_urls = null;
    issues.push("invalid_url:evidence_urls");
  }
  return {
    ...RecruitingCandidateProfileSchema.parse({
      name: values.name,
      title: values.current_title,
      company: values.current_company,
      location: values.location,
      linkedinUrl: values.linkedin_url,
      resumeUrl: values.resume_url,
      evidenceUrls: values.evidence_urls,
      issues,
    }),
    candidateKey,
  };
}

export { isRecruitingCandidateReportField } from "@rakazo/contracts";

/** Keep nested business values and source provenance; the original artifact retains diagnostics. */
function reportValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reportValue);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => isRecruitingCandidateReportField(key) || key === "source_id")
      .map(([key, nested]) => [key, reportValue(nested)]),
  );
}

/**
 * Preserve supplied scalar and structured observations; the original artifact remains authoritative.
 * Score cells are shown on 0–100; `pageRows` (the row's whole saved result) decides whether its
 * plain numbers were on 0–10.
 */
export function projectRecruitingCandidateReport(
  raw: unknown,
  pageRows?: readonly unknown[],
): RecruitingCandidateReport {
  const row = record(raw) ? raw : undefined;
  if (!row) throw new Error("Retained candidate row is invalid");
  const scoreScale = (key: string) =>
    matchScoreScale((pageRows ?? [row]).map((other) => (record(other) ? other[key] : undefined)));
  const sources = record(row._sources) ? row._sources : undefined;
  const links = (value: unknown): string[] => {
    const values = Array.isArray(value) ? value : [value];
    return values.filter((value): value is string => {
      // ponytail: keep annotated or multi-URL prose as text instead of guessing link boundaries.
      if (typeof value !== "string" || /\s/u.test(value)) return false;
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    });
  };
  const scalar = (value: unknown): value is string | number | boolean | null =>
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
  const fields: RecruitingCandidateReport["fields"] = [];
  for (const [key, rawCell] of Object.entries(row)) {
    if (!isRecruitingCandidateReportField(key)) continue;
    const cell = record(rawCell) ? rawCell : undefined;
    const absent =
      cell &&
      !Object.hasOwn(cell, "value") &&
      Object.hasOwn(cell, "absent") &&
      typeof cell.absent === "boolean";
    const value =
      cell && Object.hasOwn(cell, "value") ? cell.value : absent ? cell.absent : rawCell;
    const textValue = scalar(value) || (Array.isArray(value) && value.every(scalar));
    const structured = textValue
      ? undefined
      : RecruitingCandidateReportSchema.shape.fields.element.shape.structuredValue
          .unwrap()
          .safeParse(reportValue(value));
    if (!textValue && !structured?.success) continue;
    const sourceIds = cell
      ? Array.isArray(cell.source_id)
        ? cell.source_id
        : [cell.source_id]
      : [];
    const sourceUrls = [
      ...new Set([
        ...links(value),
        ...sourceIds.flatMap((id) =>
          typeof id === "string" && sources && Object.hasOwn(sources, id) ? links(sources[id]) : [],
        ),
      ]),
    ];
    const providerStatus =
      key.startsWith("rule_") &&
      key.length > 5 &&
      cell &&
      cell.absent !== true &&
      (value === "match" || value === "miss" || value === "unclear")
        ? value
        : undefined;
    const displayKey = key.replace(/^(?:rule_[a-z]+\d+|round\d+)_/i, "");
    const label = (providerStatus ? displayKey.replace(/^rule_/, "") : displayKey)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim();
    if (!label) continue;
    const score =
      !absent && !providerStatus && isMatchScoreKey(displayKey)
        ? matchScore100(value, scoreScale(key))
        : null;
    fields.push({
      label: label[0]!.toUpperCase() + label.slice(1) + (absent ? " absent" : ""),
      value:
        score !== null
          ? String(score)
          : !textValue || value === null
            ? null
            : Array.isArray(value)
              ? value.map(String).join("\n")
              : String(value),
      ...(structured?.success
        ? {
            structuredValue: structured.data,
            sourceIds: sourceIds.filter((id): id is string => typeof id === "string"),
            sourceUrlsById: Object.fromEntries(
              Object.entries(sources ?? {}).map(([id, value]) => [id, links(value)]),
            ),
          }
        : {}),

      ...(providerStatus ? { providerStatus } : {}),
      ...(typeof cell?.evidence === "string" ? { evidence: cell.evidence } : {}),
      ...(typeof cell?.reasoning === "string" ? { reasoning: cell.reasoning } : {}),
      sourceUrls,
    });
  }
  if (!fields.length) throw new Error("Retained candidate row has no readable observations");
  return { fields, sourceUrls: [...new Set(fields.flatMap((field) => field.sourceUrls))] };
}
