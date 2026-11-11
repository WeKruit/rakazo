import type { PageReader } from "./keyless-http-web.js";

/** Full profile pages one turn may read before the first pick, across all its searches. */
export const FULL_PROFILE_READS = 40;
const FULL_PROFILE_CHARS = 16_000;
export const FULL_PROFILE_WAIT_MS = 12_000;

/** One turn's page reads: what is left of its budget and the pages already read. */
export type ProfileReads = {
  read: PageReader;
  reads: { left: number };
  pages?: Map<string, string>;
};

/** The public profile page of a LinkedIn candidate key. */
export function profilePageUrl(candidateKey: string): string | undefined {
  const path = /^linkedin:(\/in\/[^/?#\s]+)/.exec(candidateKey)?.[1];
  return path ? `https://www.linkedin.com${path}` : undefined;
}

/**
 * The full profile text of these people, in order, while the turn's reads last. A page read
 * earlier in the turn is reused without spending a read; a failed read is left out.
 */
export async function fullProfilePages(
  keys: readonly string[],
  reader: ProfileReads,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  reader.pages ??= new Map();
  const pages = reader.pages;
  const texts = new Map<string, string>();
  const unread: string[] = [];
  for (const key of keys) {
    const page = pages.get(key);
    if (page !== undefined) texts.set(key, page);
    else if (profilePageUrl(key) && unread.length < Math.max(0, reader.reads.left))
      unread.push(key);
  }
  reader.reads.left -= unread.length;
  await Promise.all(
    unread.map(async (key) => {
      const page = await reader
        .read(profilePageUrl(key)!, FULL_PROFILE_CHARS, signal)
        .catch(() => undefined);
      if (!page?.text) return;
      pages.set(key, page.text);
      texts.set(key, page.text);
    }),
  );
  return texts;
}

/** The statements of a role's hard criteria, as saved on its current revision. */
export function hardRequirements(revision: unknown): string[] {
  const criteria = (revision as { criteria?: unknown } | null | undefined)?.criteria;
  if (!Array.isArray(criteria)) return [];
  const statements: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (typeof node.statement === "string" && node.statement.trim())
      statements.push(node.statement.trim());
    for (const item of [node.item, ...(Array.isArray(node.items) ? node.items : [])])
      visit(item, depth + 1);
  };
  for (const criterion of criteria)
    if ((criterion as { priority?: unknown })?.priority === "hard")
      visit((criterion as { expression?: unknown }).expression, 0);
  return [...new Set(statements)].slice(0, 12);
}

const STOP = new Set(
  "the and for with must have has years year experience required requires require minimum least plus who are any one able strong work working works based role position currently current preferred profile shows show states stated state counts count met only lives live area metro nearby".split(
    " ",
  ),
);

/** The words of a requirement a profile line would repeat, as whole-word patterns. */
function requirementWords(statement: string): RegExp[] {
  const words = statement.match(/[\p{L}][\p{L}\d/+&-]*/gu) ?? [];
  return [
    ...new Set(
      words
        .map((word) => word.replace(/[-/]+$/, ""))
        .filter((word) => /^\p{Lu}{2,}/u.test(word) || word.length > 3)
        .map((word) => word.toLowerCase())
        .filter((word) => !STOP.has(word)),
    ),
  ].map(
    (word) =>
      new RegExp(
        `(?<![\\p{L}\\d])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`,
        "iu",
      ),
  );
}

const EVIDENCE_CHARS = 360;

/**
 * The lines of a full profile that speak to the role's hard requirements, so a must-have the
 * search row leaves out (a licence, a clearance, a certification) can be seen before the pick:
 * for each requirement, the line repeating most of its words. None when nothing matches.
 */
export function requirementEvidence(
  page: string,
  requirements: readonly string[],
): string | undefined {
  const lines = page
    .split(/\n+|(?<=[.!?。])\s+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 3 && line.length < 400 && !/^(URL: |- \[\d{4}-)/.test(line));
  const picked: string[] = [];
  for (const words of requirements.map(requirementWords)) {
    let best: { line: string; met: number } | undefined;
    for (const line of lines) {
      const met = words.filter((word) => word.test(line)).length;
      if (met && met > (best?.met ?? 0)) best = { line, met };
    }
    if (best && !picked.includes(best.line)) picked.push(best.line);
  }
  if (!picked.length) return undefined;
  const share = Math.floor(EVIDENCE_CHARS / picked.length);
  return picked
    .map((line) => (line.length > share ? `${line.slice(0, share - 1)}…` : line))
    .join(" | ");
}

/**
 * First-round rows with lines from each person's full profile that bear on the role's hard
 * requirements, read in row order while the turn's reads last. The pick reads the evidence
 * itself; nothing is ranked or left out here. Any failure returns the rows unchanged.
 */
export async function withRequirementEvidence<T extends { candidateKey?: unknown }>(
  revision: unknown,
  rows: readonly T[],
  reader: ProfileReads | undefined,
): Promise<Array<T & { fullProfile?: string }>> {
  try {
    const requirements = hardRequirements(revision);
    if (!reader || !requirements.length) return [...rows];
    const pages = await fullProfilePages(
      rows.map((row) => String(row.candidateKey)),
      reader,
      AbortSignal.timeout(FULL_PROFILE_WAIT_MS),
    );
    return rows.map((row) => {
      const page = pages.get(String(row.candidateKey));
      const evidence = page ? requirementEvidence(page, requirements) : undefined;
      return evidence ? { ...row, fullProfile: evidence } : { ...row };
    });
  } catch {
    return [...rows];
  }
}
