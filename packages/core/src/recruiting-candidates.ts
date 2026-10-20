import type { RecruitingCandidateProfile, RecruitingCandidateReport } from "@rakazo/contracts";
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

// These are transport/provenance fields, not provider observations about the person.
const reportMetadata = new Set([
  "id",
  "taskid",
  "taskids",
  "providertaskid",
  "artifactid",
  "artifactids",
  "artifactref",
  "actionid",
  "effectid",
  "runid",
  "threadid",
  "roleid",
  "rolerevisionid",
  "sourceid",
  "shardid",
  "shardids",
  "outputid",
  "receiptid",
  "request",
  "response",
  "route",
  "routing",
  "cursor",
  "nextcursor",
  "requestcursor",
  "providerresult",
  "observation",
  "metadata",
  "traceid",
  "storagekey",
  "sha256",
  "hash",
  "toolname",
  "connectorid",
  "resourceid",
  "resourcerevision",
  "cataloggroup",
  "clientnonce",
]);

/** The same business/provenance boundary governs report display and retained row equivalence. */
export function isRecruitingCandidateReportField(key: string): boolean {
  return !key.startsWith("_") && !reportMetadata.has(key.replace(/[_-]/g, "").toLowerCase());
}

/** Display supplied scalar observations only; the original artifact remains authoritative. */
export function projectRecruitingCandidateReport(raw: unknown): RecruitingCandidateReport {
  const row = record(raw) ? raw : undefined;
  if (!row) throw new Error("Retained candidate row is invalid");
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
    if (!scalar(value) && !(Array.isArray(value) && value.every(scalar))) continue;
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
    const label = key
      .replace(/^(?:rule_[a-z]+\d+|round\d+)_/i, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim();
    if (!label) continue;
    fields.push({
      label: label[0]!.toUpperCase() + label.slice(1) + (absent ? " absent" : ""),
      value:
        value === null ? null : Array.isArray(value) ? value.map(String).join("\n") : String(value),
      ...(typeof cell?.evidence === "string" ? { evidence: cell.evidence } : {}),
      ...(typeof cell?.reasoning === "string" ? { reasoning: cell.reasoning } : {}),
      sourceUrls,
    });
  }
  if (!fields.length) throw new Error("Retained candidate row has no readable observations");
  return { fields, sourceUrls: [...new Set(fields.flatMap((field) => field.sourceUrls))] };
}
