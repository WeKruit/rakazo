import type { RecruitingCandidateReport, RecruitingRoleCandidate } from "@rakazo/contracts";
import type { RoleCandidateFit } from "./roleCandidates";
import { roleCandidateFit } from "./roleCandidates";

type Field = RecruitingCandidateReport["fields"][number];

const FIT_LABELS = new Set([
  "Match score",
  "Score",
  "Updated rank",
  "Overall rank",
  "Rank",
  "Original pool rank",
  "Batch rank",
  "Match tier",
  "Grade",
]);
const SUMMARY_LABELS = ["Fit reasons", "Recommendation", "Match judgment"];
const SCOPE_LABELS = new Set(["Ranking scope", "Rank scope"]);
const ASSESSMENT = /^(?:requirements?|criteria) (?:assessment|evaluation|check)s?$/i;
const RESUME_URL = /^(?:resume|cv) (?:url|link)$/i;
const EMAIL = /^(?:(?:work|professional|business|personal) )?emails?(?: address(?:es)?)?$/i;
const PHONE = /^(?:(?:work|business|mobile) )?(?:phone|mobile)(?: numbers?| phone)?$/i;
const CONTACT_STATUS =
  /^(?:email (?:status|verification(?: status)?)|contact status|verification status)$/i;
const EXPERIENCE = /experience|employment|work history|career|tenure/i;
const EDUCATION = /educat|school|degree|universit|college/i;
const SKILLS = /skill/i;

/**
 * Autumn's report fields sorted into the sections a recruiter reads, as returned and never
 * re-judged. Fields that fit no named section stay together as research findings.
 */
export function candidateSections(fields: readonly Field[] | undefined) {
  const all = (fields ?? []).filter((field) => field.value?.trim() || field.providerStatus);
  const take = (test: (field: Field) => boolean) => all.filter(test);
  const contact = (pattern: RegExp) => take((field) => pattern.test(field.label.trim()));
  const criteria = take((field) => field.providerStatus !== undefined);
  const summary = SUMMARY_LABELS.map((label) => all.find((field) => field.label === label)).find(
    Boolean,
  );
  const assessment = take((field) => ASSESSMENT.test(field.label.trim()));
  const assessed = assessment.map((field) => requirementRows(field.value ?? ""));
  const scope = all.find((field) => SCOPE_LABELS.has(field.label.trim()));
  const resumeUrl = contact(RESUME_URL).find((field) => /^https?:\/\//i.test(field.value ?? ""));
  const resumeFields = contact(/^(?:resume|cv) (?:url|link|status)$/i);
  const experience = take((field) => !field.providerStatus && EXPERIENCE.test(field.label));
  const education = take((field) => !field.providerStatus && EDUCATION.test(field.label));
  const skillFields = take((field) => !field.providerStatus && SKILLS.test(field.label));
  const emails = contact(EMAIL);
  const phones = contact(PHONE);
  const contactStatus = contact(CONTACT_STATUS);
  const placed = new Set<Field>([
    ...criteria,
    ...assessment,
    ...(scope ? [scope] : []),
    ...(resumeUrl ? resumeFields : []),
    ...experience,
    ...education,
    ...skillFields,
    ...emails,
    ...phones,
    ...contactStatus,
    ...all.filter((field) => FIT_LABELS.has(field.label)),
  ]);
  return {
    fit: roleCandidateFit(all) as RoleCandidateFit | null,
    summary: summary?.value ?? null,
    criteria,
    requirements: [...criteria.map(criterionRow), ...assessed.flatMap((item) => item.rows)],
    requirementSources: [
      ...new Set(
        assessment.flatMap((field, index) => [...assessed[index]!.sourceUrls, ...field.sourceUrls]),
      ),
    ],
    scope: scope?.value?.trim() || null,
    resumeUrl: resumeUrl?.value?.trim() ?? null,
    experience,
    education,
    skills: [
      ...new Set(
        skillFields.flatMap((field) =>
          (field.value ?? "")
            .split(/[,;•\n]+/)
            .map((skill) => skill.trim())
            .filter(Boolean),
        ),
      ),
    ],
    email: emails[0]?.value?.trim() ?? null,
    phone: phones[0]?.value?.trim() ?? null,
    contactStatus: contactStatus[0]?.value?.trim() ?? null,
    findings: all.filter((field) => !placed.has(field) && field !== summary),
  };
}

export type RequirementStatus = "match" | "gap" | "partial" | "unknown";

/** One requirement line of Autumn's own assessment, its words kept verbatim. */
export type RequirementRow = {
  key: string;
  /** Autumn's requirement reference ("R2") or criterion name, when it gave one. */
  label: string | null;
  status: RequirementStatus;
  text: string;
  sourceUrls: readonly string[];
};

const STATUS_WORDS: [RegExp, RequirementStatus][] = [
  [
    /^(?:partial(?:ly)?(?: (?:met|match|fact))?|potential(?: match)?|unclear|unknown|uncertain|weak|mixed|部分符合|部分|不确定)$/i,
    "partial",
  ],
  [/^(?:fact|match|met|good match|strong|yes|pass|符合|满足|事实)$/i, "match"],
  [/^(?:gap|miss|not met|no match|not a match|no|fail|missing|不符合|缺口|差距|缺失)$/i, "gap"],
];
const CITATION = /\[\s*sources?\b[^\]]*\]/gi;
const LINK = /https?:\/\/[^\s,;\]]+/g;

function statusOf(word: string): RequirementStatus | null {
  const clean = word.trim();
  return STATUS_WORDS.find(([pattern]) => pattern.test(clean))?.[1] ?? null;
}

function criterionRow(field: Field): RequirementRow {
  return {
    key: `criterion:${field.label}`,
    label: field.label,
    status:
      field.providerStatus === "match"
        ? "match"
        : field.providerStatus === "miss"
          ? "gap"
          : "partial",
    text: field.evidence ?? field.reasoning ?? "",
    sourceUrls: field.sourceUrls,
  };
}

/**
 * Splits Autumn's "R1: Fact - … R2: Gap - … [Sources read …]" assessment into one row per
 * requirement, keeping its status word's meaning and its evidence as written. Text it cannot
 * split stays one row with an unknown status. Cited source links are returned once.
 */
export function requirementRows(value: string): {
  rows: RequirementRow[];
  sourceUrls: string[];
} {
  const cited: string[] = [];
  const body = value
    .replace(CITATION, (block: string) => {
      cited.push(...(block.match(LINK) ?? []));
      return "";
    })
    .trim();
  const sourceUrls = [...new Set(cited.map((url) => url.replace(/[.)]+$/, "")))];
  const parts = body
    ? body.split(/(?:^|\s|[;；])(?=R\d+\s*[:：])/).filter((part) => part.trim())
    : [];
  const rows = parts.map((part, index): RequirementRow => {
    const match = /^(R\d+)\s*[:：]\s*(.*)$/s.exec(part.trim());
    const rest = (match?.[2] ?? part).trim();
    const status = /^([^-–—:：]{1,24}?)\s*[-–—:：]\s*(.*)$/s.exec(rest);
    const parsed = status ? statusOf(status[1]!) : null;
    return {
      key: match?.[1] ?? `row:${index}`,
      label: match?.[1] ?? null,
      status: parsed ?? "unknown",
      text: (parsed ? status![2]! : rest).trim().replace(/[;；]$/, ""),
      sourceUrls: [],
    };
  });
  return { rows, sourceUrls };
}

/** Up to two initials for an avatar without a photo. */
export function initials(name: string) {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0]!.toUpperCase())
    .join("");
}

/** The profile handle of a LinkedIn URL, e.g. "ada-lovelace". */
export function linkedinHandle(url: string | null | undefined) {
  if (!url) return null;
  try {
    return (
      decodeURIComponent(new URL(url).pathname)
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean)
        .at(-1) ?? null
    );
  } catch {
    return null;
  }
}

/** A short readable label for an evidence link instead of the raw URL. */
export function sourceLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Present stored profile facts in the existing sections, without deriving qualifications. */
export function storedProfileFields(
  profile: NonNullable<RecruitingRoleCandidate["crm"]>["profile"],
): Field[] {
  if (!profile) return [];
  const history = Array.isArray(profile.history) ? profile.history : [profile.history];
  const experience = history.flatMap((entry): string[] => {
    if (typeof entry === "string") return entry.trim() ? [entry] : [];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const text = (key: string) => (typeof entry[key] === "string" ? (entry[key] as string) : "");
    const name = [text("title"), text("company")].filter(Boolean).join(" · ");
    if (!name) return [];
    const dates = [text("start"), text("end")].filter(Boolean).join(" – ");
    return [[name, dates].filter(Boolean).join(" · ")];
  });
  return [
    ...(experience.length
      ? [{ label: "Experience", value: experience.join("\n"), sourceUrls: [] }]
      : []),
    ...(profile.summary.trim()
      ? [{ label: "Summary", value: profile.summary, sourceUrls: [] }]
      : []),
    ...(profile.skills.length
      ? [{ label: "Skills", value: profile.skills.join(", "), sourceUrls: [] }]
      : []),
  ];
}
