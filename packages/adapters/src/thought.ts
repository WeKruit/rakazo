import { scrubVendorNames } from "@rakazo/core";

export const THOUGHT_MAX_CHARS = 200;

// Vendor, protocol and plumbing words a user should never see in a thinking line.
const VENDOR_WORDS =
  /\b(?:Instantly(?:\.ai)?|Cal\.com|Calcom|Gmail|Google|Outlook|Microsoft|Slack|Notion|Linear|LinkedIn|OpenAI|Codex|Anthropic|Claude|GPT[\w.-]*|MCP|APIs?|SDK|JSON|HTTPS?|URLs?|endpoints?|webhooks?|tokens?|Prisma|Postgres|SQL)\b/gi;
// Opaque identifiers: uuids, cuids, and long digit-bearing tokens.
const ID_TOKENS =
  /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[a-z0-9]{20,}|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]{7,})\b/g;
const MCP_TOOL_NAMES = /\bmcp__[\w-]+__[\w-]+\b/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One user-safe thinking line (≤200 chars): first line of the model's reasoning summary or
 * a tool-intent description, with tool names, ids and vendor names removed.
 */
export function sanitizeThought(raw: string, toolNames: Iterable<string> = []): string {
  let text = raw.replace(MCP_TOOL_NAMES, " ");
  for (const name of toolNames) {
    if (name) text = text.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"), " ");
  }
  text = text.replace(/[*_`#>]+/g, " ").replace(VENDOR_WORDS, " ");
  text = scrubVendorNames(text).replace(ID_TOKENS, " ");
  const line =
    text
      .split(/\r?\n/)
      .map((part) =>
        part
          .replace(/\s+/g, " ")
          .replace(/\s+([,.;:!?)])/g, "$1")
          .replace(/\(\s*[,;:]*\s*\)/g, "")
          .replace(/^[\s,.;:!?-]+|[\s,;:-]+$/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((part) => part.length >= 3) ?? "";
  return line.length > THOUGHT_MAX_CHARS ? `${line.slice(0, THOUGHT_MAX_CHARS - 1)}…` : line;
}
