/** Months a person must have been in their current role before a calibration round shows them. */
export const MIN_CURRENT_ROLE_MONTHS = 6;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const CURRENT_ROLE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\s*[-–—]\s*(?:present|current|now)\b(?:\s*\(([^)]*)\))?/gi;

/**
 * Months in the current role when every current role a profile passage shows ("May 2026 -
 * Present (4 months)") started under six months ago; null when the passage shows none, or shows
 * one held longer. The stated duration wins over the start date, since it is as of the profile.
 */
export function shortCurrentTenure(passage: string | null | undefined, now = new Date()) {
  if (!passage) return null;
  const months = [...passage.matchAll(CURRENT_ROLE)].map((match) => {
    const stated = match[3]?.toLowerCase() ?? "";
    const statedMonths = stated.match(/^(\d+)\s+months?$/)?.[1];
    if (statedMonths) return Number(statedMonths);
    if (/\byears?\b/.test(stated)) return Number.POSITIVE_INFINITY;
    const month = MONTHS.indexOf((match[1] as string).toLowerCase().slice(0, 3));
    return (now.getUTCFullYear() - Number(match[2])) * 12 + now.getUTCMonth() - month;
  });
  if (!months.length) return null;
  const longest = Math.max(...months);
  return longest < MIN_CURRENT_ROLE_MONTHS ? Math.max(0, longest) : null;
}
