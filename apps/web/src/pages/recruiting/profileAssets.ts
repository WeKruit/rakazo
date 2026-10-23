import type { RecruitingCandidateReport } from "@rakazo/contracts";
import { parseTimeline } from "./profileTimeline";

type Field = RecruitingCandidateReport["fields"][number];
export type ProfileAssets = {
  photo: string | null;
  company: { name: string; url: string } | null;
  school: { name: string; url: string } | null;
  companyLink: { name: string; url: string } | null;
  schoolLink: { name: string; url: string } | null;
};

const PHOTO = /^(?:profile (?:photo|image)|avatar|photo) url$/i;
const COMPANY_LOGO = /^company logo url$/i;
const SCHOOL_LOGO = /^(?:school|university) logo url$/i;
const COMPANY_LINK = /^company (?:url|website(?: url)?)$/i;
const SCHOOL_LINK = /^(?:school|university) (?:url|website(?: url)?)$/i;

/** Only an explicitly supplied asset URL; never derive a logo/photo from a name or source host. */
export function profileImageUrl(value: string | null | undefined): string | null {
  if (!value || /\s/.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function isProfileAssetField(field: Field) {
  if (field.providerStatus !== undefined || field.evidence || field.reasoning) return false;
  return [PHOTO, COMPANY_LOGO, SCHOOL_LOGO, COMPANY_LINK, SCHOOL_LINK].some((pattern) =>
    pattern.test(field.label.trim()),
  );
}

/** Additional scalar report columns already survive the existing sourced-report projection. */
export function profileAssets(fields: readonly Field[], company?: string | null): ProfileAssets {
  const value = (pattern: RegExp) =>
    fields.find((field) => pattern.test(field.label.trim()))?.value?.trim() || null;
  const asset = (pattern: RegExp, name: string | null) => {
    const url = profileImageUrl(value(pattern));
    return name && url ? { name, url } : null;
  };
  return {
    photo: profileImageUrl(value(PHOTO)),
    company: asset(COMPANY_LOGO, value(/^(?:current )?company$/i) ?? company ?? null),
    school: asset(SCHOOL_LOGO, value(/^(?:school|university)$/i)),
    companyLink: asset(COMPANY_LINK, value(/^(?:current )?company$/i) ?? company ?? null),
    schoolLink: asset(SCHOOL_LINK, value(/^(?:school|university)$/i)),
  };
}

/** A name-only school column need not repeat a dated education entry; retain both citations. */
export function profileContentFields(fields: readonly Field[]) {
  const content = fields.filter((field) => !isProfileAssetField(field));
  const sameSchool = (entry: Field, school: Field) =>
    /^education$/i.test(entry.label.trim()) &&
    parseTimeline(entry.value, "education", new Date()).some(
      (item) => item.primary.trim() === school.value?.trim(),
    );
  const duplicates = content.filter(
    (field) =>
      /^(?:school|university)$/i.test(field.label.trim()) &&
      field.value?.trim() &&
      field.providerStatus === undefined &&
      !field.evidence &&
      !field.reasoning &&
      content.some((entry) => sameSchool(entry, field)),
  );
  return content
    .filter((field) => !duplicates.includes(field))
    .map((field) =>
      /^education$/i.test(field.label.trim())
        ? {
            ...field,
            sourceUrls: [
              ...new Set([
                ...field.sourceUrls,
                ...duplicates.flatMap((entry) =>
                  sameSchool(field, entry) ? entry.sourceUrls : [],
                ),
              ]),
            ],
          }
        : field,
    );
}

export function organizationLogo(
  name: string | undefined,
  asset: ProfileAssets["company"],
): string | null {
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return name && asset && normalize(name) === normalize(asset.name) ? asset.url : null;
}
