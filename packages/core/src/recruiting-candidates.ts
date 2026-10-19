import type { RecruitingCandidateProfile } from "@rakazo/contracts";
import {
  RECRUITING_CANDIDATE_OUTPUT_JSON_SCHEMA,
  RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
  RecruitingCandidateOutputRowSchema,
  RecruitingCandidateProfileSchema,
} from "@rakazo/contracts";
import { recruitingCalibrationIdentity } from "./recruiting-playbook.js";

export const RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS = [
  `Canonical candidate output schema: ${RECRUITING_CANDIDATE_OUTPUT_SCHEMA}`,
  JSON.stringify(RECRUITING_CANDIDATE_OUTPUT_JSON_SCHEMA),
  "Return one person per row with these exact column names. Keep additional requested role signals in additional columns. Native sourced cells may retain {value, source_id} and _sources metadata.",
  "Use null for unknown fields, including unknown evidence_urls; an empty evidence_urls array means no evidence links were supplied. Do not invent identities, resumes or emails. Do not collect phone numbers. linkedin_url must identify the person's HTTPS LinkedIn /in/ profile. evidence_urls and resume_url must be actual supplied HTTP(S) links.",
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
      } else candidateKey = `profile:${url.href}`;
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
