// Text patterns for ui-regressions.mjs, kept apart so they can be tested offline.
// A mixed-case or letter-digit token of 5–8 characters with no vowel pattern a word would have:
// "YaUqUV", "TyELq2", "3qtlhN". Ordinary words and names ("Google", "Atlanta") do not match.
export const RAW_ID =
  /^(?=.{5,8}$)[A-Za-z0-9]*(?:[a-z][A-Z]|[A-Z]{2}[a-z]|\d[A-Za-z]|[A-Za-z]\d)[A-Za-z0-9]*$/;
export const SUPPLIER =
  /\b(?:exa|coresignal|fullenrich|contactout|leadmagic|instantly|composio|juicebox|serper)\b/i;
export const TOOL_NAME =
  /\b(?:agent_run|ask_user|delegate_to_role|handoff_to_bot|start_role|search_history|recruiting_[a-z_]+|mcp__\w+|work_estimate)\b/;
/** The strings on a page that look like raw IDs: short chips, buttons and links only. */
// CamelCase words and brands ("LinkedIn", "iPhone", "GitHub") are words, not IDs.
const CAMEL_WORD = /^[a-z]*(?:[A-Z][a-z]+)+$/;
export function rawIds(texts) {
  return [
    ...new Set(
      texts
        .map((text) => text.trim())
        .filter((text) => RAW_ID.test(text) && !CAMEL_WORD.test(text)),
    ),
  ];
}
