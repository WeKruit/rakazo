import { JSDOM } from "jsdom";
import type { ResolveHostname } from "./network-address.js";
import { fetchSafeWebBytes } from "./web-ssrf.js";

const PAGE_MAX_BYTES = 128 * 1024;
const FETCH_TIMEOUT_MS = 4_000;
const LOOKUP_DEADLINE_MS = 10_000;
const MAX_CONCURRENT = 4;
const MAX_CACHED_NAMES = 5_000;
const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const LEGAL_SUFFIXES = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "plc",
  "pbc",
  "sa",
  "ag",
  "bv",
  "holdings",
]);
/** Words that name a kind of organization, not one organization, so they never stand alone. */
const GENERIC_WORDS = new Set([
  "the",
  "university",
  "college",
  "school",
  "institute",
  "academy",
  "stealth",
  "self",
  "freelance",
  "independent",
  "confidential",
  "other",
  "group",
  "global",
  "international",
  "national",
  "american",
  "united",
  "general",
  "research",
  "labs",
  "health",
  "bank",
  "capital",
  "partners",
  "ventures",
  "consulting",
  "solutions",
  "services",
  "systems",
  "technologies",
  "technology",
  "digital",
  "studio",
  "studios",
  "media",
  "data",
]);
const PARKED =
  /\b(?:for sale|buy this domain|domain (?:is )?(?:for sale|parked|available)|parked|coming soon|under construction|godaddy|sedo|afternic|dan\.com|hugedomains)\b/i;

/** `host` is the organization's own site host, or null when none could be confirmed. */
export type CompanySiteAnswer = { host: string | null; retry?: true };

export type CompanySiteResolver = {
  companySite(name: string): Promise<CompanySiteAnswer>;
};

export type CompanySiteResolverOptions = {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  now?: () => number;
};

/**
 * Finds an organization's own website from its name, so its logo can be its site icon without a
 * third-party logo service. Only the likely domains for the name are tried, and a site is accepted
 * only when its own page title names the organization; anything uncertain stays without a logo.
 * Every fetch goes through the SSRF-checked fetcher, and answers are cached per name, misses too.
 */
export function createCompanySiteResolver(
  options: CompanySiteResolverOptions = {},
): CompanySiteResolver {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { host: string | null; expiresAt: number }>();
  const inFlight = new Map<string, Promise<CompanySiteAnswer>>();
  let active = 0;
  const remember = (key: string, host: string | null) => {
    cache.delete(key);
    cache.set(key, { host, expiresAt: now() + (host ? FOUND_TTL_MS : MISSING_TTL_MS) });
    while (cache.size > MAX_CACHED_NAMES) cache.delete(cache.keys().next().value!);
  };
  return {
    async companySite(name) {
      const tokens = companyTokens(name);
      if (!tokens.length) return { host: null };
      const key = tokens.join(" ");
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return { host: cached.host };
      const pending = inFlight.get(key);
      if (pending) return pending;
      if (active >= MAX_CONCURRENT) return { host: null, retry: true };
      active += 1;
      const lookup = findCompanySite(tokens, options, AbortSignal.timeout(LOOKUP_DEADLINE_MS))
        .catch(() => null)
        .then((host): CompanySiteAnswer => {
          remember(key, host);
          return { host };
        })
        .finally(() => {
          active -= 1;
          inFlight.delete(key);
        });
      inFlight.set(key, lookup);
      return lookup;
    },
  };
}

/** The name's words, lower case and unaccented, without legal suffixes or punctuation. */
export function companyTokens(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80 || /^[0-9a-f-]{20,}$/i.test(trimmed)) return [];
  const words = trimmed
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word && word !== "and");
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1)!)) words.pop();
  return words;
}

/** Likely own domains for a name, most specific first. */
export function companySiteCandidates(tokens: readonly string[]): string[] {
  if (!tokens.length || tokens.length > 5) return [];
  const joined = tokens.join("");
  if (joined.length < 2 || joined.length > 40) return [];
  const hosts = [`${joined}.com`, `${joined}.ai`, `${joined}.io`];
  const first = tokens[0]!;
  if (tokens.length > 1 && first.length >= 4 && !GENERIC_WORDS.has(first))
    hosts.push(`${first}.com`);
  if (tokens.length === 1 && GENERIC_WORDS.has(first)) return [];
  return hosts;
}

/** Whether a page title names the organization, by its whole name or its distinctive first word. */
export function titleNamesCompany(title: string, tokens: readonly string[]): boolean {
  if (!title || PARKED.test(title)) return false;
  const text = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (text.includes(tokens.join(""))) return true;
  const first = tokens[0]!;
  return (
    tokens.length > 1 && first.length >= 4 && !GENERIC_WORDS.has(first) && text.includes(first)
  );
}

function pageNames(html: string): string {
  const document = JSDOM.fragment(html);
  const meta = (selector: string) =>
    document.querySelector(selector)?.getAttribute("content")?.trim() ?? "";
  return [
    document.querySelector("title")?.textContent?.trim() ?? "",
    meta('meta[property="og:site_name"]'),
    meta('meta[name="application-name"]'),
  ]
    .filter(Boolean)
    .join(" | ");
}

async function findCompanySite(
  tokens: readonly string[],
  options: CompanySiteResolverOptions,
  signal: AbortSignal,
): Promise<string | null> {
  for (const host of companySiteCandidates(tokens)) {
    if (signal.aborted) return null;
    const page = await fetchSafeWebBytes(`https://${host}/`, {
      fetch: options.fetch,
      resolveHostname: options.resolveHostname,
      signal,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxRedirects: 3,
      allowedPorts: [443],
      maxBytes: PAGE_MAX_BYTES,
      truncate: true,
      headers: { accept: "text/html" },
    }).catch(() => undefined);
    if (!page) continue;
    const names = pageNames(new TextDecoder().decode(page.body));
    if (!titleNamesCompany(names, tokens)) continue;
    // A redirect lands on the organization's canonical site (x.com to www.x.com, say).
    return new URL(page.url).hostname.replace(/^www\./, "");
  }
  return null;
}
