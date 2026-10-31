import type { PageReader } from "./keyless-http-web.js";

const ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_fetch_exa";

/**
 * Reads a page through the platform people-search provider's page reader, for pages that refuse
 * a plain request, such as a LinkedIn profile. Works keyless at a lower rate limit.
 */
export function createExaPageReader(
  options: { fetch?: typeof globalThis.fetch; apiKey?: string } = {},
): PageReader {
  const fetch = options.fetch ?? globalThis.fetch;
  return async (url, maxChars, signal) => {
    const apiKey = options.apiKey ?? process.env.EXA_API_KEY?.trim();
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "web_fetch_exa", arguments: { urls: [url], maxCharacters: maxChars } },
      }),
    });
    if (!response.ok) throw new Error(`page reader failed: HTTP ${response.status}`);
    return readerPage(await response.text(), url);
  };
}

/** The page in a reader response: "# Title\nURL: …\n…" as JSON or one SSE message. */
export function readerPage(
  body: string,
  url: string,
): { url: string; title: string; text: string } {
  const json = body.trimStart().startsWith("{")
    ? body
    : body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5);
  if (!json) throw new Error("page reader returned nothing");
  const result = JSON.parse(json)?.result;
  const text = result?.content?.find((item: { type?: string }) => item.type === "text")?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("page reader returned no text");
  // A page it can't read is an error, such as a profile that does not exist.
  if (result?.isError) throw new Error(text.slice(0, 300));
  const lines = text.split("\n");
  const title = /^#\s+(.+)$/.exec(lines[0] ?? "")?.[1]?.trim() ?? "";
  const pageUrl = /^URL:\s*(\S+)/.exec(lines[1] ?? "")?.[1] ?? url;
  return { url: pageUrl, title, text: text.trim() };
}
