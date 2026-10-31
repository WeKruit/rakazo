import { Readability } from "@mozilla/readability";
import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";
import { JSDOM } from "jsdom";
import { clampMaxChars, clampMaxResults } from "./web-limits.js";
import { fetchSafeWebText, type ResolveHostname } from "./web-ssrf.js";

export {
  clampMaxChars,
  clampMaxResults,
  DEFAULT_WEB_FETCH_MAX_CHARS,
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  MAX_WEB_FETCH_MAX_CHARS,
  MAX_WEB_SEARCH_RESULTS,
  MIN_WEB_FETCH_MAX_CHARS,
} from "./web-limits.js";

const DEFAULT_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";

export type KeylessHtmlSearchBackend = {
  id: string;
  endpoint: string;
  parse(html: string, maxResults: number): WebSearchHit[];
};

export type KeylessHttpWebOptions = {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  searchBackend?: KeylessHtmlSearchBackend;
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
  maxBufferBytes?: number;
  userAgent?: string;
  /** Reads a page that refuses a plain request (a sign-in wall such as LinkedIn's). */
  pageReader?: PageReader;
};

/** Reads one page elsewhere and returns its text, already limited to maxChars. */
export type PageReader = (
  url: string,
  maxChars: number,
  signal?: AbortSignal,
) => Promise<{ url: string; title: string; text: string }>;

/** Statuses a site answers a plain request with when it wants a signed-in browser. */
const REFUSED = /^Request failed: HTTP (401|403|429|451|999)$/;

/** HTML search backend using DuckDuckGo’s public HTML form. One keyless option, not the interface. */
export const duckDuckGoHtmlSearchBackend: KeylessHtmlSearchBackend = {
  id: "duckduckgo-html",
  endpoint: DEFAULT_SEARCH_ENDPOINT,
  parse: parseDuckDuckGoResults,
};

/**
 * Keyless HTTP web search + page fetch. No API key, no sandbox, no JS execution.
 * Search uses a pluggable HTML backend (default: DuckDuckGo HTML). Fetch uses
 * Mozilla Readability with a lightweight HTML-strip fallback.
 */
export class KeylessHttpWebProvider implements WebProvider {
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly resolveHostname?: ResolveHostname;
  private readonly searchBackend: KeylessHtmlSearchBackend;
  private readonly searchTimeoutMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly userAgent: string;
  private readonly pageReader?: PageReader;

  constructor(options: KeylessHttpWebOptions = {}) {
    this.fetchImpl = options.fetch;
    this.resolveHostname = options.resolveHostname;
    this.searchBackend = options.searchBackend ?? duckDuckGoHtmlSearchBackend;
    this.searchTimeoutMs = options.searchTimeoutMs ?? 15_000;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 15_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 5 * 1024 * 1024;
    this.userAgent =
      options.userAgent ?? "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)";
    this.pageReader = options.pageReader;
  }

  describe() {
    return {
      id: "keyless-http",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        search: true,
        fetch: true,
        keyless: true,
        native: false,
        readability: true,
      },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    const maxResults = clampMaxResults(request.maxResults);
    const searchUrl = new URL(this.searchBackend.endpoint);
    searchUrl.searchParams.set("q", query);
    const { body } = await fetchSafeWebText(searchUrl.href, {
      fetch: this.fetchImpl,
      resolveHostname: this.resolveHostname,
      timeoutMs: this.searchTimeoutMs,
      maxBytes: 1024 * 1024,
      userAgent: this.userAgent,
      signal: request.signal ?? context.signal,
    });
    return this.searchBackend.parse(body, maxResults);
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const maxChars = clampMaxChars(request.maxChars);
    const signal = request.signal ?? context.signal;
    let page: { url: string; body: string };
    try {
      page = await fetchSafeWebText(request.url, {
        fetch: this.fetchImpl,
        resolveHostname: this.resolveHostname,
        timeoutMs: this.fetchTimeoutMs,
        maxBytes: this.maxBufferBytes,
        userAgent: this.userAgent,
        signal,
      });
    } catch (error) {
      // Only a page the site refused goes to the reader; a private or invalid URL never does.
      if (!this.pageReader || !REFUSED.test(error instanceof Error ? error.message : ""))
        throw error;
      const read = await this.pageReader(request.url, maxChars, signal);
      const truncated = read.text.length >= maxChars;
      return { ...read, text: read.text.slice(0, maxChars), truncated };
    }
    const { url, body } = page;
    if (!body.trim()) throw new Error(`Failed to fetch content from ${url}`);
    const extracted = extractReadableText(body, url);
    const truncated = extracted.text.length > maxChars;
    return {
      url,
      title: extracted.title,
      text: truncated
        ? `${extracted.text.slice(0, maxChars)}\n\n[Content truncated]`
        : extracted.text,
      truncated,
    };
  }
}

export function parseDuckDuckGoResults(html: string, maxResults: number): WebSearchHit[] {
  const dom = new JSDOM(html, { url: DEFAULT_SEARCH_ENDPOINT });
  const document = dom.window.document;
  const results: WebSearchHit[] = [];

  for (const node of Array.from(document.querySelectorAll(".result"))) {
    const link = node.querySelector("a.result__a");
    if (!link) continue;
    const title = normalizeWhitespace(link.textContent ?? "");
    let url: string;
    try {
      url = unwrapDuckDuckGoUrl(link.getAttribute("href") ?? "");
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      url = parsed.href;
    } catch {
      continue;
    }
    const snippet = normalizeWhitespace(node.querySelector(".result__snippet")?.textContent ?? "");
    if (title && url) results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, DEFAULT_SEARCH_ENDPOINT);
    const target = parsed.searchParams.get("uddg");
    if (target) return target;
    return parsed.href;
  } catch {
    return rawUrl;
  }
}

export function htmlToPlainText(html: string): string {
  const content = JSDOM.fragment(html);
  for (const node of content.querySelectorAll("script,style,noscript,template,title"))
    node.remove();
  for (const node of content.querySelectorAll("a[href]")) {
    const url = URL.parse(node.getAttribute("href") ?? "");
    if (
      url &&
      ["http:", "https:", "mailto:"].includes(url.protocol) &&
      URL.parse(node.textContent?.trim() ?? "")?.href !== url.href
    )
      node.append(` (${url.href})`);
  }
  for (const node of content.querySelectorAll("br")) node.replaceWith("\n");
  for (const node of content.querySelectorAll("p,li,div,h1,h2,h3,h4,h5,h6,blockquote,tr")) {
    node.prepend("\n");
    node.append("\n");
  }
  for (const node of content.querySelectorAll("td,th")) node.append("\t");
  return normalizeArticleText(content.textContent ?? "");
}

export function extractReadableText(html: string, url: string): { title: string; text: string } {
  try {
    const document = new JSDOM(html, { url }).window.document;
    const postings: Record<string, unknown>[] = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data: unknown;
      try {
        data = JSON.parse(script.textContent ?? "");
      } catch {
        continue;
      }
      for (const root of Array.isArray(data) ? data : [data]) {
        if (!root || typeof root !== "object" || Array.isArray(root)) continue;
        for (const item of [root, ...(Array.isArray(root["@graph"]) ? root["@graph"] : [])]) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const context = item["@context"] ?? root["@context"];
          const schemaContext = [
            "https://schema.org",
            "https://schema.org/",
            "http://schema.org",
            "http://schema.org/",
          ].includes(context);
          const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
          if (
            types.some(
              (type: unknown) =>
                (schemaContext && type === "JobPosting") ||
                type === "https://schema.org/JobPosting" ||
                type === "http://schema.org/JobPosting",
            )
          )
            postings.push(item);
        }
      }
    }
    // ponytail: only extract a unique posting; multi-job pages need explicit identity matching.
    const posting = postings.length === 1 ? postings[0] : undefined;
    if (
      posting &&
      typeof posting.description === "string" &&
      (posting.url === undefined ||
        (typeof posting.url === "string" && new URL(posting.url, url).href === new URL(url).href))
    ) {
      const content = JSDOM.fragment(posting.description);
      for (const node of content.querySelectorAll("script,style,noscript")) node.remove();
      for (const node of content.querySelectorAll("br")) node.replaceWith("\n");
      for (const node of content.querySelectorAll("p,li,div,h1,h2,h3,h4,h5,h6")) node.append("\n");
      const text = normalizeArticleText(content.textContent ?? "");
      if (text) {
        const { description: _description, ...metadata } = posting;
        return {
          title:
            typeof posting.title === "string" && posting.title.trim()
              ? posting.title.trim()
              : document.title.trim() || "Untitled",
          text: [text, JSON.stringify(metadata, null, 2)].join("\n\n"),
        };
      }
    }
  } catch {
    // Unrecognized structured data leaves the existing readable HTML path unchanged.
  }
  const readable = extractWithReadability(html, url);
  if (readable) return readable;
  return stripHtmlFallback(html);
}

function extractWithReadability(html: string, url: string): { title: string; text: string } | null {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (article?.textContent && article.textContent.length > 0) {
      return {
        title: article.title?.trim() || "Untitled",
        text: normalizeArticleText(article.textContent),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function stripHtmlFallback(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = normalizeWhitespace(titleMatch?.[1] ?? "") || "Untitled";
  const text = normalizeArticleText(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " "),
  );
  return { title, text };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeArticleText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
