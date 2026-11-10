import type { TextJudge } from "./judge.js";
import { linkedinPersonKey } from "./recruiting-profiles.js";

/**
 * A required language is rarely in the short passage a people row carries, so the search's own
 * profile text is read by the yes/no judge and each row says whether that text shows it.
 */
export type LanguageSignal = "shown" | "unclear" | "no sign";

/** Languages a brief may require, matched in English or Chinese. */
const LANGUAGE_WORDS =
  /\b(mandarin|chinese|cantonese|spanish|japanese|korean|vietnamese|french|german|portuguese|arabic|hindi|russian|italian|thai|tagalog|bilingual)\b|中文|普通话|國語|国语|粤语|廣東話|广东话|双语|日语|韩语|西班牙语/i;

type BriefLike = {
  searchFilters?: Array<{ statement?: unknown; mode?: unknown }>;
  fields?: Array<{ key?: unknown; value?: unknown }>;
};

/** The brief's required-language statement, or undefined when it requires none. */
export function requiredLanguage(brief: unknown): string | undefined {
  if (!brief || typeof brief !== "object") return undefined;
  const { searchFilters = [], fields = [] } = brief as BriefLike;
  const statements = [
    ...searchFilters
      .filter((filter) => filter.mode === "include")
      .map((filter) => String(filter.statement ?? "")),
    ...fields.map((field) => `${String(field.key ?? "")}: ${String(field.value ?? "")}`),
  ];
  const found = statements.filter((text) => LANGUAGE_WORDS.test(text));
  return found.length ? found.join("; ").slice(0, 400) : undefined;
}

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
        if (key && !texts.has(key)) texts.set(key, entry.slice(0, PROFILE_TEXT_LIMIT));
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
    if (key && !texts.has(key)) texts.set(key, JSON.stringify(record).slice(0, PROFILE_TEXT_LIMIT));
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

/**
 * Asks the judge about each person's profile text, all at once. People the judge could not answer
 * for, or with no profile text, are left out; the search result never waits on a failed judge.
 */
export async function languageSignals(
  judge: TextJudge,
  requirement: string,
  people: ReadonlyArray<{ candidateKey: string; name?: string }>,
  texts: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<Map<string, LanguageSignal>> {
  const signals = new Map<string, LanguageSignal>();
  await Promise.all(
    people.map(async (person) => {
      const text = texts.get(person.candidateKey);
      if (!text) return;
      const p = await judge.yes(
        QUESTION(requirement),
        { profile: withoutName(text, person.name ?? "") },
        signal,
      );
      if (p === undefined) return;
      signals.set(person.candidateKey, p >= SHOWN ? "shown" : p < NO_SIGN ? "no sign" : "unclear");
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

/**
 * A people search's rows with the brief's required language checked, when the brief requires
 * one and the deployment has a judge. Any failure returns the rows unchanged.
 */
export async function withRequiredLanguage<T extends { candidateKey?: unknown; name?: unknown }>(
  judgeSettings: { resolve(): Promise<TextJudge | undefined> } | undefined,
  brief: unknown,
  rows: readonly T[],
  result: unknown,
): Promise<Array<T & { requiredLanguage?: LanguageSignal }>> {
  try {
    const requirement = requiredLanguage(brief);
    const judge = requirement ? await judgeSettings?.resolve() : undefined;
    if (!requirement || !judge) return [...rows];
    const people = rows.map((row) => ({
      candidateKey: String(row.candidateKey),
      name: typeof row.name === "string" ? row.name : undefined,
    }));
    const signals = await languageSignals(judge, requirement, people, profileTexts(result));
    return signals.size ? withLanguageSignals(rows, signals) : [...rows];
  } catch {
    return [...rows];
  }
}
