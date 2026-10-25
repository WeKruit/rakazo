import type {
  Actor,
  RecruitingProfileEducation,
  RecruitingProfileExperience,
  RecruitingProfilesToolInput,
  RecruitingSavedProfile,
} from "@rakazo/contracts";
import { recruitingCalibrationIdentity } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  listRecruitingSavedProfiles,
  listRunToolResults,
  saveRecruitingSavedProfile,
} from "@rakazo/db";

type Facts = Omit<RecruitingSavedProfile, "personKey" | "provider" | "fetchedAt">;
type Record_ = Record<string, unknown>;

export class RecruitingProfileError extends Error {}

const isRecord = (value: unknown): value is Record_ =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Profile-data connectors whose person records this adapter understands, by MCP host. */
const PROVIDERS: Record<string, { name: string; normalize: (record: Record_) => Facts | null }> = {
  "mcp.coresignal.com": { name: "coresignal", normalize: coresignalProfile },
};

function providerFor(endpoint: string) {
  try {
    return PROVIDERS[new URL(endpoint).hostname.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

function text(value: unknown, max = 4000): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** A supplied web link as an https/http URL without credentials; a bare domain gets https. */
function link(value: unknown): string | null {
  const raw = text(value);
  if (!raw || /\s/.test(raw)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** The pool's key for a LinkedIn profile link, accepting country hosts and a missing scheme. */
export function linkedinPersonKey(value: unknown): string | null {
  const href = link(value);
  if (!href) return null;
  const url = new URL(href);
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  const identity = recruitingCalibrationIdentity(
    `https://www.linkedin.com${url.pathname.replace(/\/+$/, "")}`,
  );
  return identity ? `linkedin:${identity}` : null;
}

function first(record: Record_, keys: readonly string[]) {
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value;
  }
  return null;
}

/** "YYYY-MM" from year/month parts, or the provider's own date text. */
function date(record: Record_, prefix: "date_from" | "date_to") {
  const year = Number(record[`${prefix}_year`]);
  const month = Number(record[`${prefix}_month`]);
  if (Number.isInteger(year) && year > 1900) {
    return Number.isInteger(month) && month >= 1 && month <= 12
      ? `${year}-${String(month).padStart(2, "0")}`
      : String(year);
  }
  return text(record[prefix], 40);
}

function coresignalProfile(record: Record_): Facts | null {
  const jobs = Array.isArray(record.experience) ? record.experience.filter(isRecord) : [];
  const schools = Array.isArray(record.education) ? record.education.filter(isRecord) : [];
  const experience = jobs.slice(0, 80).map((job): RecruitingProfileExperience => {
    const end = date(job, "date_to");
    const active = job.active_experience;
    return {
      title: first(job, ["position_title", "title"]),
      company_name: first(job, ["company_name"]),
      company_url: link(job.company_website),
      company_linkedin_url: link(job.company_linkedin_url ?? job.company_url),
      company_logo_url: link(job.company_logo_url),
      company_industry: first(job, ["company_industry"]),
      company_size: first(job, ["company_size_range", "company_employees_count"]),
      location: first(job, ["location", "company_location"]),
      start_date: date(job, "date_from"),
      end_date: end,
      is_current: active === true || active === 1 ? true : end ? false : null,
      description: first(job, ["description"]),
    };
  });
  const education = schools.slice(0, 40).map(
    (school): RecruitingProfileEducation => ({
      school_name: first(school, ["institution_name", "title"]),
      degree: first(school, ["degree"]),
      field_of_study: first(school, ["field_of_study", "major"]),
      school_url: link(school.institution_website),
      school_logo_url: link(school.institution_logo_url),
      start_date: date(school, "date_from"),
      end_date: date(school, "date_to"),
    }),
  );
  const profileImageUrl = link(record.picture_url ?? record.profile_picture_url);
  const headline = first(record, ["headline", "generated_headline"]);
  if (!experience.length && !education.length && !profileImageUrl && !headline) return null;
  return {
    headline,
    profileImageUrl,
    experience: experience.filter((job) => job.title || job.company_name),
    education: education.filter((school) => school.school_name || school.degree),
  };
}

/** Person-shaped objects in an MCP result: structured content, JSON text blocks or nested data. */
function records(value: unknown, depth = 0, found: Record_[] = []): Record_[] {
  if (depth > 6 || found.length > 200) return found;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        records(JSON.parse(trimmed), depth + 1, found);
      } catch {
        // Not JSON; ignore.
      }
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) records(item, depth + 1, found);
    return found;
  }
  if (!isRecord(value)) return found;
  if (Array.isArray(value.experience) || "picture_url" in value) found.push(value);
  for (const nested of Object.values(value)) records(nested, depth + 1, found);
  return found;
}

const PROFILE_LINK_KEYS = ["linkedin_url", "professional_network_url", "linkedin_profile_url"];

/** The one profile in a connector result that belongs to this person, or null. */
export function profileFromLookup(
  result: unknown,
  endpoint: string,
  personKey: string,
): { provider: string; facts: Facts } | null {
  const provider = providerFor(endpoint);
  if (!provider) return null;
  for (const record of records(result)) {
    if (!PROFILE_LINK_KEYS.some((key) => linkedinPersonKey(record[key]) === personKey)) continue;
    const facts = provider.normalize(record);
    if (facts) return { provider: provider.name, facts };
  }
  return null;
}

const PEOPLE_NAME_KEYS = ["full_name", "name", "person_name"];
const PEOPLE_TITLE_KEYS = [
  "active_experience_title",
  "job_title",
  "current_title",
  "title",
  "position_title",
  "headline",
];
const PEOPLE_COMPANY_KEYS = [
  "active_experience_company_name",
  "company_name",
  "current_company",
  "company",
];
const PEOPLE_LOCATION_KEYS = ["location_full", "location", "location_raw_address", "region"];
const PEOPLE_LINK_KEYS = [...PROFILE_LINK_KEYS, "profile_url", "url", "websites_linkedin"];

/** Rows of a markdown table in connector text, keyed by normalized header. */
function markdownRows(text: string): Record_[] {
  const lines = text.split("\n").map((line) => line.trim());
  const rows: Record_[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i]!.startsWith("|") || !/^\|[\s:|-]+\|$/.test(lines[i + 1]!)) continue;
    const cells = (line: string) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim());
    const header = cells(lines[i]!).map((cell) => cell.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
    for (let j = i + 2; j < lines.length && lines[j]!.startsWith("|"); j++) {
      const values = cells(lines[j]!);
      rows.push(Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""])));
      i = j;
    }
  }
  return rows;
}

/** Every object in a connector result, including JSON and markdown tables inside text blocks. */
function objects(value: unknown, depth = 0, found: Record_[] = []): Record_[] {
  if (depth > 8 || found.length > 2000) return found;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return objects(JSON.parse(trimmed), depth + 1, found);
      } catch {
        // Not JSON; fall through to tables.
      }
    }
    for (const row of markdownRows(trimmed)) found.push(row);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) objects(item, depth + 1, found);
    return found;
  }
  if (!isRecord(value)) return found;
  found.push(value);
  for (const nested of Object.values(value)) objects(nested, depth + 1, found);
  return found;
}

export type PeopleSearchRow = {
  name: string;
  linkedin_url: string;
  current_title?: string;
  current_company?: string;
  location?: string;
};

/**
 * People in a profile-data connector's search or fetch result, one per LinkedIn profile, in
 * result order. Only hosts this adapter knows count; anything without a name and LinkedIn is
 * left out, since a round needs both.
 */
export function peopleFromSearch(result: unknown, endpoint: string): PeopleSearchRow[] {
  if (!providerFor(endpoint)) return [];
  const people = new Map<string, PeopleSearchRow>();
  for (const record of objects(result)) {
    const name = first(record, PEOPLE_NAME_KEYS);
    const href = PEOPLE_LINK_KEYS.map((key) => link(record[key])).find(
      (value) => value && linkedinPersonKey(value),
    );
    const key = href ? linkedinPersonKey(href) : null;
    if (!name || !href || !key || people.has(key) || name.length > 120) continue;
    // Country hosts and tracking parameters collapse to the pool's canonical profile link.
    const row: PeopleSearchRow = {
      name,
      linkedin_url: `https://www.linkedin.com${key.slice("linkedin:".length)}`,
    };
    const title = first(record, PEOPLE_TITLE_KEYS);
    const company = first(record, PEOPLE_COMPANY_KEYS);
    const location = first(record, PEOPLE_LOCATION_KEYS);
    if (title) row.current_title = title.slice(0, 300);
    if (company) row.current_company = company.slice(0, 200);
    if (location) row.location = location.slice(0, 200);
    people.set(key, row);
  }
  return [...people.values()];
}

/** The MCP hosts whose people results save_search understands. */
export function isPeopleSearchEndpoint(endpoint: string): boolean {
  return providerFor(endpoint) !== null;
}

function summary(profile: RecruitingSavedProfile) {
  return {
    candidateKey: profile.personKey,
    fetchedAt: profile.fetchedAt,
    positions: profile.experience.length,
    datedPositions: profile.experience.filter((job) => job.start_date).length,
    degrees: profile.education.length,
    photo: profile.profileImageUrl !== null,
  };
}

/** Saved profiles are the lookup cache; save stores only a lookup this run already made. */
export async function executeRecruitingProfilesTool(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
  input: RecruitingProfilesToolInput,
) {
  if (input.operation === "list") {
    const saved = await listRecruitingSavedProfiles(prisma, actor, input.candidateKeys);
    const items = input.candidateKeys.map((candidateKey) => {
      const profile = saved.get(candidateKey);
      return profile ? { ...summary(profile), saved: true } : { candidateKey, saved: false };
    });
    return { items };
  }
  if (!input.candidateKey.startsWith("linkedin:"))
    throw new RecruitingProfileError(
      "This person has no LinkedIn profile on record, so there is nothing to look up.",
    );
  for (const call of await listRunToolResults(prisma, actor, runId)) {
    const found = profileFromLookup(call.result, call.endpoint, input.candidateKey);
    if (!found) continue;
    const profile = await saveRecruitingSavedProfile(prisma, actor, runId, {
      personKey: input.candidateKey,
      provider: found.provider,
      sourceEffectId: call.effectId,
      fetchedAt: call.createdAt,
      profile: found.facts,
    });
    return { saved: true, ...summary(profile) };
  }
  throw new RecruitingProfileError(
    "No profile lookup for this person in this run. Fetch the person's full record by their LinkedIn URL with the connected profile-data connector first, then save.",
  );
}
