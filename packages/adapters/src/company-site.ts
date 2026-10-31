import { JSDOM } from "jsdom";
import { BUSY, concurrencyLimit, faviconDataUrl } from "./favicon.js";
import type { ResolveHostname } from "./network-address.js";
import { fetchSafeWebBytes } from "./web-ssrf.js";

const PAGE_MAX_BYTES = 128 * 1024;
const LOGO_MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 4_000;
const LOOKUP_DEADLINE_MS = 10_000;
const MAX_CONCURRENT = 6;
// A results table asks for a few dozen names at once; they wait their turn instead of failing.
const MAX_WAITING = 64;
const MAX_WAIT_MS = 15_000;
const MAX_CACHED_NAMES = 5_000;
// A found logo is kept a year; organizations rarely change it.
const FOUND_TTL_MS = 365 * 24 * 60 * 60 * 1000;
// Two days; organization-logos.ts tells older three-day misses apart by it.
const MISSING_TTL_MS = 2 * 24 * 60 * 60 * 1000;
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

/**
 * `host` is the organization's own site host, or null when none could be confirmed. `icon` is its
 * logo from the organization index as a small data URL, when the index has one.
 */
export type CompanySiteAnswer = { host: string | null; icon?: string; retry?: true };
export type Found = { host: string | null; icon?: string; unsure?: true };

export type CompanySiteResolver = {
  companySite(name: string): Promise<CompanySiteAnswer>;
};

/** Organizations matching a name: each one's own website, indexed name and logo image, if any. */
export type OrganizationSearch = (
  name: string,
  signal: AbortSignal,
) => Promise<{ url: string; title: string; image?: string }[]>;

export type CompanySiteResolverOptions = {
  fetch?: typeof globalThis.fetch;
  /** Asked first; the likely domains for the name are tried only when it confirms no site. */
  searchOrganizations?: OrganizationSearch;
  resolveHostname?: ResolveHostname;
  now?: () => number;
  /** Lasting answers shared across processes and deploys, read before any lookup. */
  store?: OrganizationLogoStore;
};

/** Where found logos (and confirmed misses) are kept beyond this process. */
export type OrganizationLogoStore = {
  get(key: string): Promise<(Found & { expiresAt: number }) | null>;
  put(key: string, found: Found, expiresAt: number): Promise<void>;
};

/**
 * Finds an organization's own website from its name, so its logo can be its site icon without a
 * third-party logo service. An organization index is asked first and its answer is kept only when
 * the indexed name matches; otherwise the likely domains for the name are tried, and a site is
 * accepted only when its own page title names the organization. Anything uncertain stays without
 * a logo.
 * Every fetch goes through the SSRF-checked fetcher, and answers are cached per name, misses too.
 */
export function createCompanySiteResolver(
  options: CompanySiteResolverOptions = {},
): CompanySiteResolver {
  const now = options.now ?? Date.now;
  const cache = new Map<string, Found & { expiresAt: number }>();
  const inFlight = new Map<string, Promise<CompanySiteAnswer>>();
  const limit = concurrencyLimit(MAX_CONCURRENT, MAX_WAITING, MAX_WAIT_MS);
  const ttl = (found: Found) => (found.host || found.icon ? FOUND_TTL_MS : MISSING_TTL_MS);
  const remember = (key: string, found: Found, expiresAt = now() + ttl(found)) => {
    cache.delete(key);
    cache.set(key, { host: found.host, ...(found.icon ? { icon: found.icon } : {}), expiresAt });
    while (cache.size > MAX_CACHED_NAMES) cache.delete(cache.keys().next().value!);
  };
  const answerOf = (found: Found): CompanySiteAnswer => ({
    host: found.host,
    ...(found.icon ? { icon: found.icon } : {}),
  });
  const resolve = async (key: string, tokens: string[]): Promise<CompanySiteAnswer> => {
    // A saved answer survives deploys; a store failure only means looking it up again.
    const stored = await options.store?.get(key).catch(() => null);
    if (stored && stored.expiresAt > now()) {
      remember(key, stored, stored.expiresAt);
      return answerOf(stored);
    }
    const found = await limit(() =>
      findCompanySite(tokens, options, AbortSignal.timeout(LOOKUP_DEADLINE_MS)).catch(() => null),
    );
    // Turned away by a full queue is not a miss: not remembered, and the client asks again.
    if (found === BUSY) return { host: null, retry: true };
    const answer = found ?? { host: null, unsure: true as const };
    // The index could not answer (rate limit, timeout): the page asks again shortly instead of
    // showing initials, and nothing is remembered.
    if (answer.unsure) return { host: null, retry: true };
    remember(key, answer);
    await options.store?.put(key, answerOf(answer), now() + ttl(answer)).catch(() => undefined);
    return answerOf(answer);
  };
  return {
    async companySite(name) {
      const tokens = companyTokens(name);
      if (!tokens.length) return { host: null };
      const key = tokens.join(" ");
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return answerOf(cached);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const lookup = resolve(key, tokens).finally(() => inFlight.delete(key));
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
): Promise<Found> {
  const indexed = options.searchOrganizations
    ? await indexedSite(options.searchOrganizations, tokens, signal)
    : null;
  if (indexed && indexed !== UNANSWERED) {
    // Some sites turn away the icon lookup, so the index's own logo is kept when it has one.
    const icon = indexed.image ? await indexLogo(indexed.image, options, signal) : null;
    if (indexed.host || icon) return { host: indexed.host, ...(icon ? { icon } : {}) };
  }
  const unsure = indexed === UNANSWERED || (indexed !== null && !indexed.host);
  for (const host of companySiteCandidates(tokens)) {
    if (signal.aborted) return { host: null };
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
    return { host: new URL(page.url).hostname.replace(/^www\./, "") };
  }
  return { host: null, ...(unsure ? { unsure: true as const } : {}) };
}

/** The index's logo image as a small data URL; any failure leaves the site icon to the client. */
async function indexLogo(
  url: string,
  options: CompanySiteResolverOptions,
  signal: AbortSignal,
): Promise<string | null> {
  const image = await fetchSafeWebBytes(url, {
    fetch: options.fetch,
    resolveHostname: options.resolveHostname,
    signal,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: 3,
    allowedPorts: [443],
    maxBytes: LOGO_MAX_BYTES,
    headers: { accept: "image/*" },
  }).catch(() => undefined);
  return image ? faviconDataUrl(image.body).catch(() => null) : null;
}

/** Directories and profile sites that describe an organization but are not its own site. */
const NOT_OWN_SITE =
  /(?:^|\.)(?:linkedin\.com|wikipedia\.org|facebook\.com|crunchbase\.com|zoominfo\.com|bloomberg\.com|glassdoor\.com|indeed\.com|x\.com|twitter\.com|instagram\.com|youtube\.com|exa\.ai)$/;

const UNANSWERED = Symbol("unanswered");
const INDEX_RETRIES = 2;

/**
 * The indexed organization with this name: its own site host, or null when the index lists only a
 * social or directory page for it (common for student groups and small orgs), and its logo image.
 * The index's logo is kept either way, since it is the organization's own profile logo.
 */
async function indexedSite(
  search: OrganizationSearch,
  tokens: readonly string[],
  signal: AbortSignal,
): Promise<{ host: string | null; image?: string } | null | typeof UNANSWERED> {
  if (tokens.length === 1 && GENERIC_WORDS.has(tokens[0]!)) return null;
  let results: Awaited<ReturnType<OrganizationSearch>>;
  for (let attempt = 0; ; attempt += 1) {
    try {
      results = await search(tokens.join(" "), signal);
      break;
    } catch {
      // A busy index (many names at once) usually answers a moment later.
      if (attempt >= INDEX_RETRIES || signal.aborted) return UNANSWERED;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  let logoOnly: { host: null; image: string } | null = null;
  for (const { url, title, image } of results) {
    if (!sameName(title, tokens)) continue;
    const host = URL.canParse(url) ? new URL(url).hostname.replace(/^www\./, "") : "";
    if (host && !NOT_OWN_SITE.test(host)) return { host, ...(image ? { image } : {}) };
    logoOnly ??= image ? { host: null, image } : null;
  }
  return logoOnly;
}

/** Whether an indexed name is the searched name, ignoring case, accents and legal suffixes. */
function sameName(title: string, tokens: readonly string[]): boolean {
  return companyTokens(title).join(" ") === tokens.join(" ");
}
