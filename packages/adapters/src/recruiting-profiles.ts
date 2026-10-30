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
  listRecruitingRolePoolRuns,
  listRecruitingSavedProfiles,
  listRunToolResults,
  saveRecruitingSavedProfile,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { inlineProfilePhotos, linkedinPhotoUrl } from "./profile-photo.js";

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
): { provider: string; facts: Facts; photoUrl?: string } | null {
  const provider = providerFor(endpoint);
  if (!provider) {
    if (!isPeopleSearchEndpoint(endpoint)) return null;
    const row = peopleFromSearch(result, endpoint).find(
      (person) => linkedinPersonKey(person.linkedin_url) === personKey,
    );
    const facts = row && factsFromSearchRow(row);
    return facts ? { provider: "people_search", facts, photoUrl: row.profile_image_url } : null;
  }
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
  /** A short passage of the profile the search matched, so the pick can quote the work. */
  snippet?: string;
  /** Positions newest first, one per line: "Title | Company | | Start – End | Location". */
  experience?: string;
  /** Schools, one per line: "School | Degree | Start – End". */
  education?: string;
  /** The source photo link; the save replaces it with our own copy or drops it. */
  profile_image_url?: string;
};

type SearchJob = {
  title: string;
  company: string;
  current: boolean;
  start?: string;
  end?: string;
  location?: string;
};

const HISTORY_LIMIT = 30;

function historyLine(parts: Array<string | undefined>): string {
  return parts
    .map((part) => (part ?? "").replace(/[|\n]+/g, " ").trim())
    .join(" | ")
    .replace(/(?: \| )+$/, "");
}

function experienceText(jobs: readonly SearchJob[]): string | undefined {
  const lines = jobs
    .slice(0, HISTORY_LIMIT)
    .map((job) =>
      historyLine([
        job.title,
        job.company,
        "",
        job.start ? `${job.start} – ${job.end ?? (job.current ? "Present" : "")}`.trim() : "",
        job.location,
      ]),
    );
  return lines.length ? lines.join("\n") : undefined;
}

const SNIPPET_LENGTH = 300;

/** Plain profile prose: no headings, links or counters, cut to a short passage. */
function snippetOf(text: string): string | undefined {
  const prose = text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        line !== "---" &&
        !line.startsWith("#") &&
        !/^(Title|URL|Published|Author|Highlights):/.test(line) &&
        !/connections|followers/.test(line),
    )
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return prose ? prose.slice(0, SNIPPET_LENGTH) : undefined;
}

/**
 * People in a profile-data connector's search or fetch result, one per LinkedIn profile, in
 * result order. Only hosts this adapter knows count; anything without a name and LinkedIn is
 * left out, since a round needs both.
 */
export function peopleFromSearch(result: unknown, endpoint: string): PeopleSearchRow[] {
  if (!isPeopleSearchEndpoint(endpoint)) return [];
  const listing = LISTING_SEARCH_HOSTS.has(host(endpoint) ?? "");
  const people = new Map<string, PeopleSearchRow>();
  const found = listing
    ? objects(result).flatMap((record) =>
        typeof record.text !== "string"
          ? []
          : record.text.trimStart().startsWith("{")
            ? peopleFromResults(record.text)
            : peopleFromListing(record.text),
      )
    : objects(result);
  for (const record of found) {
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
    if (typeof record.snippet === "string") row.snippet = record.snippet;
    if (typeof record.experience === "string" && record.experience)
      row.experience = record.experience;
    if (typeof record.education === "string" && record.education) row.education = record.education;
    const photo = linkedinPhotoUrl(record.profile_image_url ?? record.image);
    if (photo) row.profile_image_url = photo;
    people.set(key, row);
  }
  return [...people.values()];
}

/** People-search hosts whose results are text listings rather than person records. */
const LISTING_SEARCH_HOSTS = new Set(["mcp.exa.ai"]);

function host(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The MCP hosts whose people results save_search understands. */
export function isPeopleSearchEndpoint(endpoint: string): boolean {
  return providerFor(endpoint) !== null || LISTING_SEARCH_HOSTS.has(host(endpoint) ?? "");
}

const LOCATION_LINE = /\([A-Z]{2}\)$/;
const MONTH_YEAR = String.raw`(?:[A-Z][a-z]{2,8}\.? )?\d{4}`;
/** "Jul 2011 - Present (15 years) in Hillsborough, NJ" */
const DATE_LINE = new RegExp(
  String.raw`^(${MONTH_YEAR})\s*[-–—]\s*(Present|${MONTH_YEAR})(?:\s*\([^)]*\))?(?:\s+in\s+(.+))?$`,
  "i",
);
const JOB_SECTIONS = new Set(["", "about", "experience"]);
const SCHOOL_NAME = /universit|college|school|institut|academ|polytechn|大学|学院/i;

function unlink(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
}

/**
 * People in a web-search listing ("Title: <name>\nURL: <linkedin>\n…Highlights" entries),
 * reading headline, location and the current job from the profile text when present.
 */
function peopleFromListing(text: string): Record_[] {
  const found: Record_[] = [];
  for (const entry of text.split(/^(?=Title: )/m)) {
    const name = entry.match(/^Title: (.+)$/m)?.[1]?.trim();
    const url = entry.match(/^URL: (\S+)$/m)?.[1];
    if (!name || !url) continue;
    const lines = (entry.split(/^# .+$/m)[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const [first, second] = lines;
    const headline = first && !first.startsWith("#") && !LOCATION_LINE.test(first) ? first : null;
    const location = [first, second].find((line) => line && LOCATION_LINE.test(line));
    // Jobs read "### Title - [Company](…) (Current)" (the company is not always a link) or, for
    // several roles at one company, "### [Company](…)" followed by "#### Title (Current)". A
    // job's first line after its heading may give "Jul 2011 - Present (…) in <location>".
    const jobs: SearchJob[] = [];
    const schools: string[] = [];
    let section = "";
    let company: string | null = null;
    let last: SearchJob | null = null;
    let school: { name: string; degree?: string } | null = null;
    const flushSchool = (dates?: string) => {
      if (school) schools.push(historyLine([school.name, school.degree, dates]));
      school = null;
    };
    for (const raw of entry.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("## ")) {
        flushSchool();
        section = line.slice(3).trim().toLowerCase();
        company = null;
        last = null;
        continue;
      }
      if (section === "education") {
        const heading = line.match(/^###+ (.+)$/);
        if (heading) {
          flushSchool();
          const [first, second] = unlink(heading[1]!).split(/\s+-\s+/, 2);
          school = second ? { name: second, degree: first } : { name: first! };
          if (second && !SCHOOL_NAME.test(second) && SCHOOL_NAME.test(first!))
            school = { name: first!, degree: second };
        } else if (school) {
          const dates = line.match(DATE_LINE);
          flushSchool(dates ? `${dates[1]} – ${dates[2]}` : undefined);
        }
        continue;
      }
      // Jobs sit under Experience, or under About when the listing cut the heading out.
      if (!JOB_SECTIONS.has(section)) continue;
      const single = line.match(/^### (.+?) - (?:\[([^\]]+)\]\([^)]*\)|(.+?))( \(Current\))?$/);
      const group = line.match(/^### (?:\[([^\]]+)\]\([^)]*\)|([^[\]]+?))$/);
      const role = line.match(/^#### (.+?)( \(Current\))?$/);
      const dates = last && !last.start ? line.match(DATE_LINE) : null;
      if (single) {
        company = null;
        last = {
          title: single[1]!,
          company: (single[2] ?? single[3])!.trim(),
          current: Boolean(single[4]),
        };
        jobs.push(last);
      } else if (group) {
        company = (group[1] ?? group[2])!.trim();
        last = null;
      } else if (role && company) {
        last = { title: role[1]!, company, current: Boolean(role[2]) };
        jobs.push(last);
      } else if (dates && last) {
        last.start = dates[1]!;
        last.end = dates[2]!;
        if (/^present$/i.test(dates[2]!)) last.current = true;
        if (dates[3]) last.location = dates[3].trim();
        last = null;
      } else last = null;
    }
    flushSchool();
    const job = jobs.find((item) => item.current) ?? jobs[0];
    found.push({
      full_name: name,
      linkedin_url: url,
      job_title: job?.title ?? headline,
      company_name: job?.company ?? null,
      location: location?.replace(/\s*\([A-Z]{2}\)$/, "") ?? null,
      snippet: snippetOf(entry.split(/^# .+$/m)[1] ?? ""),
      experience: experienceText(jobs),
      education: schools.length ? schools.slice(0, HISTORY_LIMIT).join("\n") : undefined,
    });
  }
  return found;
}

/** People in a JSON search response ({results:[{url, entities:[{properties}]}]}). */
/**
 * People in a finished agent run's structured output: every listed person with a name and a
 * profile link, the run's evidence kept as the passage shown with them.
 */
function peopleFromAgentRun(parsed: unknown): Record_[] {
  const structured = (parsed as { output?: { structured?: unknown } } | null)?.output?.structured;
  if (!structured || typeof structured !== "object") return [];
  return Object.values(structured as Record_).flatMap((list) =>
    Array.isArray(list)
      ? list.flatMap((item: Record_) =>
          item && typeof item === "object" && typeof item.name === "string"
            ? [
                {
                  full_name: item.name,
                  linkedin_url: item.linkedin_url,
                  job_title: typeof item.current_role === "string" ? item.current_role : null,
                  location: typeof item.location === "string" ? item.location : null,
                  snippet: typeof item.evidence === "string" ? snippetOf(item.evidence) : undefined,
                },
              ]
            : [],
        )
      : [],
  );
}

function peopleFromResults(body: string): Record_[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return peopleFromAgentRun(parsed);
  return results.flatMap((item: Record_) => {
    const entity = Array.isArray(item?.entities) ? (item.entities[0] as Record_) : undefined;
    const person = (entity?.properties ?? {}) as {
      name?: unknown;
      location?: unknown;
      workHistory?: Array<{
        title?: unknown;
        company?: { name?: unknown };
        location?: unknown;
        dates?: { from?: unknown; to?: unknown };
      }>;
      educationHistory?: Array<{
        degree?: unknown;
        institution?: { name?: unknown };
        dates?: { from?: unknown; to?: unknown };
      }>;
    };
    const jobs = Array.isArray(person.workHistory) ? person.workHistory : [];
    const job = jobs.find((entry) => !entry?.dates?.to) ?? jobs[0];
    const name = typeof person.name === "string" ? person.name : item?.title;
    if (typeof name !== "string" || typeof item?.url !== "string") return [];
    const highlights = Array.isArray(item.highlights)
      ? item.highlights.filter((part): part is string => typeof part === "string").join(" … ")
      : typeof item.text === "string"
        ? item.text
        : "";
    return [
      {
        full_name: name,
        linkedin_url: item.url,
        image: item.image,
        job_title: typeof job?.title === "string" ? job.title : null,
        company_name: typeof job?.company?.name === "string" ? job.company.name : null,
        location: typeof person.location === "string" ? person.location : null,
        snippet: snippetOf(highlights),
        experience: experienceText(
          jobs.flatMap((entry): SearchJob[] =>
            typeof entry?.title === "string" || typeof entry?.company?.name === "string"
              ? [
                  {
                    title: text(entry.title) ?? "",
                    company: text(entry.company?.name) ?? "",
                    current: !entry.dates?.to,
                    start: monthText(entry.dates?.from),
                    end: monthText(entry.dates?.to),
                    location: text(entry.location) ?? undefined,
                  },
                ]
              : [],
          ),
        ),
        education:
          (Array.isArray(person.educationHistory) ? person.educationHistory : [])
            .filter((entry) => typeof entry?.institution?.name === "string")
            .slice(0, HISTORY_LIMIT)
            .map((entry) => {
              const from = monthText(entry.dates?.from);
              const to = monthText(entry.dates?.to);
              return historyLine([
                text(entry.institution?.name) ?? "",
                text(entry.degree) ?? "",
                from || to ? [from, to].filter(Boolean).join(" – ") : "",
              ]);
            })
            .join("\n") || undefined,
      },
    ];
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2020-01-01" reads "Jan 2020"; other text stays as given. */
function monthText(value: unknown): string | undefined {
  const date = text(value);
  if (!date) return undefined;
  const iso = date.match(/^(\d{4})-(\d{2})/);
  const month = iso ? MONTHS[Number(iso[2]) - 1] : undefined;
  return iso ? (month ? `${month} ${iso[1]}` : iso[1]) : date;
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

/** Saved profiles are the lookup cache; save stores only lookups this run already made. */
export async function executeRecruitingProfilesTool(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
  input: RecruitingProfilesToolInput,
  fetchPhoto?: Parameters<typeof inlineProfilePhotos>[1],
) {
  if (input.operation === "list") {
    const saved = await listRecruitingSavedProfiles(prisma, actor, input.candidateKeys);
    const items = input.candidateKeys.map((candidateKey) => {
      const profile = saved.get(candidateKey);
      return profile ? { ...summary(profile), saved: true } : { candidateKey, saved: false };
    });
    return { items };
  }
  const keys = input.operation === "save" ? [input.candidateKey] : input.candidateKeys;
  // One person without a profile link must not lose everyone else's save.
  if (input.operation === "save" && !input.candidateKey.startsWith("linkedin:"))
    throw new RecruitingProfileError(
      "This person has no LinkedIn profile on record, so there is nothing to look up.",
    );
  const calls = await listRunToolResults(prisma, actor, runId, 200);
  const items = [];
  for (const candidateKey of keys) {
    if (!candidateKey.startsWith("linkedin:")) {
      items.push({ candidateKey, saved: false, reason: "no LinkedIn profile on record" });
      continue;
    }
    const match = calls
      .map((call) => ({ call, found: profileFromLookup(call.result, call.endpoint, candidateKey) }))
      .find((entry) => entry.found);
    if (!match?.found) {
      items.push({ candidateKey, saved: false });
      continue;
    }
    const { call, found } = match;
    const photo = { profile_image_url: found.photoUrl };
    if (photo.profile_image_url) await inlineProfilePhotos([photo], fetchPhoto);
    try {
      const profile = await saveRecruitingSavedProfile(prisma, actor, runId, {
        personKey: candidateKey,
        provider: found.provider,
        sourceEffectId: call.effectId,
        fetchedAt: call.createdAt,
        profile: {
          ...found.facts,
          profileImageUrl: photo.profile_image_url ?? found.facts.profileImageUrl,
        },
      });
      items.push({ saved: true, ...summary(profile) });
    } catch (error) {
      getLogger().warn("recruiting.profiles.save.skipped", { error: String(error) });
      items.push({ candidateKey, saved: false });
    }
  }
  if (input.operation === "save") {
    if (items[0]?.saved) return items[0];
    throw new RecruitingProfileError(
      "No profile lookup for this person in this run. Look the person up first with the people search, using their LinkedIn URL as the query, then save.",
    );
  }
  return { items };
}

/** "Start – End" of a saved history line; "Present" is an open end. */
function span(dates: string | undefined) {
  const [start, end] = (dates ?? "").split(" – ").map((part) => part.trim() || null);
  const current = end === "Present";
  return { start: start ?? null, end: current ? null : (end ?? null), current };
}

/** A people-search row's history lines as saved-profile facts, or null when it has none. */
export function factsFromSearchRow(row: PeopleSearchRow): Facts | null {
  const parts = (line: string) => line.split(" | ").map((part) => part.trim() || null);
  const experience = (row.experience ?? "").split("\n").flatMap((line) => {
    const [title = null, company = null, url = null, dates, location = null] = parts(line);
    if (!title && !company) return [];
    const { start, end, current } = span(dates ?? undefined);
    return [
      {
        title,
        company_name: company,
        company_url: url,
        company_linkedin_url: null,
        company_logo_url: null,
        company_industry: null,
        company_size: null,
        location,
        start_date: start,
        end_date: end,
        is_current: current ? true : end ? false : null,
        description: null,
      },
    ];
  });
  const education = (row.education ?? "").split("\n").flatMap((line) => {
    const [school = null, degree = null, dates] = parts(line);
    if (!school) return [];
    const { start, end } = span(dates ?? undefined);
    return [
      {
        school_name: school,
        degree,
        field_of_study: null,
        school_url: null,
        school_logo_url: null,
        start_date: start,
        end_date: end,
      },
    ];
  });
  const photo = row.profile_image_url?.startsWith("data:image/") ? row.profile_image_url : null;
  if (!experience.length && !education.length && !photo) return null;
  return { headline: null, profileImageUrl: photo, experience, education };
}

/**
 * Fill the saved profiles of a role's people from the people searches already saved for it, at
 * no lookup cost: their history and photo were in those results but older saves dropped them.
 * People who already have a saved work history keep it.
 */
export async function fillRecruitingRoleProfiles(
  prisma: PrismaClient,
  actor: Actor,
  roleId: string,
  fetchPhoto?: Parameters<typeof inlineProfilePhotos>[1],
) {
  const { personKeys, runIds } = await listRecruitingRolePoolRuns(prisma, actor, roleId);
  const saved = await listRecruitingSavedProfiles(prisma, actor, personKeys);
  const missing = new Set(personKeys.filter((key) => !saved.get(key)?.experience.length));
  const before = missing.size;
  let photos = 0;
  for (const runId of runIds) {
    if (!missing.size) break;
    // Oldest call first, so each person keeps the history the role first found them with.
    for (const call of (await listRunToolResults(prisma, actor, runId, 400)).reverse()) {
      const found = peopleFromSearch(call.result, call.endpoint).filter((row) => {
        const key = linkedinPersonKey(row.linkedin_url);
        return (
          key && missing.has(key) && (row.experience || row.education || row.profile_image_url)
        );
      });
      if (!found.length) continue;
      await inlineProfilePhotos(found, fetchPhoto);
      for (const row of found) {
        const key = linkedinPersonKey(row.linkedin_url)!;
        const facts = factsFromSearchRow(row);
        if (!facts || !missing.has(key)) continue;
        try {
          await saveRecruitingSavedProfile(prisma, actor, runId, {
            personKey: key,
            provider: "people_search",
            sourceEffectId: call.effectId,
            fetchedAt: call.createdAt,
            profile: facts,
          });
        } catch (error) {
          // One unusable record never stops the rest of the role.
          getLogger().warn("recruiting.profiles.fill.skipped", { error: String(error) });
          continue;
        }
        if (facts.profileImageUrl) photos += 1;
        missing.delete(key);
      }
    }
  }
  return {
    people: personKeys.length,
    filled: before - missing.size,
    photos,
    missing: missing.size,
  };
}
