import type { LanguageSignal, TextJudge } from "./judge.js";
import type { ProfileReads } from "./recruiting-full-profile.js";
import { FULL_PROFILE_WAIT_MS, fullProfilePages } from "./recruiting-full-profile.js";
import { linkedinPersonKey } from "./recruiting-profiles.js";

/** Languages a brief may require, matched in English or Chinese. */
const LANGUAGE_WORDS =
  /\b(mandarin|chinese|cantonese|spanish|japanese|korean|vietnamese|french|german|portuguese|arabic|hindi|russian|italian|thai|tagalog|bilingual)\b|中文|普通话|國語|国语|粤语|廣東話|广东话|双语|日语|韩语|西班牙语/i;

/**
 * The role's required-language statement, or undefined when it requires none. Reads the saved
 * brief and the role's criteria: the first round runs before the brief is saved, while the
 * criteria already hold the JD's requirements.
 */
export function requiredLanguage(role: unknown): string | undefined {
  const sentences: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") {
      for (const sentence of value.split(/(?<=[.;!?。；！？\n])\s*/))
        if (LANGUAGE_WORDS.test(sentence)) sentences.push(sentence.trim());
      return;
    }
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else if (typeof value === "object")
      for (const item of Object.values(value as Record<string, unknown>)) visit(item, depth + 1);
  };
  visit(role, 0);
  const unique = [...new Set(sentences.filter(Boolean))];
  return unique.length ? unique.join("; ").slice(0, 400) : undefined;
}

/** Words for a language, mapped to the English names profiles list it under. */
const LANGUAGE_NAMES: ReadonlyArray<[RegExp, string[]]> = [
  [/mandarin|普通话|國語|国语/i, ["Mandarin", "Chinese"]],
  [/chinese|中文/i, ["Mandarin", "Chinese"]],
  [/cantonese|粤语|廣東話|广东话/i, ["Cantonese"]],
  [/japanese|日语/i, ["Japanese"]],
  [/korean|韩语/i, ["Korean"]],
  [/spanish|西班牙语/i, ["Spanish"]],
  [/\b(vietnamese|french|german|portuguese|arabic|hindi|russian|italian|thai|tagalog)\b/i, []],
];

/**
 * The words a people search can require on the profile (its includeText) for the language that
 * most of these queries name, or none when they name no language.
 */
export function languageFilters(queries: readonly string[]): string[] {
  for (const [pattern, names] of LANGUAGE_NAMES) {
    const naming = queries.filter((query) => pattern.test(query));
    if (naming.length * 2 < queries.length || !naming.length) continue;
    if (names.length) return names;
    const word = naming[0]!.match(pattern)?.[0] ?? "";
    return word ? [word[0]!.toUpperCase() + word.slice(1).toLowerCase()] : [];
  }
  return [];
}

const REQUIRES =
  /\b(must|required?|requires|needs?|needed|fluent|fluency|bilingual|mandatory)\b|必须|要求|需要|会说|流利|精通|双语/i;

/**
 * The recruiter's own sentences that require a language (from their messages or pasted JD), so a
 * search that left the language out still filters on it.
 */
export function statedLanguageRequirement(texts: readonly string[]): string | undefined {
  const found = texts
    .flatMap((text) => text.split(/(?<=[.;!?。；！？\n])\s*/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => LANGUAGE_WORDS.test(sentence) && REQUIRES.test(sentence));
  return found.length ? [...new Set(found)].join("; ").slice(0, 400) : undefined;
}

/**
 * Profile filters for planned people searches: the language most queries name, else the one the
 * recruiter's own words require.
 */
export function plannedLanguageFilters(
  queries: readonly string[],
  recruiterTexts: readonly string[],
): { filters: string[]; queriesNameIt: boolean } {
  const named = languageFilters(queries);
  if (named.length) return { filters: named, queriesNameIt: true };
  const stated = statedLanguageRequirement(recruiterTexts);
  return { filters: stated ? languageFilters([stated]) : [], queriesNameIt: false };
}

/** The built-in question reads this much of each profile; the deployment's check gets all of it. */
const PROFILE_TEXT_LIMIT = 4_000;

/**
 * Each person's own profile text in a people-search result, by candidate key: the listing entry
 * for text listings, the record itself otherwise.
 */
export function profileTexts(result: unknown): Map<string, string> {
  const texts = new Map<string, string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === "string") {
      for (const entry of value.split(/^(?=Title: )/m)) {
        const url = entry.match(/^URL: (\S+)$/m)?.[1];
        const key = url ? linkedinPersonKey(url) : null;
        if (key && !texts.has(key)) texts.set(key, entry);
      }
      if (value.trimStart().startsWith("{") || value.trimStart().startsWith("["))
        try {
          visit(JSON.parse(value), depth + 1);
        } catch {}
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const link = [record.linkedin_url, record.url, record.id].find(
      (item) => typeof item === "string" && linkedinPersonKey(item),
    );
    const key = link ? linkedinPersonKey(link) : null;
    if (key && !texts.has(key)) texts.set(key, JSON.stringify(record));
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(result, 0);
  return texts;
}

/** The person's name taken out, so the judge reads only what the profile states. */
export function withoutName(text: string, name: string): string {
  let out = text;
  for (const part of [name, ...name.split(/[\s,.()]+/)].filter((item) => item.length > 1)) {
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, "gu"), "[name]");
  }
  return out;
}

const QUESTION = (requirement: string) =>
  `The role requires: "${requirement}". Does this profile text show the person can work in the required language? Count only what the text states: a Languages entry, posts or other content written in that language, a degree, school or job in a place where it is spoken, or work stated to use it. The name is hidden on purpose; never guess from names, photos or origin.`;

/** At or above this the profile shows the language; below the lower bound it shows no sign. */
const SHOWN = 0.6;
const NO_SIGN = 0.25;

/** A person in a search's rows, with the row itself for the deployment's own check. */
type Person = { candidateKey: string; name?: string; candidate?: Record<string, unknown> };

/** The yes/no judge's answer for one row, when the deployment has no language check of its own. */
async function askedLanguage(
  judge: TextJudge,
  requirement: string,
  name: string,
  profile: string,
  signal?: AbortSignal,
): Promise<LanguageSignal | undefined> {
  const p = await judge.yes(
    QUESTION(requirement),
    { profile: withoutName(profile.slice(0, PROFILE_TEXT_LIMIT), name) },
    signal,
  );
  if (p === undefined) return undefined;
  return p >= SHOWN ? "shown" : p < NO_SIGN ? "no sign" : "unclear";
}

/**
 * Asks the judge about each person's profile text, all at once: the deployment's own language
 * check with the rows in batches when it has one, else one yes/no question each. People the
 * judge could not answer for, or with no profile text, are left out; the search result never
 * waits on a failed judge.
 */
export async function languageSignals(
  judge: TextJudge,
  requirement: string,
  people: ReadonlyArray<Person>,
  texts: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<Map<string, LanguageSignal>> {
  const rows = people.flatMap((person) => {
    const profile = texts.get(person.candidateKey);
    return profile
      ? [{ id: person.candidateKey, name: person.name, profile, candidate: person.candidate }]
      : [];
  });
  if (judge.language) return rows.length ? judge.language(requirement, rows, signal) : new Map();
  const signals = new Map<string, LanguageSignal>();
  await Promise.all(
    rows.map(async (row) => {
      const verdict = await askedLanguage(judge, requirement, row.name ?? "", row.profile, signal);
      if (verdict) signals.set(row.id, verdict);
    }),
  );
  return signals;
}

const ORDER: Record<LanguageSignal, number> = { shown: 0, unclear: 1, "no sign": 2 };

/** Rows with the language shown first, then unclear, then no sign; unjudged rows sit with unclear. */
export function withLanguageSignals<T extends { candidateKey?: unknown }>(
  rows: readonly T[],
  signals: ReadonlyMap<string, LanguageSignal>,
): Array<T & { requiredLanguage?: LanguageSignal }> {
  return rows
    .map((row, index) => {
      const value = signals.get(String(row.candidateKey));
      return { row: value ? { ...row, requiredLanguage: value } : { ...row }, index, value };
    })
    .sort((a, b) => ORDER[a.value ?? "unclear"] - ORDER[b.value ?? "unclear"] || a.index - b.index)
    .map((entry) => entry.row);
}

/** Places whose study or work signals the language, for the check without a judge. */
const LANGUAGE_PLACES: Record<string, RegExp> = {
  Mandarin:
    /\b(china|taiwan|beijing|shanghai|shenzhen|guangzhou|hangzhou|taipei|tsinghua|peking university|fudan|zhejiang university)\b|中文|普通话/i,
  Cantonese: /\b(hong kong|guangzhou|macau)\b|粤语|廣東話/i,
};

/**
 * Without the judge, a profile shows the language when its text names it (or, for Mandarin and
 * Cantonese, a place where it is spoken); otherwise it shows no sign of it.
 */
export function textLanguageJudge(requirement: string): TextJudge {
  const names = languageFilters([requirement]);
  const named = names.length ? new RegExp(`\\b(${names.join("|")})\\b`, "i") : null;
  const places = names.map((name) => LANGUAGE_PLACES[name]).filter(Boolean) as RegExp[];
  return {
    async yes(_instructions, state) {
      if (!named) return undefined;
      const profile = String(state.profile ?? "");
      return named.test(profile) || places.some((place) => place.test(profile)) ? 0.9 : 0.1;
    },
  };
}

/**
 * The search's own text often leaves the language out, so people it does not show it for get
 * their full profile page read and judged again, in row order, while the turn's reads last.
 */
async function fullProfileSignals(
  judge: TextJudge,
  requirement: string,
  people: ReadonlyArray<Person>,
  signals: ReadonlyMap<string, LanguageSignal>,
  reader: ProfileReads,
): Promise<Map<string, LanguageSignal>> {
  const pending = people.filter((person) => signals.get(person.candidateKey) !== "shown");
  const signal = AbortSignal.timeout(FULL_PROFILE_WAIT_MS);
  const texts = await fullProfilePages(
    pending.map((person) => person.candidateKey),
    reader,
    signal,
  );
  if (!texts.size) return new Map();
  const read = pending.filter((person) => texts.has(person.candidateKey));
  return languageSignals(judge, requirement, read, texts, signal).catch(() => new Map());
}

/**
 * A people search's rows with the role's required language checked: people whose profile shows
 * it first, and people whose profile shows no sign of it left out of what the agent picks from
 * (they stay in Results). Uses the deployment's judge, or the profile text alone without one.
 * Any failure returns the rows unchanged.
 */
export async function withRequiredLanguage<T extends { candidateKey?: unknown; name?: unknown }>(
  judgeSettings: { resolve(): Promise<TextJudge | undefined> } | undefined,
  role: unknown,
  rows: readonly T[],
  result: unknown,
  reader?: ProfileReads,
): Promise<{ rows: Array<T & { requiredLanguage?: LanguageSignal }>; withoutLanguage: number }> {
  try {
    const requirement = requiredLanguage(role);
    if (!requirement) return { rows: [...rows], withoutLanguage: 0 };
    const judge =
      (await judgeSettings?.resolve().catch(() => undefined)) ?? textLanguageJudge(requirement);
    const people = rows.map((row) => ({
      candidateKey: String(row.candidateKey),
      name: typeof row.name === "string" ? row.name : undefined,
      candidate: { ...row },
    }));
    const texts = profileTexts(result);
    let signals = await languageSignals(judge, requirement, people, texts);
    // A judge that answered for nobody (down or timed out) falls back to the profile text.
    if (!signals.size)
      signals = await languageSignals(textLanguageJudge(requirement), requirement, people, texts);
    if (reader)
      for (const [key, value] of await fullProfileSignals(
        judge,
        requirement,
        people,
        signals,
        reader,
      ))
        signals.set(key, value);
    if (!signals.size) return { rows: [...rows], withoutLanguage: 0 };
    const ordered = withLanguageSignals(rows, signals);
    const kept = ordered.filter((row) => row.requiredLanguage !== "no sign");
    return { rows: kept, withoutLanguage: ordered.length - kept.length };
  } catch {
    return { rows: [...rows], withoutLanguage: 0 };
  }
}
