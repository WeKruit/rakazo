import type { RecruitingCandidateReport } from "@rakazo/contracts";

type Field = RecruitingCandidateReport["fields"][number];

export type QuickBrief = { name: string | null; verdict: string | null };
export type QuickEntity = {
  name: string;
  kind: string | null;
  host: string | null;
  description: string | null;
};
export type QuickOutput = {
  headline: string | null;
  highlights: readonly string[];
  keyWorks: readonly { title: string; detail: string | null; url: string | null }[];
  concerns: readonly string[];
  entities: readonly QuickEntity[];
};

/**
 * The short columns as requested and as the research agent has also named them
 * ("summary_zh", "highlight_tags_zh", …), read the same way.
 */
const LABELS = {
  headline: /^(?:headline(?: zh)?|summary zh)$/i,
  highlights: /^(?:highlights|highlight tags)(?: zh)?$/i,
  keyWorks: /^(?:key|representative) works?(?: zh)?$/i,
  concerns: /^concerns(?: zh)?$/i,
  briefs: /^(?:criteria|criterion) briefs?(?: zh)?$/i,
  entities: /^(?:entities|mentioned (?:orgs?|organizations?))(?: zh)?$/i,
};

/** Words that mark a lookup note ("来源 …", "search-index snippet, checked …", "页面 403"). */
const PROVENANCE =
  /来源|出处|检索|索引|片段|引语|快照|核实|查证|截至|非本次|读取|页面|provider|snippet|search[- ]index|checked|accessed|retrieved|verified|cached|lookup|\bas of\b|\bsources?\s*[:：]|\bsources? read\b|readable source|\b40[134]\b/i;
const URL_TEXT = /https?:\/\/[^\s|,，;；()（）[\]【】“”"]+/gi;
const OPEN = "(（[【“";
const CLOSE = ")）]】”";

/** HTML entities the provider sometimes leaves encoded, decoded as often as they nest. */
export function decodeEntities(text: string) {
  let out = text;
  for (let pass = 0; pass < 3 && /&(?:amp|lt|gt|quot|#39|apos);/.test(out); pass += 1)
    out = out
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&(?:#39|apos);/g, "'")
      .replace(/&amp;/g, "&");
  return out;
}

/** Splits on the given separators only outside brackets and quotes. */
function splitTop(text: string, separators: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (OPEN.includes(char)) depth += 1;
    else if (CLOSE.includes(char)) depth = Math.max(0, depth - 1);
    if (depth === 0 && separators.includes(char)) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Top-level bracket groups with their text, nested brackets included. */
function bracketGroups(text: string) {
  const groups: { start: number; end: number; inner: string }[] = [];
  let depth = 0;
  let start = 0;
  [...text].forEach((char, index, chars) => {
    if ("(（[【".includes(char)) {
      if (depth === 0) start = index;
      depth += 1;
    } else if (")）]】".includes(char) && depth > 0) {
      depth -= 1;
      if (depth === 0)
        groups.push({ start, end: index + 1, inner: chars.slice(start + 1, index).join("") });
    }
  });
  return groups;
}

function tidy(text: string) {
  return text
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([，,。;；:：）)])/g, "$1")
    .replace(/^[\s,，;；:：、·—–-]+|[\s,，;；:：、·—–-]+$/g, "")
    .trim();
}

/**
 * Text with its lookup notes removed: inside each bracket, the clauses that are notes go, and an
 * emptied bracket goes with them; a trailing "来源：…" clause goes too.
 */
export function withoutProvenance(text: string): string {
  const chars = [...decodeEntities(text)];
  let out = "";
  let at = 0;
  for (const group of bracketGroups(chars.join(""))) {
    out += chars.slice(at, group.start).join("");
    const parts = splitTop(group.inner, ",，;；");
    const kept = parts.filter((part) => !PROVENANCE.test(part));
    if (kept.length === parts.length && !PROVENANCE.test(group.inner))
      out += chars.slice(group.start, group.end).join("");
    else if (kept.length)
      out += `${chars[group.start]}${kept.map(withoutProvenance).join("，")}${chars[group.end - 1]}`;
    at = group.end;
  }
  out += chars.slice(at).join("");
  return tidy(out.replace(/[\s，,;；。]*(?:来源|出处|来源链接|sources?)\s*[:：].*$/i, ""));
}

/** Text with every bracket group removed. */
function withoutBrackets(text: string) {
  const chars = [...text];
  let out = "";
  let at = 0;
  for (const group of bracketGroups(text)) {
    out += chars.slice(at, group.start).join("");
    at = group.end;
  }
  return tidy(out + chars.slice(at).join(""));
}

/** At most `max` characters, with an ellipsis when cut. */
export function clip(text: string, max: number) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** The first sentence or clause ending in 。 or ；, outside brackets and quotes. */
function firstSentence(text: string) {
  return splitTop(text, "。；;")[0] ?? "";
}

const NUMBERED = /(?:^|[\s；;。：:，,])(?:\d{1,2}|[一二三四五六七八九十])\s*[)）、]\s*/g;

/**
 * One entry per item: numbered items ("1）…；2）…") when the value is numbered, with any lead-in
 * before the first number dropped; otherwise lines and top-level 「；」.
 */
function items(fields: readonly Field[], linesOnly = false) {
  return fields.flatMap((field) => {
    const value = decodeEntities(field.value ?? "");
    const marks = [...value.matchAll(NUMBERED)];
    if (marks.length >= 2)
      return marks
        .map((mark, index) =>
          value.slice((mark.index ?? 0) + mark[0].length, marks[index + 1]?.index ?? value.length),
        )
        .map((item) => firstSentence(item))
        .filter(Boolean);
    return value
      .split(/\r?\n/)
      .flatMap((line) => (linesOnly ? [line.trim()] : splitTop(line, "；;•")))
      .filter(Boolean);
  });
}

function host(text: string) {
  const raw = text.match(URL_TEXT)?.[0];
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !/(^|\.)linkedin\.com$/.test(url.hostname)
      ? url.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

const noUrls = (text: string) => tidy(text.replace(URL_TEXT, ""));

function parseWork(raw: string) {
  const url = raw.match(URL_TEXT)?.[0] ?? null;
  if (raw.includes("|")) {
    const [title = "", ...rest] = raw.split("|").map((part) => withoutProvenance(noUrls(part)));
    const detail = rest.filter(Boolean).join(" · ");
    return { title: clip(title, 40), detail: detail ? clip(detail, 30) : null, url };
  }
  const clean = withoutProvenance(noUrls(raw));
  // "“quoted line”——what it shows" reads best as what it shows.
  const gloss = clean.split(/\s*——\s*/);
  const named = gloss.length > 1 ? (gloss.at(-1) ?? "") : clean;
  const title = firstSentence(withoutBrackets(named));
  const detail = gloss.length > 1 ? null : (bracketGroups(named)[0]?.inner.trim() ?? null);
  return { title: clip(title, 40), detail: detail ? clip(detail, 30) : null, url };
}

/** "column | 短名 | 结论" keyed by column; "硬要求3 名称：结论 — 理由" keyed by position. */
function parseBrief(raw: string, index: number) {
  if (raw.includes("|")) {
    const [key, name, verdict] = raw.split("|").map((part) => withoutProvenance(part));
    return key && (name || verdict)
      ? {
          key,
          index,
          brief: {
            name: name ? clip(name, 12) : null,
            verdict: verdict ? clip(verdict, 24) : null,
          },
        }
      : null;
  }
  const numbered = /^\D{0,4}?(\d{1,2})\s*[.、)）]?\s*(.*)$/s.exec(raw.trim());
  const text = withoutProvenance(numbered?.[2] ?? raw);
  const colon = /[：:]/.exec(text);
  const name = colon ? text.slice(0, colon.index).trim() : null;
  const verdict =
    (colon ? text.slice(colon.index + 1) : text).split(/\s*[—–]\s*|\s+-\s+/)[0]?.trim() ?? "";
  return name || verdict
    ? {
        key: null,
        index: numbered ? Number(numbered[1]) - 1 : index,
        brief: {
          name: name ? clip(name, 12) : null,
          verdict: verdict ? clip(firstSentence(verdict), 24) : null,
        },
      }
    : null;
}

/** "Name | kind | site | about", or groups such as "任职公司：A（…）；B（…）。学校：C（…）。" */
function parseEntities(fields: readonly Field[]): QuickEntity[] {
  const lines = fields.flatMap((field) => decodeEntities(field.value ?? "").split(/\r?\n/));
  const entities: QuickEntity[] = [];
  for (const line of lines) {
    if (line.includes("|")) {
      const [name, kind, site, description] = line.split("|").map((part) => part.trim());
      const about = description ? withoutProvenance(description) : "";
      if (name)
        entities.push({
          name: withoutProvenance(name),
          kind: kind || null,
          host: host(site ?? ""),
          description: about ? clip(about, 30) : null,
        });
      continue;
    }
    for (const group of splitTop(line, "。")) {
      const colon = splitTop(group, "：:");
      const kind = colon.length > 1 ? clip(withoutBrackets(colon[0] ?? ""), 10) : null;
      const body = colon.length > 1 ? group.slice(group.indexOf(colon[1] ?? "")) : group;
      for (const item of splitTop(body, "；;")) {
        const site = host(item);
        const clean = withoutProvenance(noUrls(item));
        const name = withoutBrackets(clean)
          .replace(/\s*(?:官网|官方网站|website)$/i, "")
          .trim();
        if (!name) continue;
        const existing = entities.find((entity) => entity.name === name);
        if (existing) {
          existing.host ??= site;
          continue;
        }
        const about = bracketGroups(clean)[0]?.inner.trim();
        entities.push({
          name,
          kind,
          host: site,
          description: about ? clip(about, 30) : null,
        });
      }
    }
  }
  return entities;
}

/**
 * The research agent's short columns as a recruiter scans them: split into items, lookup notes
 * removed and each item kept short. Missing columns give empty output, never a guess.
 */
export function quickOutput(fields: readonly Field[]) {
  const take = (pattern: RegExp) => fields.filter((field) => pattern.test(field.label.trim()));
  const headline = take(LABELS.headline);
  const highlights = take(LABELS.highlights);
  const keyWorks = take(LABELS.keyWorks);
  const concerns = take(LABELS.concerns);
  const briefs = take(LABELS.briefs);
  const entities = take(LABELS.entities);
  const lead = firstSentence(withoutProvenance(noUrls(headline[0]?.value ?? "")));
  const quick: QuickOutput = {
    headline: lead ? clip(lead, 48) : null,
    highlights: [
      ...new Set(
        items(highlights)
          .map((tag) => withoutBrackets(withoutProvenance(noUrls(tag))))
          .filter(Boolean)
          .map((tag) => clip(tag, 18)),
      ),
    ].slice(0, 6),
    keyWorks: items(keyWorks)
      .map(parseWork)
      .filter((work) => work.title)
      .slice(0, 4),
    concerns: items(concerns)
      .map((concern) => {
        const clean = withoutProvenance(noUrls(concern));
        const clause = splitTop(clean, "，,")[0] ?? clean;
        return clip([...clause].length >= 6 ? clause : clean, 28);
      })
      .filter(Boolean)
      .slice(0, 3),
    entities: parseEntities(entities),
  };
  return {
    quick,
    briefs: items(briefs, true)
      .map(parseBrief)
      .filter((brief): brief is NonNullable<typeof brief> => brief !== null),
    placed: [...headline, ...highlights, ...keyWorks, ...concerns, ...briefs, ...entities],
  };
}

/**
 * A research note in a history cell ("Institution only (search-index snippet, checked …): School.
 * Degree unknown …") reduced to what it names; other text is returned unchanged.
 */
export function historyNoteText(value: string, firstOnly: boolean) {
  const clean = withoutProvenance(value);
  const prefix =
    /^[^:：.。|]{0,40}?\b(?:only|partial(?:ly)?|undated|unverified|snippet)\b[^:：|]{0,30}[:：]\s*/i;
  if (!prefix.test(clean)) return clean === tidy(decodeEntities(value)) ? value : clean;
  const rest = clean.replace(prefix, "");
  return firstOnly
    ? (rest
        .split(/(?<=\S{2})\.\s+|。/)[0]
        ?.replace(/\.$/, "")
        .trim() ?? rest)
    : rest;
}
