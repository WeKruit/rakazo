import type { MessageBlock } from "@rakazo/contracts";

/**
 * Provider names a recruiter never sees. The recruiter talks to one colleague, so a search,
 * profile-data or mail provider is described by what it does, never by its brand.
 * Connect cards are the one place a provider is named; they are not text and stay as they are.
 */
type HiddenVendor = {
  /** The brand with an optional domain/"AI" suffix and possessive. */
  pattern: RegExp;
  zh: string;
  en: string;
  /** Host fragments whose links are dropped from recruiter text. */
  hosts: readonly string[];
  /** What a connect card calls the service, e.g. "Connect Profile data". */
  label: string;
};

const POSSESSIVE = "(?:['’]s)?";

const HIDDEN_VENDORS: readonly HiddenVendor[] = [
  {
    // "Autumn" is also a first name and a season: only the capitalized brand counts, and not
    // when a capitalized surname follows it (a candidate called Autumn Lee keeps her name).
    pattern: new RegExp(
      `\\bAutumn(?:\\.ai|\\s+AI\\b)?${POSSESSIVE}(?!\\w|[.-]\\w)(?!\\s+(?!AI\\b|Task|Search|Research|Agent)[A-Z][a-z])`,
      "g",
    ),
    zh: "人才搜索",
    en: "the search",
    hosts: ["autumn"],
    label: "People search",
  },
  {
    pattern: new RegExp(
      `\\b(?:Coresignal|Core\\s+Signal|FullEnrich|Full\\s+Enrich|Juicebox|PeopleDataLabs|People\\s+Data\\s+Labs|Proxycurl|Crustdata|Apollo\\.io)${POSSESSIVE}(?!\\w|[.-]\\w)`,
      "gi",
    ),
    zh: "资料库",
    en: "profile data",
    hosts: [
      "coresignal",
      "fullenrich",
      "juicebox",
      "peopledatalabs",
      "proxycurl",
      "crustdata",
      "apollo.io",
    ],
    label: "Profile data",
  },
  {
    pattern: new RegExp(`\\bPDL${POSSESSIVE}(?!\\w|[.-]\\w)`, "g"),
    zh: "资料库",
    en: "profile data",
    hosts: [],
    label: "Profile data",
  },
  {
    pattern: new RegExp(
      `\\b(?:Contact\\s?Out|Lead\\s?Magic|Lusha|Rocket\\s?Reach)${POSSESSIVE}(?!\\w|[.-]\\w)`,
      "gi",
    ),
    zh: "联系方式补全",
    en: "contact lookup",
    hosts: ["contactout", "leadmagic", "lusha.com", "rocketreach"],
    label: "Contact lookup",
  },
  {
    pattern: new RegExp(`\\b(?:Serper|Firecrawl)(?:\\.dev)?${POSSESSIVE}(?!\\w|[.-]\\w)`, "gi"),
    zh: "搜索",
    en: "search",
    hosts: ["serper.dev", "firecrawl"],
    label: "People search",
  },
  {
    pattern: new RegExp(`\\bExa(?:\\.ai)?${POSSESSIVE}(?!\\w|[.-]\\w)`, "g"),
    zh: "搜索",
    en: "search",
    hosts: ["exa.ai"],
    label: "People search",
  },
  {
    pattern: new RegExp(`\\bInstantly(?:\\.ai)?${POSSESSIVE}(?!\\w|[.-]\\w)`, "g"),
    zh: "邮件",
    en: "email",
    hosts: ["instantly.ai"],
    label: "Email sending",
  },
  {
    pattern: new RegExp(`\\bComposio${POSSESSIVE}(?!\\w|[.-]\\w)`, "gi"),
    zh: "连接",
    en: "connection",
    hosts: ["composio"],
    label: "Integrations",
  },
];

const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;
const MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>()"'`\]]+/g;
const CLOUD_STORAGE =
  /(?:^|\.)(?:amazonaws\.com|storage\.googleapis\.com|cloudfront\.net|blob\.core\.windows\.net|r2\.dev|r2\.cloudflarestorage\.com|supabase\.co)$/;
const ZH_START = "\ue000";
const ZH_END = "\ue001";
const ZH_SPACING = /(\S?)([ \t]*)\ue000([^\ue001]*)\ue001([ \t]*)(?=(\S?))/g;

/** True when a link points at a hidden provider (its app, API or file storage). */
export function isVendorUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  // Shared file storage names the provider in the path (path-style buckets).
  const where = CLOUD_STORAGE.test(host) ? `${host}${parsed.pathname.toLowerCase()}` : host;
  return HIDDEN_VENDORS.some((vendor) => vendor.hosts.some((fragment) => where.includes(fragment)));
}

/**
 * Recruiter-safe text: provider brands become plain words in the text's language and provider
 * links are dropped (a markdown link keeps its label, an image disappears). Text without a
 * provider comes back unchanged.
 */
export function hideVendorNames(
  text: string,
  /** `chinese` and `before` (text already shown ahead of this piece) are for streamed pieces. */
  options: { chinese?: boolean; before?: string } = {},
): string {
  if (!text) return text;
  let out = text
    .replace(MARKDOWN_LINK, (whole, image: string, label: string, url: string) =>
      isVendorUrl(url) ? (image ? "" : label) : whole,
    )
    .replace(BARE_URL, (url) => (isVendorUrl(url) ? "" : url));
  const chinese = options.chinese ?? CJK.test(out);
  for (const vendor of HIDDEN_VENDORS) {
    vendor.pattern.lastIndex = 0;
    out = out.replace(vendor.pattern, (match: string, offset: number, whole: string) => {
      const possessive = /['’]s$/.test(match);
      if (chinese) return `${ZH_START}${vendor.zh}${possessive ? "的" : ""}${ZH_END}`;
      // After a determiner ("the existing Autumn rank order") the brand needs no article.
      const modifier =
        /\b(?:the|a|an|this|that|our|its|same|existing|current|original|each)\s+$/i.test(
          (options.before ?? "") + whole.slice(0, offset),
        );
      const en = modifier ? vendor.en.replace(/^the /, "") : vendor.en;
      const word = possessive ? `${en}'s` : en;
      const sentenceStart = /(?:^|[.!?\n]\s*|^\s*[-*]\s+)$/.test(
        (options.before ?? "") + whole.slice(0, offset),
      );
      return sentenceStart ? word[0]!.toUpperCase() + word.slice(1) : word;
    });
  }
  if (!chinese || !out.includes(ZH_START)) return out;
  // Chinese text needs no space around the replacement next to Chinese characters.
  return out.replace(
    ZH_SPACING,
    (_m, before: string, spaceBefore: string, word: string, spaceAfter: string, after: string) =>
      `${before}${before && !CJK.test(before) ? spaceBefore || " " : ""}${word}${
        after && !CJK.test(after) ? spaceAfter || " " : ""
      }`,
  );
}

// Up to three trailing ASCII words ("People Data Labs", "Autumn" + a surname) and any unclosed
// link stay buffered until the next chunk shows how they end.
const STREAM_TAIL = /(?<![\w./:'’-])(?:[A-Za-z0-9][\w.'’-]*[ \t]*){1,3}$|[ \t]+$/;

/**
 * Streaming form of {@link hideVendorNames}: holds back the trailing words and any unfinished
 * link so a brand split across chunks is still hidden.
 */
export function createVendorNameStream() {
  let buffer = "";
  let chinese = false;
  let before = "";
  const emit = (value: string) => {
    if (!value) return value;
    chinese ||= CJK.test(value);
    const out = hideVendorNames(value, { chinese, before });
    before = (before + value).slice(-8);
    return out;
  };
  return {
    push(chunk: string): string {
      buffer += chunk;
      let cut = buffer.length;
      const lastBreak = Math.max(buffer.lastIndexOf(" "), buffer.lastIndexOf("\n"));
      const link = Math.max(buffer.lastIndexOf("http"), buffer.lastIndexOf("["));
      if (link > lastBreak) cut = link;
      const tail = STREAM_TAIL.exec(buffer.slice(0, cut));
      if (tail) cut = tail.index;
      // Never cut through a brand already complete in the buffer.
      for (const vendor of HIDDEN_VENDORS) {
        for (const match of buffer.matchAll(vendor.pattern)) {
          if (match.index < cut && match.index + match[0].length > cut) cut = match.index;
        }
      }
      const ready = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      return emit(ready);
    },
    finish(): string {
      const rest = buffer;
      buffer = "";
      return emit(rest);
    },
  };
}

/** Bots provisioned by the recruiting product carry this spawn-key prefix. */
export function isRecruitingSpawnKey(spawnKey: string | null | undefined): boolean {
  return Boolean(spawnKey?.startsWith("recruiting:"));
}

/**
 * {@link hideVendorNames} over the readable fields of chat blocks. Approval cards stay
 * byte-exact (their text is bound evidence); connect cards name what the service does.
 */
export function hideVendorBlocks<T extends MessageBlock>(blocks: readonly T[]): T[] {
  return blocks.map((block): T => {
    switch (block.kind) {
      case "text":
      case "meta":
        return { ...block, text: hideVendorNames(block.text) };
      case "ask":
        if (block.connection) return recruiterConnectBlock(block) as T;
        if (block.approvalEffectId || block.approvalEvidenceHash) return block;
        return {
          ...block,
          text: hideVendorNames(block.text),
          ...(block.detail ? { detail: hideVendorNames(block.detail) } : {}),
          ...(block.actions
            ? {
                actions: block.actions.map((action) => ({
                  ...action,
                  label: hideVendorNames(action.label),
                })),
              }
            : {}),
        };
      case "card":
        return {
          ...block,
          lines: block.lines.map((line) => ({ ...line, v: hideVendorNames(line.v) })),
        };
      case "choice":
        return {
          ...block,
          question: hideVendorNames(block.question),
          ...(block.subtitle ? { subtitle: hideVendorNames(block.subtitle) } : {}),
          options: block.options.map((option) => ({
            ...option,
            label: hideVendorNames(option.label),
          })),
        };
      case "subagent":
        return {
          ...block,
          task: hideVendorNames(block.task),
          ...(block.progress ? { progress: hideVendorNames(block.progress) } : {}),
          ...(block.result ? { result: hideVendorNames(block.result) } : {}),
        };
      default:
        return block;
    }
  });
}

/**
 * A connect card's service name for a recruiter: a hidden provider becomes what it does
 * (Coresignal → Profile data); the user's own accounts (Gmail, a calendar) keep their names.
 */
export function vendorNeutralServiceName(name: string): string {
  for (const vendor of HIDDEN_VENDORS) {
    vendor.pattern.lastIndex = 0;
    if (vendor.pattern.test(name.trim())) {
      vendor.pattern.lastIndex = 0;
      return vendor.label;
    }
  }
  return name;
}

/** A recruiter's connect card names what the service does, not its brand. */
export function recruiterConnectBlock<
  T extends { text: string; connection?: { name: string; reason: string } },
>(block: T): T {
  if (!block.connection) return block;
  const name = vendorNeutralServiceName(block.connection.name);
  if (name === block.connection.name) return block;
  return {
    ...block,
    text: `Connect ${name}`,
    connection: {
      ...block.connection,
      name,
      reason: SERVICE_PURPOSE[name] ?? hideVendorNames(block.connection.reason),
    },
  };
}

const SERVICE_PURPOSE: Record<string, string> = {
  "People search": "Used to search for candidates for this role.",
  "Profile data": "Used to fill in candidates' full experience, education and company details.",
  "Contact lookup": "Used to find candidates' contact details.",
  "Email sending": "Used to send and read emails with candidates.",
  Integrations: "Used to connect the services this work needs.",
};
