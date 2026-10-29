import type { OrganizationSearch } from "./company-site.js";

const ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa";
const RESULTS = 3;

/**
 * Looks an organization up by name through the platform people-search provider's company index,
 * which returns the organization's own website. Works keyless at a lower rate limit.
 */
export function createExaOrganizationSearch(
  options: { fetch?: typeof globalThis.fetch; apiKey?: string } = {},
): OrganizationSearch {
  const fetch = options.fetch ?? globalThis.fetch;
  return async (name, signal) => {
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
        params: {
          name: "web_search_advanced_exa",
          arguments: {
            query: name,
            category: "company",
            numResults: RESULTS,
            textMaxCharacters: 1,
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`organization search failed: ${response.status}`);
    return organizationResults(await response.text());
  };
}

/** The `{url, title}` results in a tool-call response, sent as JSON or as one SSE message. */
export function organizationResults(body: string): { url: string; title: string }[] {
  const json = body.trimStart().startsWith("{")
    ? body
    : body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5);
  if (!json) return [];
  const text = JSON.parse(json)?.result?.content?.find(
    (item: { type?: string }) => item.type === "text",
  )?.text;
  if (typeof text !== "string") return [];
  const results: unknown = JSON.parse(text)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((result) => {
    const url = typeof result?.url === "string" ? result.url : "";
    const named = result?.entities?.[0]?.properties?.name;
    const title = typeof named === "string" && named ? named : String(result?.title ?? "");
    return url && title ? [{ url, title }] : [];
  });
}
