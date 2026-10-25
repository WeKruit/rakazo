import type { MessageBlock } from "@rakazo/contracts";

/**
 * Sourcing, enrichment and outreach vendors a recruiter must never see named in chat.
 * Each maps to the business word the recruiter knows. The connect card is the one place a
 * provider is named on purpose, so connect blocks are never touched.
 */
const VENDORS: ReadonlyArray<{ pattern: string; zh: string; en: string }> = [
  { pattern: "Autumn", zh: "搜寻", en: "search" },
  { pattern: "Core\\s?[Ss]ignal", zh: "人才资料库", en: "profile data" },
  { pattern: "Serper", zh: "搜寻", en: "search" },
  { pattern: "Firecrawl", zh: "搜寻", en: "search" },
  { pattern: "Exa(?:\\.ai)?", zh: "搜寻", en: "search" },
  { pattern: "People\\s?Data\\s?Labs|PDL", zh: "人才资料库", en: "profile data" },
  { pattern: "Contact\\s?[Oo]ut", zh: "联系方式补全", en: "contact lookup" },
  { pattern: "Lead\\s?[Mm]agic", zh: "联系方式补全", en: "contact lookup" },
  { pattern: "Full\\s?[Ee]nrich", zh: "联系方式补全", en: "contact lookup" },
  { pattern: "Lusha", zh: "联系方式补全", en: "contact lookup" },
  { pattern: "Rocket\\s?[Rr]each", zh: "联系方式补全", en: "contact lookup" },
  { pattern: "Instantly(?:\\.ai)?(?!,)", zh: "邮件活动", en: "email campaign" },
  { pattern: "Composio", zh: "集成", en: "integration" },
];

const CJK = "\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef";
const HAS_CJK = new RegExp(`[${CJK}]`);
// Case-sensitive on purpose: "autumn" the season stays; vendor names are written capitalized.
// Possessive 's goes with the name; spaces next to Chinese text go too, so
// "同一个 Autumn 任务" reads "同一个搜寻任务".
const RULES = VENDORS.map((vendor) => ({
  ...vendor,
  re: new RegExp(
    `(?:(?<=[${CJK}])\\s+)?(?<![\\w.@/-])(?:${vendor.pattern})(?:['’]s)?(?![\\w@/-]|\\.[a-z])(?:\\s+(?=[${CJK}]))?`,
    "g",
  ),
}));

/** Replaces vendor names with the recruiter's business word, in the text's own language. */
export function scrubVendorNames(text: string): string {
  if (!text) return text;
  const zh = HAS_CJK.test(text);
  let out = text;
  for (const rule of RULES) out = out.replace(rule.re, zh ? rule.zh : rule.en);
  return out;
}

/** Same scrub on the human-readable fields of chat blocks; approval-bound asks stay byte-exact. */
export function scrubVendorBlocks<T extends MessageBlock>(blocks: readonly T[]): T[] {
  return blocks.map((block) => {
    switch (block.kind) {
      case "text":
      case "meta":
        return { ...block, text: scrubVendorNames(block.text) };
      case "ask":
        return block.approvalEffectId || block.approvalEvidenceHash
          ? block
          : {
              ...block,
              text: scrubVendorNames(block.text),
              ...(block.detail ? { detail: scrubVendorNames(block.detail) } : {}),
            };
      case "card":
        return {
          ...block,
          lines: block.lines.map((line) => ({ ...line, v: scrubVendorNames(line.v) })),
        };
      case "choice":
        return {
          ...block,
          question: scrubVendorNames(block.question),
          ...(block.subtitle ? { subtitle: scrubVendorNames(block.subtitle) } : {}),
          options: block.options.map((option) => ({
            ...option,
            label: scrubVendorNames(option.label),
          })),
        };
      default:
        return block;
    }
  });
}
