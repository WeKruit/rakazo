import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { readerPage } from "./exa-page-reader.js";
import { FakeWebProvider } from "./fake-web.js";
import {
  extractReadableText,
  KeylessHttpWebProvider,
  parseDuckDuckGoResults,
} from "./keyless-http-web.js";
import { clampMaxChars, clampMaxResults } from "./web-limits.js";
import { createWebProvider, resolveWebProviderKind } from "./web-provider-factory.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];
const jobPosting = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Example infrastructure engineer",
  description:
    "<h2>The Role</h2><p>Build data systems &amp; geometry tools.</p><h2>What You’ll Bring</h2><ul><li>5+ years of software experience.</li><li>Python required; React/TypeScript is a major plus.</li></ul><h2>Bonus Points</h2><p>Robotics experience.</p>",
  directApply: true,
  identifier: { "@type": "PropertyValue", name: "Example", value: "example-job" },
  datePosted: "2026-10-01",
  hiringOrganization: { "@type": "Organization", name: "Example" },
  jobLocation: {
    "@type": "Place",
    address: { "@type": "PostalAddress", addressLocality: "Example City" },
  },
  employmentType: "FULL_TIME",
  baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: 100000 },
};
const jobHtml = (
  data: unknown,
  body = "<noscript>Enable JavaScript to view this page.</noscript>",
) =>
  `<html><head><title>Job landing</title><script type="application/ld+json">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script></head><body>${body}</body></html>`;

describe("web provider factory", () => {
  it("defaults to keyless-http", () => {
    expect(resolveWebProviderKind({})).toBe("keyless-http");
    expect(createWebProvider().describe().id).toBe("keyless-http");
    expect(createWebProvider("fake").describe().id).toBe("fake");
  });
});

describe("keyless HTTP web provider", () => {
  it("searches via the HTML backend without a vendor API key", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fa">Alpha</a>
        <a class="result__snippet">Snippet A</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.test/b">Beta</a>
        <div class="result__snippet">Snippet B</div>
      </div>
    `;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const results = await provider.search({ query: "alpha", maxResults: 5 }, ctx);
    expect(results).toEqual([
      { title: "Alpha", url: "https://example.test/a", snippet: "Snippet A" },
      { title: "Beta", url: "https://example.test/b", snippet: "Snippet B" },
    ]);
  });

  it("fetches readable page text with truncation", async () => {
    const long = "word ".repeat(100);
    const html = `<html><head><title>Doc</title></head><body><article><p>${long}</p></article></body></html>`;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const result = await provider.fetch({ url: "https://example.test/doc", maxChars: 120 }, ctx);
    expect(result.title).toBeTruthy();
    expect(result.url).toBe("https://example.test/doc");
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("[Content truncated]")).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(120 + "\n\n[Content truncated]".length);
  });

  it("reads a page the site refuses through the page reader, and only that page", async () => {
    const refused: typeof fetch = async () => new Response("", { status: 403 });
    const reads: string[] = [];
    const provider = new KeylessHttpWebProvider({
      fetch: refused,
      resolveHostname: publicResolver,
      pageReader: async (url) => {
        reads.push(url);
        return { url, title: "Example Person", text: "# Example Person\nStaff engineer" };
      },
    });
    const result = await provider.fetch({ url: "https://www.linkedin.com/in/example" }, ctx);
    expect(result).toMatchObject({ title: "Example Person", truncated: false });
    expect(result.text).toContain("Staff engineer");
    // A private address is refused before any request and never reaches the reader.
    const privateHost = new KeylessHttpWebProvider({
      fetch: refused,
      resolveHostname: async () => [{ address: "10.0.0.1", family: 4 as const }],
      pageReader: async (url) => {
        reads.push(url);
        return { url, title: "", text: "x" };
      },
    });
    await expect(privateHost.fetch({ url: "https://internal.test/" }, ctx)).rejects.toThrow();
    const missing = new KeylessHttpWebProvider({
      fetch: async () => new Response("", { status: 404 }),
      resolveHostname: publicResolver,
      pageReader: async (url) => {
        reads.push(url);
        return { url, title: "", text: "x" };
      },
    });
    await expect(missing.fetch({ url: "https://example.test/gone" }, ctx)).rejects.toThrow(
      "HTTP 404",
    );
    expect(reads).toEqual(["https://www.linkedin.com/in/example"]);
  });

  it("parses the page reader's answer and its errors", () => {
    const ok = `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text: "# Example Person\nURL: https://www.linkedin.com/in/example/\n\nStaff engineer" }] } })}`;
    expect(readerPage(ok, "https://www.linkedin.com/in/example")).toMatchObject({
      title: "Example Person",
      url: "https://www.linkedin.com/in/example/",
    });
    const missing = JSON.stringify({
      result: {
        isError: true,
        content: [{ type: "text", text: "Error fetching URL(s): ENTITY_NOT_FOUND" }],
      },
    });
    expect(() => readerPage(missing, "https://www.linkedin.com/in/none")).toThrow(
      "ENTITY_NOT_FOUND",
    );
  });

  it("falls back to HTML strip when Readability finds nothing", () => {
    const extracted = extractReadableText(
      "<html><title>Plain</title><body><div>just text here</div></body></html>",
      "https://example.test/",
    );
    expect(extracted.title).toBe("Plain");
    expect(extracted.text).toContain("just text here");
  });

  it("reads a unique standard JobPosting description and preserves its actual metadata", async () => {
    const fetchMock: typeof fetch = async () => new Response(jobHtml(jobPosting), { status: 200 });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const result = await provider.fetch({ url: "https://example.test/job", maxChars: 8000 }, ctx);
    expect(result).toMatchObject({
      url: "https://example.test/job",
      title: jobPosting.title,
      truncated: false,
    });
    expect(result.text).toContain("The Role\nBuild data systems & geometry tools.");
    expect(result.text).toContain("5+ years of software experience.");
    expect(result.text).toContain("Python required; React/TypeScript is a major plus.");
    expect(result.text).toContain("Bonus Points\nRobotics experience.");
    const { description: _description, ...metadata } = jobPosting;
    expect(result.text).toContain(JSON.stringify(metadata, null, 2));
    expect(result.text).not.toContain("Enable JavaScript");
  });

  it.each([
    ["array", [jobPosting]],
    [
      "graph",
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Example" },
          { ...jobPosting, "@context": undefined, "@type": ["Thing", "JobPosting"] },
        ],
      },
    ],
    [
      "fully qualified type",
      { ...jobPosting, "@context": undefined, "@type": "https://schema.org/JobPosting" },
    ],
    ["matching relative URL", { ...jobPosting, url: "/job?source=example" }],
  ])("reads the standard %s shape without executing scripts", (_shape, data) => {
    const html = jobHtml(data).replace(
      "<head>",
      '<head><script type="application/ld+json">{broken</script>',
    );
    const extracted = extractReadableText(html, "https://example.test/job?source=example");
    expect(extracted.title).toBe(jobPosting.title);
    expect(extracted.text).toContain("5+ years of software experience.");
  });

  it("parses description HTML without running or retaining script content", () => {
    const extracted = extractReadableText(
      jobHtml({
        ...jobPosting,
        description: `${jobPosting.description}<script>document.body.textContent = "must not execute"</script><style>body { display: none; }</style>`,
      }),
      "https://example.test/job",
    );
    expect(extracted.text).toContain("React/TypeScript is a major plus.");
    expect(extracted.text).not.toContain("must not execute");
    expect(extracted.text).not.toContain("display: none");
  });

  it.each([
    ["multiple postings", [jobPosting, { ...jobPosting, title: "Another job" }]],
    ["a different URL", { ...jobPosting, url: "https://example.test/another-job" }],
    ["a different query", { ...jobPosting, url: "https://example.test/job?other=job" }],
    ["an invalid URL", { ...jobPosting, url: "http://[" }],
    ["another vocabulary", { ...jobPosting, "@context": "https://example.test/vocabulary" }],
  ])("leaves %s on the existing HTML path", (_reason, data) => {
    const extracted = extractReadableText(jobHtml(data), "https://example.test/job");
    expect(extracted.title).toBe("Job landing");
    expect(extracted.text).toContain("Enable JavaScript");
    expect(extracted.text).not.toContain("5+ years");
  });

  it("reads a unique matching JobPosting even when a div shell looks readable", () => {
    const extracted = extractReadableText(
      jobHtml(jobPosting, "<div>Enable JavaScript to view this page.</div>"),
      "https://example.test/job",
    );
    expect(extracted.title).toBe(jobPosting.title);
    expect(extracted.text).toContain("5+ years of software experience.");
    expect(extracted.text).not.toContain("Enable JavaScript");
  });

  it("prefers a matching structured job description and metadata over generic page text", () => {
    const article = `<article><h1>Visible article</h1><p>${"Actual page text. ".repeat(100)}</p></article>`;
    const extracted = extractReadableText(jobHtml(jobPosting, article), "https://example.test/job");
    expect(extracted.title).toBe(jobPosting.title);
    expect(extracted.text).toContain("5+ years of software experience.");
    expect(extracted.text).toContain('"addressLocality": "Example City"');
    expect(extracted.text).not.toContain("Actual page text.");
  });

  it.each([
    ["ordinary articles", { "@context": "https://schema.org", "@type": "Article" }],
    ["an unmatched job URL", { ...jobPosting, url: "https://example.test/another-job" }],
  ])("keeps the existing Readability path for %s", (_reason, data) => {
    const article = `<article><h1>Visible article</h1><p>${"Actual page text. ".repeat(100)}</p></article>`;
    const extracted = extractReadableText(jobHtml(data, article), "https://example.test/job");
    expect(extracted.text).toContain("Actual page text.");
    expect(extracted.text).not.toContain("5+ years");
  });

  it("applies the existing fetch truncation to structured job text", async () => {
    const provider = new KeylessHttpWebProvider({
      fetch: async () => new Response(jobHtml(jobPosting), { status: 200 }),
      resolveHostname: publicResolver,
    });
    const result = await provider.fetch({ url: "https://example.test/job", maxChars: 100 }, ctx);
    expect(result.title).toBe(jobPosting.title);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(100 + "\n\n[Content truncated]".length);
    expect(result.text).toContain("The Role");
    expect(result.text).toMatch(/\[Content truncated\]$/);
  });

  it("parses HTML search results with a cap", () => {
    const html = Array.from({ length: 12 }, (_, i) => {
      return `<div class="result"><a class="result__a" href="https://example.test/${i}">T${i}</a><div class="result__snippet">S${i}</div></div>`;
    }).join("");
    expect(parseDuckDuckGoResults(html, 3)).toHaveLength(3);
  });
});

describe("web tool apply with fake provider", () => {
  it("returns injected search and fetch results", async () => {
    const fake = new FakeWebProvider();
    fake.searchHits = [
      { title: "One", url: "https://example.test/1", snippet: "s1" },
      { title: "Two", url: "https://example.test/2", snippet: "s2" },
    ];
    fake.fetchResult = {
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    };

    await expect(webSearchFromTool(fake, ctx, { query: "q", maxResults: 1 })).resolves.toEqual({
      results: [{ title: "One", url: "https://example.test/1", snippet: "s1" }],
    });
    expect(fake.lastSearch?.query).toBe("q");

    await expect(
      webFetchFromTool(fake, ctx, { url: "https://example.test/1", maxChars: 100 }),
    ).resolves.toEqual({
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    });
  });

  it("surfaces provider errors as tool errors", async () => {
    const fake = new FakeWebProvider();
    fake.searchError = new Error("boom");
    await expect(webSearchFromTool(fake, ctx, { query: "q" })).resolves.toEqual({
      error: "boom",
    });
  });
});

describe("web tool clamps", () => {
  it("clamps maxResults and maxChars", () => {
    expect(clampMaxResults(undefined)).toBe(5);
    expect(clampMaxResults(100)).toBe(10);
    expect(clampMaxResults(0)).toBe(1);
    expect(clampMaxChars(undefined)).toBe(8_000);
    expect(clampMaxChars(10)).toBe(100);
    expect(clampMaxChars(999_999)).toBe(50_000);
  });
});
