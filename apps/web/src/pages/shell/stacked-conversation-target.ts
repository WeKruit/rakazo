/** A link to a moment in a group conversation in this app: /app/g/<groupId>?m=<messageId>. */
export function stackedConversationTarget(
  href: string,
  origin: string,
): { groupId: string; messageId?: string } | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const match = /^\/app\/g\/([^/]+)\/?$/.exec(url.pathname);
  if (!match?.[1]) return null;
  const messageId = url.searchParams.get("m") ?? undefined;
  return { groupId: decodeURIComponent(match[1]), ...(messageId ? { messageId } : {}) };
}
