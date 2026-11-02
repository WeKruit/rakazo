import type {
  Actor,
  RecruitingProfileEducation,
  RecruitingProfileExperience,
  RecruitingProfilesToolInput,
  RecruitingSavedProfile,
} from "@rakazo/contracts";
import { RecruitingSavedProfileSchema } from "@rakazo/contracts";
import { recruitingCalibrationIdentity } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  listRecruitingRolePoolRuns,
  listRecruitingSavedProfiles,
  listRunToolResults,
  saveRecruitingSavedProfile,
  saveRecruitingSavedProfiles,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { inlineProfilePhotos, linkedinPhotoUrl } from "./profile-photo.js";

/** Calls read per page when looking for a person's lookup, and how far back a save looks. */
const LOOKUP_PAGE = 20;
const LOOKUP_CALLS_MAX = 200;

type Facts = Omit<RecruitingSavedProfile, "personKey" | "provider" | "fetchedAt">;
type Record_ = Record<string, unknown>;
const factsSchema = RecruitingSavedProfileSchema.omit({
  personKey: true,
  provider: true,
  fetchedAt: true,
});

function contactFacts(record: Record_) {
  const emailValue = first(record, [
    "email",
    "email_address",
    "work_email",
    "professional_email",
    "personal_email",
  ]);
  const addresses = [
    emailValue,
    ...(Array.isArray(record.emails)
      ? record.emails.map((value) =>
          isRecord(value) ? first(value, ["address", "email"]) : text(value),
        )
      : []),
  ];
  const email = addresses
    .map((value) => RecruitingSavedProfileSchema.shape.email.safeParse(value))
    .find((value) => value.success && value.data);
  const social = (keys: string[], host?: RegExp) => {
    const value = link(first(record, keys));
    return value && (!host || host.test(new URL(value).hostname)) ? value : null;
  };
  return {
    email: email?.success ? (email.data ?? null) : null,
    githubUrl: social(["github_url", "githubUrl", "github"], /(^|\.)github\.com$/i),
    websiteUrl: social([
      "website_url",
      "websiteUrl",
      "personal_website",
      "website",
      "portfolio_url",
    ]),
    stackOverflowUrl: social(
      ["stackoverflow_url", "stack_overflow_url", "stackOverflowUrl"],
      /(^|\.)stackoverflow\.com$/i,
    ),
  };
}

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
  if (isRecord(value) && Object.hasOwn(value, "value")) value = value.value;
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
      company_url: link(job.company_website ?? job.company_url),
      company_linkedin_url: link(job.company_linkedin_url ?? job.company_url),
      company_logo_url: link(job.company_logo_url ?? job.companyLogoUrl),
      company_industry: first(job, ["company_industry"]),
      company_size: first(job, ["company_size_range", "company_employees_count"]),
      location: first(job, ["location", "company_location"]),
      start_date: date(job, "date_from") ?? text(job.start_date, 40),
      end_date: end ?? text(job.end_date, 40),
      is_current:
        typeof job.is_current === "boolean"
          ? job.is_current
          : active === true || active === 1
            ? true
            : end
              ? false
              : null,
      description: first(job, ["description"]),
    };
  });
  const education = schools.slice(0, 40).map(
    (school): RecruitingProfileEducation => ({
      school_name: first(school, ["institution_name", "school_name", "title"]),
      degree: first(school, ["degree"]),
      field_of_study: first(school, ["field_of_study", "major"]),
      school_url: link(school.institution_website ?? school.school_url),
      school_logo_url: link(school.institution_logo_url ?? school.school_logo_url),
      start_date: date(school, "date_from") ?? text(school.start_date, 40),
      end_date: date(school, "date_to") ?? text(school.end_date, 40),
    }),
  );
  const profileImageUrl = link(
    record.picture_url ?? record.profile_picture_url ?? record.profile_image_url ?? record.image,
  );
  const headline = first(record, ["headline", "generated_headline"]);
  if (!experience.length && !education.length && !profileImageUrl && !headline) return null;
  return {
    headline,
    profileImageUrl,
    ...contactFacts(record),
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
  if (Array.isArray(value.experience) || "picture_url" in value || "profile_picture_url" in value)
    found.push(value);
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
  email?: string | null;
  github_url?: string | null;
  website_url?: string | null;
  stackoverflow_url?: string | null;
  /** Exact normalized facts stay in the immutable receipt without becoming report findings. */
  _profile?: Facts;
  _profile_image_source_url?: string | null;
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
    const retained =
      providerFor(endpoint)?.normalize(record) ??
      factsSchema.safeParse(record._profile).data ??
      coresignalProfile(record);
    const contacts = contactFacts(record);
    row.email = retained?.email ?? contacts.email;
    row.github_url = retained?.githubUrl ?? contacts.githubUrl;
    row.website_url = retained?.websiteUrl ?? contacts.websiteUrl;
    row.stackoverflow_url = retained?.stackOverflowUrl ?? contacts.stackOverflowUrl;
    if (retained) row._profile = retained;
    const photo = linkedinPhotoUrl(
      record.profile_image_url ??
        record.profile_picture_url ??
        record.picture_url ??
        record.image ??
        retained?.profileImageUrl,
    );
    row._profile_image_source_url = photo ?? null;
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
          item && typeof item === "object" && text(item.name)
            ? [
                {
                  ...item,
                  full_name: text(item.name),
                  linkedin_url: text(item.linkedin_url),
                  job_title: text(item.current_role ?? item.current_title),
                  company_name:
                    typeof item.current_company === "string" ? item.current_company : null,
                  location: typeof item.location === "string" ? item.location : null,
                  snippet: typeof item.evidence === "string" ? snippetOf(item.evidence) : undefined,
                  ...(Array.isArray(item.education) && item.education.some(isRecord)
                    ? {}
                    : { education: educationText(item.education) }),
                },
              ]
            : [],
        )
      : [],
  );
}

/** An agent run's education list ("School | Degree | Start – End" each) as saved lines. */
function educationText(value: unknown): string | undefined {
  const lines = (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    typeof entry === "string" && entry.trim()
      ? [historyLine(entry.split("|").map((part) => part.trim()))]
      : [],
  );
  return lines.length ? lines.slice(0, HISTORY_LIMIT).join("\n") : undefined;
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
        company?: {
          name?: unknown;
          website?: unknown;
          url?: unknown;
          linkedin_url?: unknown;
          logo_url?: unknown;
          logoUrl?: unknown;
        };
        company_logo_url?: unknown;
        location?: unknown;
        dates?: { from?: unknown; to?: unknown };
      }>;
      educationHistory?: Array<{
        degree?: unknown;
        institution?: {
          name?: unknown;
          website?: unknown;
          url?: unknown;
          logo_url?: unknown;
          logoUrl?: unknown;
        };
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
    const fullProfile = coresignalProfile({
      ...person,
      ...contactFacts({ ...item, ...person }),
      picture_url: item.image ?? (person as Record_).profile_image_url,
      experience: jobs.map((entry) => ({
        position_title: entry.title,
        company_name: entry.company?.name,
        company_website: entry.company?.website ?? entry.company?.url,
        company_linkedin_url: entry.company?.linkedin_url,
        company_logo_url:
          entry.company_logo_url ?? entry.company?.logo_url ?? entry.company?.logoUrl,
        location: entry.location,
        date_from: monthText(entry.dates?.from),
        date_to: monthText(entry.dates?.to),
        active_experience: !entry.dates?.to,
      })),
      education: (Array.isArray(person.educationHistory) ? person.educationHistory : []).map(
        (entry) => ({
          institution_name: entry.institution?.name,
          degree: entry.degree,
          institution_website: entry.institution?.website ?? entry.institution?.url,
          institution_logo_url: entry.institution?.logo_url ?? entry.institution?.logoUrl,
          date_from: monthText(entry.dates?.from),
          date_to: monthText(entry.dates?.to),
        }),
      ),
    });
    return [
      {
        ...contactFacts({ ...item, ...person }),
        ...(fullProfile ? { _profile: fullProfile } : {}),
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
  // A search result can be large, so the run's calls are read a page at a time, newest first,
  // and only as far back as the people being saved need.
  const calls: Awaited<ReturnType<typeof listRunToolResults>> = [];
  let readAll = false;
  const findLookup = async (candidateKey: string) => {
    for (let index = 0; ; index += 1) {
      if (index === calls.length) {
        if (readAll || calls.length >= LOOKUP_CALLS_MAX) return undefined;
        const page = await listRunToolResults(prisma, actor, runId, LOOKUP_PAGE, calls.length);
        calls.push(...page);
        readAll = page.length < LOOKUP_PAGE;
        if (index === calls.length) return undefined;
      }
      const call = calls[index]!;
      const found = profileFromLookup(call.result, call.endpoint, candidateKey);
      if (found) return { call, found };
    }
  };
  const items = [];
  for (const candidateKey of keys) {
    if (!candidateKey.startsWith("linkedin:")) {
      items.push({ candidateKey, saved: false, reason: "no LinkedIn profile on record" });
      continue;
    }
    const match = await findLookup(candidateKey);
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
  const retained = row._profile;
  const suppliedPhoto = row.profile_image_url ?? retained?.profileImageUrl;
  const photo = suppliedPhoto?.startsWith("data:image/") ? suppliedPhoto : link(suppliedPhoto);
  const contacts = {
    email: row.email ?? retained?.email ?? null,
    githubUrl: row.github_url ?? retained?.githubUrl ?? null,
    websiteUrl: row.website_url ?? retained?.websiteUrl ?? null,
    stackOverflowUrl: row.stackoverflow_url ?? retained?.stackOverflowUrl ?? null,
  };
  if (
    !experience.length &&
    !education.length &&
    !photo &&
    !retained &&
    !Object.values(contacts).some(Boolean)
  )
    return null;
  return {
    headline: retained?.headline ?? null,
    profileImageUrl: photo,
    experience: retained?.experience.length ? retained.experience : experience,
    education: retained?.education.length ? retained.education : education,
    ...contacts,
  };
}

/** The existing native save lane retains canonical supplied facts before a later grading row. */
export function prepareRecruitingProfileRows(rows: readonly unknown[]) {
  const prepared = rows.map((value) => (isRecord(value) ? { ...value } : value));
  const people = prepared.flatMap((value) => {
    if (!isRecord(value)) return [];
    const retained = factsSchema.safeParse(value._profile).data ?? coresignalProfile(value);
    const contacts = contactFacts(value);
    const source = text(
      value.profile_image_url ??
        value.picture_url ??
        value.profile_picture_url ??
        value.image ??
        retained?.profileImageUrl,
    );
    const row: PeopleSearchRow = {
      name: text(value.name) ?? "",
      linkedin_url: text(value.linkedin_url ?? value.profile_url) ?? "",
      experience: typeof value.experience === "string" ? value.experience : undefined,
      education: typeof value.education === "string" ? value.education : undefined,
      ...{
        email: retained?.email ?? contacts.email,
        github_url: retained?.githubUrl ?? contacts.githubUrl,
        website_url: retained?.websiteUrl ?? contacts.websiteUrl,
        stackoverflow_url: retained?.stackOverflowUrl ?? contacts.stackOverflowUrl,
      },
      ...(retained ? { _profile: retained } : {}),
      profile_image_url: source?.match(/^data:image\/(?:png|jpeg|webp);base64,/)
        ? source
        : source
          ? (link(source) ?? undefined)
          : undefined,
    };
    return [{ value, row, source }];
  });
  for (const { value, row, source } of people) {
    value._profile_image_source_url = source;
    value._profile = factsFromSearchRow(row) ?? {
      headline: null,
      profileImageUrl: null,
      experience: [],
      education: [],
      email: null,
      githubUrl: null,
      websiteUrl: null,
      stackOverflowUrl: null,
    };
  }
  return prepared;
}

/** A saved profile is complete once it has both a work history and an education history. */
const complete = (profile: RecruitingSavedProfile | undefined) =>
  Boolean(profile?.experience.length && profile.education.length);

/** Durable, post-save projection only: candidate response paths never invoke this worker. */
export async function projectRecruitingCandidateProfiles(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "notify"> },
  payload: { pageEffectId: string },
  fetchPhoto?: Parameters<typeof inlineProfilePhotos>[1],
) {
  const { prisma } = deps;
  const page = await prisma.recruitingCandidatePage.findUnique({
    where: { effectId: payload.pageEffectId },
    include: {
      role: true,
      artifact: true,
      occurrences: { select: { candidateKey: true, rowIndex: true } },
      effect: { include: { run: { include: { bot: true, thread: true } } } },
    },
  });
  if (!page) return;
  const run = page.effect.run;
  const userId = run.userId,
    spaceId = run.spaceId;
  if (
    page.role.sourceThreadId !== run.threadId ||
    page.role.userId !== userId ||
    page.role.spaceId !== spaceId ||
    page.effect.spaceId !== spaceId ||
    run.bot.userId !== userId ||
    run.bot.spaceId !== spaceId ||
    run.thread.userId !== userId ||
    run.thread.spaceId !== spaceId ||
    page.artifact.userId !== userId ||
    page.artifact.spaceId !== spaceId ||
    page.artifact.hash !== page.artifactHash ||
    page.artifact.runId !== run.id ||
    page.artifact.botId !== run.botId
  )
    return;
  const receipts = await prisma.externalEffect.findMany({
    where: {
      spaceId,
      runId: run.id,
      kind: "recruiting_research",
      status: "completed",
      AND: [
        { result: { path: ["profileFactsVersion"], equals: 1 } },
        { result: { path: ["sourceEffectId"], equals: page.effectId } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  const receipt = receipts[0]?.result;
  if (!isRecord(receipt) || !Array.isArray(receipt.candidateRows)) return;
  const actor = { userId, spaceId } as Actor;
  const entries = receipt.candidateRows.flatMap((row) => {
    if (
      !isRecord(row) ||
      !page.occurrences.some(
        (item) => item.rowIndex === row.rowIndex && item.candidateKey === row.candidateKey,
      )
    )
      return [];
    const parsed = factsSchema.safeParse(row._profile);
    return parsed.success &&
      typeof row.candidateKey === "string" &&
      typeof row._profileSourceEffectId === "string"
      ? [
          {
            personKey: row.candidateKey,
            sourceEffectId: row._profileSourceEffectId,
            profile: parsed.data,
            provider: "people_search",
            fetchedAt: page.observedAt,
          },
        ]
      : [];
  });
  const key = `recruiting-profile-project:${page.effectId}:${page.artifactHash}`;
  const authorized = async (tx: Pick<PrismaClient, "$queryRaw">) => {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT r.id FROM recruiting_roles r JOIN threads t ON t.id=r."sourceThreadId" JOIN space_members sm ON sm."spaceId"=r."spaceId" AND sm."userId"=r."userId" WHERE r.id=${page.roleId} AND r."userId"=${userId} AND r."spaceId"=${spaceId} AND r."archivedAt" IS NULL AND t.id=${run.threadId} AND t."userId"=${userId} AND t."spaceId"=${spaceId} AND t."activeRecruitingRoleId"=r.id FOR SHARE OF r,t,sm`;
    return rows.length === 1;
  };
  // Membership and the current role stay locked only for writes, never while fetching pixels.
  const marker = await prisma.$transaction(async (tx) => {
    if (!(await authorized(tx))) return null;
    const marker = await tx.externalEffect.upsert({
      where: { idempotencyKey: key },
      create: {
        spaceId,
        runId: run.id,
        kind: "recruiting_profile_projection",
        idempotencyKey: key,
        status: "executing",
        request: {
          pageEffectId: page.effectId,
          roleId: page.roleId,
          roleRevisionId: page.roleRevisionId,
          artifactHash: page.artifactHash,
        },
      },
      update: {},
    });
    if (marker.status === "completed") return null;
    await saveRecruitingSavedProfiles(tx, actor, run.id, entries);
    return marker;
  });
  if (!marker) return;
  const profiles = entries.length
    ? await prisma.recruitingSavedProfile.findMany({
        where: {
          ownerUserId: userId,
          spaceId,
          personKey: { in: entries.map((item) => item.personKey) },
        },
      })
    : [];
  const copies = profiles.flatMap((item) => {
    const value = isRecord(item.profile) ? item.profile.profileImageUrl : null;
    return typeof value === "string" &&
      linkedinPhotoUrl(value) &&
      entries.some(
        (entry) =>
          entry.personKey === item.personKey &&
          entry.sourceEffectId === item.sourceEffectId &&
          entry.fetchedAt.getTime() === item.fetchedAt.getTime(),
      )
      ? [
          {
            personKey: item.personKey,
            sourceEffectId: item.sourceEffectId,
            fetchedAt: item.fetchedAt.toISOString(),
            source: value,
            profile_image_url: value,
          },
        ]
      : [];
  });
  await inlineProfilePhotos(copies, fetchPhoto);
  const copied = copies.flatMap((item) =>
    item.profile_image_url?.startsWith("data:image/")
      ? [{ ...item, photo: item.profile_image_url }]
      : [],
  );
  const event = await prisma.$transaction(async (tx) => {
    if (!(await authorized(tx))) return null;
    if (copied.length)
      await tx.$executeRaw`UPDATE recruiting_saved_profiles p SET profile=jsonb_set(p.profile,'{profileImageUrl}',to_jsonb(copy.photo)),"updatedAt"=now() FROM jsonb_to_recordset(${JSON.stringify(copied)}::jsonb) AS copy("personKey" text,"sourceEffectId" text,"fetchedAt" text,source text,photo text) WHERE p."ownerUserId"=${userId} AND p."spaceId"=${spaceId} AND p."personKey"=copy."personKey" AND p."sourceEffectId"=copy."sourceEffectId" AND p."fetchedAt"=copy."fetchedAt"::timestamp AND p.profile->>'profileImageUrl'=copy.source`;
    await tx.externalEffect.update({
      where: { id: marker.id },
      data: {
        status: "completed",
        result: {
          projected: entries.length,
          copied: copied.length,
          sourcePreserved: copies.length - copied.length,
        },
      },
    });
    return appendEventInTransaction(tx, {
      spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "recruiting.changed",
      payload: { roleId: page.roleId },
    });
  });
  if (event) await deps.events.notify(run.threadId, event.seq);
}

/**
 * Keep the history a people search returned on each person's saved profile, at no lookup cost:
 * the Results table reads education and work history from there whichever result is newest (a
 * later grading or contact lookup does not carry them). A saved history is never replaced; a
 * search only fills the parts the saved profile is missing. Photos must already be inlined.
 */
export async function keepSearchHistory(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
  entries: ReadonlyArray<{ row: PeopleSearchRow; effectId: string; createdAt: Date }>,
  saved?: Map<string, RecruitingSavedProfile>,
) {
  const keyed = entries.flatMap((entry) => {
    const key = linkedinPersonKey(entry.row.linkedin_url);
    const facts = key ? factsFromSearchRow(entry.row) : null;
    return key && facts ? [{ ...entry, key, facts }] : [];
  });
  const current =
    saved ??
    (await listRecruitingSavedProfiles(
      prisma,
      actor,
      keyed.map((entry) => entry.key),
    ));
  const filled = new Set<string>();
  let photos = 0;
  for (const { key, facts, effectId, createdAt } of keyed) {
    const before = current.get(key);
    if (complete(before) && (before?.profileImageUrl || !facts.profileImageUrl)) continue;
    const merged = before
      ? {
          headline: before.headline,
          profileImageUrl: before.profileImageUrl ?? facts.profileImageUrl,
          experience: before.experience.length ? before.experience : facts.experience,
          education: before.education.length ? before.education : facts.education,
        }
      : facts;
    if (
      before &&
      merged.experience === before.experience &&
      merged.education === before.education &&
      merged.profileImageUrl === before.profileImageUrl
    )
      continue;
    try {
      const profile = await saveRecruitingSavedProfile(prisma, actor, runId, {
        personKey: key,
        provider: before?.provider ?? "people_search",
        sourceEffectId: effectId,
        fetchedAt: before ? new Date(before.fetchedAt) : createdAt,
        profile: merged,
      });
      current.set(key, profile);
    } catch (error) {
      // One unusable record never stops the rest.
      getLogger().warn("recruiting.profiles.fill.skipped", { error: String(error) });
      continue;
    }
    filled.add(key);
    if (merged.profileImageUrl && !before?.profileImageUrl) photos += 1;
  }
  return { filled, photos };
}

/**
 * Fill the saved profiles of a role's people from the people searches already saved for it, at
 * no lookup cost: their history and photo were in those results but older saves dropped them.
 * Saved work and education histories are kept; only missing parts are filled.
 */
export async function fillRecruitingRoleProfiles(
  prisma: PrismaClient,
  actor: Actor,
  roleId: string,
  fetchPhoto?: Parameters<typeof inlineProfilePhotos>[1],
  options: { dryRun?: boolean } = {},
) {
  const { personKeys, runIds } = await listRecruitingRolePoolRuns(prisma, actor, roleId);
  const saved = await listRecruitingSavedProfiles(prisma, actor, personKeys);
  const pool = new Set(personKeys);
  const incomplete = () => personKeys.filter((key) => !complete(saved.get(key))).length;
  const filled = new Set<string>();
  let photos = 0;
  const fields = (profile: Facts | undefined) => ({
    photo: Boolean(profile?.profileImageUrl),
    work: Boolean(profile?.experience.length),
    education: Boolean(profile?.education.length),
    employerLogo: Boolean(profile?.experience.some((job) => job.company_logo_url)),
    schoolLogo: Boolean(profile?.education.some((school) => school.school_logo_url)),
  });
  const fieldNames = ["photo", "work", "education", "employerLogo", "schoolLogo"] as const;
  const initial = new Map(personKeys.map((key) => [key, fields(saved.get(key))]));
  const missingBefore = Object.fromEntries(
    fieldNames.map((field) => [
      field,
      personKeys.filter((key) => !initial.get(key)![field]).length,
    ]),
  ) as Record<(typeof fieldNames)[number], number>;
  let sourceCalls = 0;
  const name = (value: string | null) => value?.trim().replace(/\s+/g, " ").toLowerCase();
  const unique = (values: (string | null)[]) => {
    const known = [...new Set(values.filter((value): value is string => Boolean(value)))];
    return known.length === 1 ? known[0]! : null;
  };
  for (const runId of runIds) {
    const count = await prisma.externalEffect.count({
      where: {
        runId,
        spaceId: actor.spaceId,
        status: "completed",
        request: { path: ["0"], equals: "__rakazoCatalogTool" },
        run: { userId: actor.userId, spaceId: actor.spaceId },
      },
    });
    // Oldest call first, so each person keeps the history the role first found them with.
    for (let end = count; end > 0; end -= 400) {
      const offset = Math.max(0, end - 400);
      for (const call of (
        await listRunToolResults(prisma, actor, runId, end - offset, offset)
      ).reverse()) {
        sourceCalls += 1;
        // ponytail: bounded saved-call scan; exact person identity is checked by the existing parser.
        // Large pools can later batch that parser without changing this authorization boundary.
        for (const key of pool) {
          const found = profileFromLookup(call.result, call.endpoint, key);
          if (!found) continue;
          const before = saved.get(key);
          const facts = found.facts;
          const photo = {
            profile_image_url: before?.profileImageUrl
              ? undefined
              : (found.photoUrl ?? facts.profileImageUrl ?? undefined),
          };
          if (photo.profile_image_url && !options.dryRun)
            await inlineProfilePhotos([photo], fetchPhoto);
          const merged: Facts = {
            headline: before?.headline ?? facts.headline,
            profileImageUrl: before?.profileImageUrl ?? photo.profile_image_url ?? null,
            experience: before?.experience.length
              ? before.experience.map((job) => {
                  const matches = facts.experience.filter(
                    (item) =>
                      job.company_name &&
                      name(item.company_name) === name(job.company_name) &&
                      !(
                        job.company_url &&
                        item.company_url &&
                        job.company_url !== item.company_url
                      ),
                  );
                  return {
                    ...job,
                    company_logo_url:
                      job.company_logo_url ?? unique(matches.map((item) => item.company_logo_url)),
                    company_url: job.company_url ?? unique(matches.map((item) => item.company_url)),
                    company_linkedin_url:
                      job.company_linkedin_url ??
                      unique(matches.map((item) => item.company_linkedin_url)),
                  };
                })
              : facts.experience,
            education: before?.education.length
              ? before.education.map((school) => {
                  const matches = facts.education.filter(
                    (item) =>
                      school.school_name &&
                      name(item.school_name) === name(school.school_name) &&
                      !(
                        school.school_url &&
                        item.school_url &&
                        school.school_url !== item.school_url
                      ),
                  );
                  return {
                    ...school,
                    school_logo_url:
                      school.school_logo_url ?? unique(matches.map((item) => item.school_logo_url)),
                    school_url: school.school_url ?? unique(matches.map((item) => item.school_url)),
                  };
                })
              : facts.education,
          };
          if (
            before &&
            JSON.stringify({
              headline: before.headline,
              profileImageUrl: before.profileImageUrl,
              experience: before.experience,
              education: before.education,
            }) === JSON.stringify(merged)
          )
            continue;
          const profile = options.dryRun
            ? {
                ...merged,
                personKey: key,
                provider: before?.provider ?? found.provider,
                fetchedAt: before?.fetchedAt ?? call.createdAt.toISOString(),
              }
            : await saveRecruitingSavedProfile(prisma, actor, runId, {
                personKey: key,
                provider: before?.provider ?? found.provider,
                sourceEffectId: call.effectId,
                fetchedAt: before ? new Date(before.fetchedAt) : call.createdAt,
                profile: merged,
              });
          saved.set(key, profile);
          filled.add(key);
          if (profile.profileImageUrl && !before?.profileImageUrl) photos += 1;
        }
      }
    }
  }
  const recoverable = Object.fromEntries(
    fieldNames.map((field) => [
      field,
      personKeys.filter((key) => !initial.get(key)![field] && fields(saved.get(key))[field]).length,
    ]),
  ) as Record<(typeof fieldNames)[number], number>;
  return {
    people: personKeys.length,
    filled: filled.size,
    photos,
    missing: incomplete(),
    inventory: {
      dryRun: Boolean(options.dryRun),
      missingBefore,
      recoverable,
      sourceCalls,
      sourcePageSize: 400 as const,
      sourceCoverage: "owned_saved_results" as const,
    },
  };
}
