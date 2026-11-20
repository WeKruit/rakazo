/** "find 50", "找100个", "scale to 200": the number of people the recruiter asked to reach. */
export function requestedPeopleTarget(text: string): number | undefined {
  if (/e-?mail|contact|outreach|send|draft|邮件|联系|发/i.test(text)) return undefined;
  // Updating saved people ("work history for these 11 people") is not a search for more.
  if (/work history|experience|education|photo|经历|学历|头像/i.test(text)) return undefined;
  const match =
    /(?:find|get|source|search(?:\s+for)?|scale(?:\s+(?:up|out))?(?:\s+to)?|widen\s+to|找|搜|扩大到)\D{0,15}?(\d{2,4})/i.exec(
      text,
    ) ??
    /(\d{2,4})\s*(?:more\s+)?(?:people|candidates|profiles|个(?![月小年])|人|位|名)/i.exec(text) ??
    // Long-search-finishes 11-15 (aceb80c9): "最多20个" named no verb and was missed.
    /(?:at most|up to|no more than|max(?:imum)?|最多|至多|不超过)\s*(\d{2,4})/i.exec(text);
  const target = match ? Number(match[1]) : Number.NaN;
  if (Number.isFinite(target) && target >= 10) return target;
  // Staging 11-20 (2a781497): "再来5个" read as no number and 26 were saved. A small number of
  // people asked for ("再来5个", "2 more people") is the request too; "这3个不要" is not.
  const few =
    /(?<!这|那|前|后|头|第|these |those |the |top |first |last )(?<!\d)([1-9])\s*(?:more\s+)?(?:people|candidates|profiles|个(?![月小年])|人|位|名)/i.exec(
      text,
    );
  return few ? Number(few[1]) : undefined;
}

/**
 * "find 50" when Results already hold 50 or more means 50 more; it is a total only when the
 * recruiter says so ("50 total", "一共50") or the role holds fewer than that.
 */
export function peopleTargetFrom(text: string, totalBefore: number): number | undefined {
  const asked = requestedPeopleTarget(text);
  if (!asked) return undefined;
  if (/\b(?:total|in all|altogether|overall)\b|总共|一共|总数|合计/i.test(text)) return asked;
  return /\b(?:more|another|additional)\b|再|继续|多找|另外|追加/i.test(text) ||
    totalBefore >= asked
    ? totalBefore + asked
    : asked;
}

/**
 * Long-search-finishes 11-15: the recruiter wrote "find 20, tell me when done", the role already
 * held 64, and the turn still asked "report, or 20 more?". A number the recruiter asked for is
 * their decision: once Results hold it the turn reports instead of asking, and below it the turn
 * keeps going instead of asking.
 */
export function askAfterPeopleTarget(target: number | undefined, saved: number | undefined) {
  if (!target || saved === undefined) return undefined;
  return saved >= target
    ? `Not asked: the recruiter asked for ${target} people and the role now holds ${saved}, so their request is done. Do not offer more or ask how to go on: tell them in one short message, in their language, how many people this role holds and that the search is finished, then end the turn.`
    : `Not asked: the recruiter asked for ${target} people and the role holds ${saved}, so keep searching toward ${target} without asking (each search is a small try), then report the count when it is reached or the tries run out.`;
}
