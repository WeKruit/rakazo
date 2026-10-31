import { describe, expect, it, vi } from "vitest";
import { createExaOrganizationSearch, organizationResults } from "./exa-organization-search.js";

const payload = (results: unknown[]) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify({ results }) }] },
  });

describe("organization search", () => {
  it("reads sites from an SSE tool result, preferring the indexed organization name", () => {
    const body = `event: message\ndata: ${payload([
      {
        url: "https://www.example.com/",
        title: "Example | Home",
        image: "https://logos.example/example.png",
        entities: [{ properties: { name: "Example Corp" } }],
      },
      { url: "https://other.example/", title: "Other" },
      { title: "No url" },
    ])}\n\n`;
    expect(organizationResults(body)).toEqual([
      {
        url: "https://www.example.com/",
        title: "Example Corp",
        image: "https://logos.example/example.png",
      },
      { url: "https://other.example/", title: "Other" },
    ]);
  });

  it("treats an error answer as unanswered, not as no organization", () => {
    expect(() =>
      organizationResults(
        JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "429" }] } }),
      ),
    ).toThrow();
    expect(() => organizationResults(JSON.stringify({ error: { code: -32000 } }))).toThrow();
    expect(organizationResults(payload([]))).toEqual([]);
  });

  it("asks for companies by name and sends the deployment key when there is one", async () => {
    const fetch = vi.fn(async () => new Response(payload([])));
    await createExaOrganizationSearch({ fetch, apiKey: "test-key" })(
      "Example Corp",
      AbortSignal.timeout(1000),
    );
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(JSON.parse(String(init.body)).params.arguments).toMatchObject({
      query: "Example Corp",
      category: "company",
    });
  });
});
