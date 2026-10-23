import type {
  RecruitingCandidateReport,
  RecruitingRoleCandidate,
  RecruitingRoleRevision,
} from "@rakazo/contracts";
import { recruitingCandidateSourceText } from "@rakazo/contracts";
import type { TimelineEntry } from "./profileTimeline";
import { storedExperienceTimeline, structuredProfileTimeline } from "./profileTimeline";
import type { RoleCandidateFit } from "./roleCandidates";
import { roleCandidateFit } from "./roleCandidates";

type Field = RecruitingCandidateReport["fields"][number] & {
  timelineEntries?: readonly TimelineEntry[];
  sourceText?: string;
};

export type ProfileCriterionRevision = Pick<RecruitingRoleRevision, "id" | "criteria">;
export type ProfileCriterionContext = {
  /** The revision recorded with this candidate's source, never the current revision by default. */
  roleRevisionId: string | null | undefined;
  revision: ProfileCriterionRevision | null | undefined;
};

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
const EXPERIENCE = /experience|employment|work history|career|tenure|^employer descriptions?$/i;
const EDUCATION = /educat|school|degree|universit|college/i;
// A concern mentioning skills is research text, not a declared list of skills.
const SKILLS =
  /^(?:(?:technical|core|key|top|primary|professional)\s+)?skills?(?:\s+(?:list|summary))?$/i;

/**
 * Autumn's report fields sorted into the sections a recruiter reads, as returned and never
 * re-judged. Fields that fit no named section stay together as research findings.
 */
export function candidateSections(
  fields: readonly Field[] | undefined,
  criterionContext?: ProfileCriterionContext,
) {
  const all = (fields ?? []).filter(
    (field) =>
      field.value?.trim() ||
      field.evidence?.trim() ||
      field.reasoning?.trim() ||
      field.structuredValue !== undefined ||
      field.providerStatus,
  );
  const take = (test: (field: Field) => boolean) => all.filter(test);
  const contact = (pattern: RegExp) =>
    take((field) => field.structuredValue === undefined && pattern.test(field.label.trim()));
  const criteria = take((field) => field.providerStatus !== undefined);
  const summary = SUMMARY_LABELS.map((label) =>
    all.find((field) => field.structuredValue === undefined && field.label === label),
  ).find(Boolean);
  const assessment = take(
    (field) => field.structuredValue === undefined && ASSESSMENT.test(field.label.trim()),
  );
  const assessed = assessment.map((field) => requirementRows(fieldText(field), criterionContext));
  const scope = all.find(
    (field) => field.structuredValue === undefined && SCOPE_LABELS.has(field.label.trim()),
  );
  const resumeUrl = contact(RESUME_URL).find((field) => /^https?:\/\//i.test(field.value ?? ""));
  const resumeFields = contact(/^(?:resume|cv) (?:url|link|status)$/i);
  const experience = take((field) => !field.providerStatus && EXPERIENCE.test(field.label));
  const education = take((field) => !field.providerStatus && EDUCATION.test(field.label));
  const skillFields = take(
    (field) =>
      field.structuredValue === undefined && !field.providerStatus && SKILLS.test(field.label),
  );
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
    ...all.filter((field) => field.structuredValue === undefined && FIT_LABELS.has(field.label)),
  ]);
  const criterionRows = criteria.map((field, index) => ({
    ...criterionRow(field, criterionContext),
    key: `criterion:${index}:${field.label}`,
  }));
  const assessmentRows = assessed.map((item, index) =>
    item.rows.map((row) => ({
      ...row,
      key: `assessment:${index}:${row.key}`,
    })),
  );
  const requirements = [...criterionRows, ...assessmentRows.flat()];
  const skillEvidence: SkillEvidenceSource[] = [
    ...criterionRows.map((row) => ({
      ...row,
      label: row.label ?? "",
      kind: "assessment" as const,
    })),
    ...assessmentRows.flatMap((rows, index) =>
      rows.map((row) => ({
        ...row,
        label: row.label ?? (row.criterionId ? "" : assessment[index]!.label),
        sourceUrls: [
          ...new Set([...assessed[index]!.sourceUrls, ...assessment[index]!.sourceUrls]),
        ],
        kind: "assessment" as const,
      })),
    ),
    ...all
      .filter(
        (field) =>
          !criteria.includes(field) &&
          !assessment.includes(field) &&
          !FIT_LABELS.has(field.label) &&
          !SCOPE_LABELS.has(field.label) &&
          !emails.includes(field) &&
          !phones.includes(field) &&
          !contactStatus.includes(field) &&
          !resumeFields.includes(field),
      )
      .flatMap((field, index): SkillEvidenceSource[] => {
        const kind = experience.includes(field)
          ? "experience"
          : education.includes(field)
            ? "education"
            : null;
        const entries =
          field.timelineEntries ??
          (kind && field.structuredValue !== undefined
            ? structuredProfileTimeline(
                field.structuredValue,
                kind,
                new Date(),
                field.sourceUrlsById,
              )
            : []);
        return [
          ...entries.map(
            (entry, entryIndex): SkillEvidenceSource => ({
              key: `field:${index}:entry:${entryIndex}`,
              label: [field.label, entry.primary, entry.secondary].filter(Boolean).join(" · "),
              text: entry.structured
                ? [entry.primary, entry.secondary, entry.dateLabel, entry.detail, entry.description]
                    .filter(Boolean)
                    .join("\n")
                : entry.text,
              sourceUrls: [...new Set([...field.sourceUrls, ...(entry.sourceUrls ?? [])])],
              kind: "profile",
            }),
          ),
          {
            key: `field:${index}`,
            label: field.label,
            text: entries.length
              ? [field.evidence, field.reasoning].filter(Boolean).join("\n")
              : fieldText(field),
            sourceUrls: field.sourceUrls,
            kind: skillFields.includes(field) ? ("listed" as const) : ("profile" as const),
          },
        ].filter((source) => source.text.trim());
      }),
  ];
  return {
    fit: roleCandidateFit(all) as RoleCandidateFit | null,
    summary: summary ? fieldText(summary) || null : null,
    criteria,
    requirements,
    skillEvidence,
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

/** Saved source context, not evidence of qualification inferred from a skill mention. */
export type SkillEvidenceSource = {
  key: string;
  label: string;
  criterionId?: string;
  text: string;
  sourceUrls: readonly string[];
  kind: "listed" | "profile" | "assessment";
  status?: RequirementStatus;
};

/** One requirement line of Autumn's own assessment, its words kept verbatim. */
export type RequirementRow = {
  key: string;
  /** Supplied criterion name or exact matching definition; never an inferred technical name. */
  label: string | null;
  /** Original source reference kept separately from the readable definition. */
  criterionId?: string;
  status: RequirementStatus;
  text: string;
  sourceUrls: readonly string[];
};

const STATUS_WORDS: [RegExp, RequirementStatus][] = [
  [
    /^(?:unclear|unknown|uncertain|unverified|not assessed|no evidence|not enough evidence|未知|不确定|未评估|无证据)$/i,
    "unknown",
  ],
  [
    /^(?:partial(?:ly)?(?: (?:met|match|fact))?|potential(?: match)?|weak|mixed|部分符合|部分)$/i,
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

function criterionName(reference: string, context?: ProfileCriterionContext) {
  const criterion =
    context?.roleRevisionId && context.revision?.id === context.roleRevisionId
      ? context.revision.criteria.find((item) => item.id === reference)
      : undefined;
  if (criterion) {
    // A composite has no single name. Keep it unresolved rather than dropping its operators
    // or promoting one child statement to the whole criterion.
    return {
      label: criterion.expression.kind === "atom" ? criterion.expression.statement : null,
      criterionId: reference,
    };
  }
  return /^R\d+$/i.test(reference) ? { label: null, criterionId: reference } : { label: reference };
}

function criterionRow(field: Field, context?: ProfileCriterionContext): RequirementRow {
  return {
    key: `criterion:${field.label}`,
    ...criterionName(field.label, context),
    status:
      field.providerStatus === "match"
        ? "match"
        : field.providerStatus === "miss"
          ? "gap"
          : "unknown",
    text: fieldText(field, false),
    sourceUrls: field.sourceUrls,
  };
}

function fieldText(field: Field, includeValue = true) {
  return [
    ...new Set(
      [...(includeValue ? [field.value] : []), field.evidence, field.reasoning].filter(
        (part): part is string => Boolean(part?.trim()),
      ),
    ),
  ].join("\n\n");
}

/**
 * Splits Autumn's "R1: Fact - … R2: Gap - … [Sources read …]" assessment into one row per
 * requirement, keeping its status word's meaning and its evidence as written. Text it cannot
 * split stays one row with an unknown status. Cited source links are returned once.
 */
export function requirementRows(
  value: string,
  context?: ProfileCriterionContext,
): {
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
      ...(match ? criterionName(match[1]!, context) : { label: null }),
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
  const experience = storedExperienceTimeline(profile.history, new Date());
  return [
    ...(experience.length
      ? [
          {
            label: "Experience",
            value: experience
              .map((entry) =>
                entry.structured
                  ? [entry.primary, entry.secondary, entry.dateLabel].filter(Boolean).join(" · ")
                  : entry.text,
              )
              .join("\n"),
            sourceText: recruitingCandidateSourceText(profile.history),
            timelineEntries: experience,
            sourceUrls: [],
          },
        ]
      : []),
    ...(profile.summary.trim()
      ? [{ label: "Summary", value: profile.summary, sourceUrls: [] }]
      : []),
    ...(profile.skills.length
      ? [{ label: "Skills", value: profile.skills.join(", "), sourceUrls: [] }]
      : []),
  ];
}
