/**
 * One candidate list per role: Autumn search results and the role's CRM contacts, merged so a
 * person who is both appears once. Pure and display-only; never re-ranks or qualifies anyone.
 */

/** Autumn's own fit fields as it returned them; null when it returned none. */
export type RoleCandidateFit = {
  score: { label: string; value: string } | null;
  rank: { label: string; value: string } | null;
  tier: { label: string; value: string } | null;
};

export type RoleCandidateEntry<T> = {
  key: string;
  name: string | null;
  title: string | null;
  location: string | null;
  email: string | null;
  linkedinUrl: string | null;
  value: T;
};

export type RoleCandidateRow<A, C> = Omit<RoleCandidateEntry<null>, "value"> & {
  autumn: A | null;
  crm: C | null;
};

/** Same profile identity for any LinkedIn host, scheme, case, trailing slash or query. */
export function linkedinIdentity(url: string | null | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url.trim()}`);
    const host = parsed.hostname.toLowerCase().replace(/^(?:[a-z]{2,3}\.|www\.)?linkedin\.com$/, "linkedin.com");
    const path = decodeURIComponent(parsed.pathname).replace(/\/+$/, "").toLowerCase();
    return path ? `${host}${path}` : null;
  } catch {
    return null;
  }
}

const emailIdentity = (email: string | null | undefined) => email?.trim().toLowerCase() || null;

const SCORE_LABELS = ["Match score", "Score"];
const RANK_LABELS = ["Updated rank", "Overall rank", "Rank"];
const TIER_LABELS = ["Match tier", "Grade"];

/** Picks Autumn's score, rank and tier from its report fields, preferring the newest labels. */
export function roleCandidateFit(
  fields: readonly { label: string; value: string | null }[] | undefined,
): RoleCandidateFit | null {
  const pick = (labels: string[]) => {
    for (const label of labels) {
      const field = fields?.find((item) => item.label === label && item.value?.trim());
      if (field) return { label: field.label, value: field.value!.trim() };
    }
    return null;
  };
  const fit = { score: pick(SCORE_LABELS), rank: pick(RANK_LABELS), tier: pick(TIER_LABELS) };
  return fit.score || fit.rank || fit.tier ? fit : null;
}

function scoreOf(fit: RoleCandidateFit | null | undefined) {
  const value = fit?.score ? Number.parseFloat(fit.score.value) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

/**
 * Autumn rows first (by score, highest first, when `sortByScore`; otherwise in the given order),
 * then CRM contacts that matched no Autumn row. A CRM contact joins an Autumn row by normalized
 * LinkedIn profile, then by lowercase email; the joined row keeps both records.
 */
export function mergeRoleCandidates<A, C>({
  autumn,
  crm,
  fit,
  sortByScore = true,
}: {
  autumn: readonly RoleCandidateEntry<A>[];
  crm: readonly RoleCandidateEntry<C>[];
  fit?: (value: A) => RoleCandidateFit | null;
  sortByScore?: boolean;
}): RoleCandidateRow<A, C>[] {
  const ordered = autumn.map((entry, index) => ({ entry, index, score: scoreOf(fit?.(entry.value)) }));
  if (sortByScore)
    ordered.sort((a, b) =>
      a.score === null || b.score === null
        ? Number(a.score === null) - Number(b.score === null) || a.index - b.index
        : b.score - a.score || a.index - b.index,
    );
  const rows: RoleCandidateRow<A, C>[] = ordered.map(({ entry: { value, ...fields } }) => ({
    ...fields,
    autumn: value,
    crm: null,
  }));
  const byLinkedin = new Map<string, RoleCandidateRow<A, C>>();
  const byEmail = new Map<string, RoleCandidateRow<A, C>>();
  for (const row of rows) {
    const linkedin = linkedinIdentity(row.linkedinUrl);
    const email = emailIdentity(row.email);
    if (linkedin && !byLinkedin.has(linkedin)) byLinkedin.set(linkedin, row);
    if (email && !byEmail.has(email)) byEmail.set(email, row);
  }
  const crmOnly: RoleCandidateRow<A, C>[] = [];
  for (const { value, ...fields } of crm) {
    const linkedin = linkedinIdentity(fields.linkedinUrl);
    const email = emailIdentity(fields.email);
    const match =
      (linkedin ? byLinkedin.get(linkedin) : undefined) ?? (email ? byEmail.get(email) : undefined);
    if (match && match.crm === null) {
      match.crm = value;
      match.name ??= fields.name;
      match.title ??= fields.title;
      match.location ??= fields.location;
      match.email ??= fields.email;
      match.linkedinUrl ??= fields.linkedinUrl;
      continue;
    }
    // A second CRM record for the same person stays visible rather than being dropped.
    crmOnly.push({ ...fields, autumn: null, crm: value });
  }
  return [...rows, ...crmOnly];
}
