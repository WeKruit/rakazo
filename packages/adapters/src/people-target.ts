/** "find 50", "找100个", "scale to 200": the number of people the recruiter asked to reach. */
export function requestedPeopleTarget(text: string): number | undefined {
  if (/e-?mail|contact|outreach|send|draft|邮件|联系|发/i.test(text)) return undefined;
  // Updating saved people ("work history for these 11 people") is not a search for more.
  if (/work history|experience|education|photo|经历|学历|头像/i.test(text)) return undefined;
  const match =
    /(?:find|get|source|search(?:\s+for)?|scale(?:\s+(?:up|out))?(?:\s+to)?|widen\s+to|找|搜|扩大到)\D{0,15}?(\d{2,4})/i.exec(
      text,
    ) ?? /(\d{2,4})\s*(?:more\s+)?(?:people|candidates|profiles|个人|人|位)/i.exec(text);
  const target = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(target) && target >= 10 ? target : undefined;
}

/**
 * "find 50" when Results already hold 50 or more means 50 more; it is a total only when the
 * recruiter says so ("50 total", "一共50") or the role holds fewer than that.
 */
export function peopleTargetFrom(text: string, totalBefore: number): number | undefined {
  const asked = requestedPeopleTarget(text);
  if (!asked) return undefined;
  if (/\b(?:total|in all|altogether|overall)\b|总共|一共|总数|合计/i.test(text)) return asked;
  return /\bmore\b|再/i.test(text) || totalBefore >= asked ? totalBefore + asked : asked;
}
