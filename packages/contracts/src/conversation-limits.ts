/** Selected-text excerpt carried by a reply; capped so a quote stays a quote. */
export const REPLY_QUOTE_MAX_LENGTH = 2_000;

/** Cap an excerpt at the quote limit without splitting a surrogate pair. */
export function truncateReplyQuote(value: string): string {
  const truncated = value.slice(0, REPLY_QUOTE_MAX_LENGTH);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

export const GROUP_MEMBER_MIN = 2;
export const GROUP_MEMBER_MAX = 6;
