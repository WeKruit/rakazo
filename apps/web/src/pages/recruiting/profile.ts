import type { RecruitingCandidateReport } from "@rakazo/contracts";
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
const EMAIL = /^(?:(?:work|professional|business|personal) )?emails?(?: address(?:es)?)?$/i;
const PHONE = /^(?:(?:work|business|mobile) )?(?:phone|mobile)(?: numbers?| phone)?$/i;
const CONTACT_STATUS = /^(?:email (?:status|verification(?: status)?)|contact status|verification status)$/i;
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
  const experience = take((field) => !field.providerStatus && EXPERIENCE.test(field.label));
  const education = take((field) => !field.providerStatus && EDUCATION.test(field.label));
  const skillFields = take((field) => !field.providerStatus && SKILLS.test(field.label));
  const emails = contact(EMAIL);
  const phones = contact(PHONE);
  const contactStatus = contact(CONTACT_STATUS);
  const placed = new Set<Field>([
    ...criteria,
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
