/** Email send tools: each call shows its confirmation card. */
export const EMAIL_SEND_TOOLS = new Set([
  "reply_to_email",
  "native_instantly_reply_to_email",
  "GMAIL_SEND_EMAIL",
  "GMAIL_REPLY_TO_THREAD",
]);

// The sending account is the recruiter's own connected mailbox, not a recipient.
const SENDER_KEYS = new Set(["eaccount", "from", "from_email", "sender"]);

const EMAIL_ADDRESS = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

/**
 * Every address anywhere in a send tool's arguments, lowercased, except the sending account.
 * Scanning all fields fails closed for recipient keys a tool names differently.
 */
export function sendRecipients(args: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string")
      for (const match of value.match(EMAIL_ADDRESS) ?? []) found.add(match.toLowerCase());
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object")
      for (const [key, nested] of Object.entries(value)) if (!SENDER_KEYS.has(key)) collect(nested);
  };
  collect(args);
  return [...found];
}
