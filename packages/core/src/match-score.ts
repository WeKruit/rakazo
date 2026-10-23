/**
 * Match scores are shown on one 0–100 scale everywhere. Providers sometimes answer on 0–10 (or
 * 0–1, or "8/10"); this only converts units. It never rescores, reranks or judges anyone, and
 * the provider's original cell stays untouched in the saved result.
 */

type ParsedScore = { value: number; max: number | null };

const NUMBER = String.raw`-?\d+(?:\.\d+)?`;
const FRACTION = new RegExp(String.raw`^\s*(${NUMBER})\s*/\s*(\d+(?:\.\d+)?)\s*$`, "u");
const PERCENT = new RegExp(String.raw`^\s*(${NUMBER})\s*%\s*$`, "u");
const PLAIN = new RegExp(String.raw`^\s*(${NUMBER})\s*(?:分|pts?|points?)?\s*$`, "iu");

function parse(raw: unknown): ParsedScore | null {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "value" in raw)
    return parse((raw as { value: unknown }).value);
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw, max: null } : null;
  if (typeof raw !== "string") return null;
  const fraction = FRACTION.exec(raw);
  if (fraction) {
    const max = Number(fraction[2]);
    return max > 0 ? { value: Number(fraction[1]), max } : null;
  }
  const percent = PERCENT.exec(raw);
  if (percent) return { value: Number(percent[1]), max: 100 };
  const plain = PLAIN.exec(raw);
  return plain ? { value: Number(plain[1]), max: null } : null;
}

/**
 * The scale of plain numbers in one saved result: a result whose plain scores all fit in 0–1
 * (with a fraction) is 0–1, all in 0–10 is 0–10, otherwise 0–100. Decided per result, so one
 * low 0–100 score is never mistaken for 0–10.
 */
export function matchScoreScale(cells: readonly unknown[]): 1 | 10 | 100 {
  const plain = cells
    .map(parse)
    .filter((score): score is ParsedScore => score !== null && score.max === null)
    .map((score) => score.value);
  if (!plain.length) return 100;
  const max = Math.max(...plain);
  if (max <= 1 && plain.some((value) => !Number.isInteger(value))) return 1;
  return max <= 10 ? 10 : 100;
}

/** One provider score cell on 0–100 (whole number), or null when it is not a score. */
export function matchScore100(raw: unknown, scale: 1 | 10 | 100 = matchScoreScale([raw])) {
  const score = parse(raw);
  if (!score) return null;
  const value = (score.value / (score.max ?? scale)) * 100;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/** Report keys that carry a match score ("match_score", "score", "fit_score", ...). */
export function isMatchScoreKey(key: string): boolean {
  return /^score$|[_\s-]score$/iu.test(key) || /[a-z]Score$/u.test(key);
}
