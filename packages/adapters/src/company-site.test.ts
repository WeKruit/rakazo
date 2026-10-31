import { describe, expect, it, vi } from "vitest";
import {
  companySiteCandidates,
  companyTokens,
  createCompanySiteResolver,
  titleNamesCompany,
} from "./company-site.js";

describe("company site", () => {
  it("turns a name into its words without legal suffixes", () => {
    expect(companyTokens("Acme Robotics, Inc.")).toEqual(["acme", "robotics"]);
    expect(companyTokens("Hims & Hers")).toEqual(["hims", "hers"]);
    expect(companyTokens("66659d95-ca8e-4743-9a3b-0f6c2d1e8b7a")).toEqual([]);
  });

  it("tries the whole name first and a distinctive first word last", () => {
    expect(companySiteCandidates(["acme", "robotics"])).toEqual([
      "acmerobotics.com",
      "acmerobotics.ai",
      "acmerobotics.io",
      "acme.com",
    ]);
    expect(companySiteCandidates(["university", "of", "somewhere"])).not.toContain(
      "university.com",
    );
    expect(companySiteCandidates(["stealth"])).toEqual([]);
  });

  it("accepts only a page that names the organization", () => {
    expect(titleNamesCompany("Acme Robotics | Home", ["acme", "robotics"])).toBe(true);
    expect(titleNamesCompany("Acme — Build things", ["acme", "robotics"])).toBe(true);
    expect(titleNamesCompany("Welcome", ["acme", "robotics"])).toBe(false);
    expect(titleNamesCompany("acmerobotics.com is for sale", ["acme", "robotics"])).toBe(false);
  });

  it("returns the confirmed host and caches the answer", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://acmerobotics.com/")
        return new Response("<title>Acme Robotics</title>", {
          headers: { "content-type": "text/html" },
        });
      return new Response("not found", { status: 404 });
    });
    const resolver = createCompanySiteResolver({
      fetch: fetch as unknown as typeof globalThis.fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
    });
    await expect(resolver.companySite("Acme Robotics Inc")).resolves.toEqual({
      host: "acmerobotics.com",
    });
    const calls = fetch.mock.calls.length;
    await expect(resolver.companySite("acme robotics")).resolves.toEqual({
      host: "acmerobotics.com",
    });
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("queues a table's worth of names instead of turning them away", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const name = url.hostname.replace(/\.com$/, "");
      return url.hostname.endsWith(".com")
        ? new Response(`<title>${name}</title>`, { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 });
    });
    const resolver = createCompanySiteResolver({
      fetch: fetch as unknown as typeof globalThis.fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
    });
    const names = Array.from({ length: 30 }, (_, index) => `company${index}`);
    const answers = await Promise.all(names.map((name) => resolver.companySite(name)));
    expect(answers).toEqual(names.map((name) => ({ host: `${name}.com` })));
  });

  it("takes the indexed organization's own site before guessing domains", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    const searchOrganizations = vi.fn(async () => [
      {
        url: "https://www.linkedin.com/school/example-state-university/",
        title: "Example State University",
      },
      { url: "https://www.esu.edu/", title: "Example State University" },
    ]);
    const resolver = createCompanySiteResolver({ fetch, searchOrganizations });
    expect(await resolver.companySite("Example State University")).toEqual({ host: "esu.edu" });
    expect(await resolver.companySite("example state university")).toEqual({ host: "esu.edu" });
    expect(searchOrganizations).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the index's logo as a small image when it has one", async () => {
    const png = await sharpPng();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return url === "https://logos.example/esu.png"
        ? new Response(png, { headers: { "content-type": "image/png" } })
        : new Response("", { status: 404 });
    });
    const resolver = createCompanySiteResolver({
      fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      searchOrganizations: async () => [
        {
          url: "https://www.esu.edu/",
          title: "Example State University",
          image: "https://logos.example/esu.png",
        },
      ],
    });
    const answer = await resolver.companySite("Example State University");
    expect(answer.host).toBe("esu.edu");
    expect(answer.icon).toMatch(/^data:image\/png;base64,/);
    expect((await resolver.companySite("Example State University")).icon).toBe(answer.icon);
  });

  it("ignores an indexed organization with another name and falls back to guessing", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    const searchOrganizations = vi.fn(async () => [
      { url: "https://acme-tools.com/", title: "Acme Tools" },
    ]);
    const resolver = createCompanySiteResolver({ fetch, searchOrganizations });
    expect(await resolver.companySite("Acme Robotics")).toEqual({ host: null });
    expect(fetch).toHaveBeenCalled();
  });

  it("keeps the index's logo when it lists only a social or directory page", async () => {
    const png = await sharpPng();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return url === "https://logos.example/club.png"
        ? new Response(png, { headers: { "content-type": "image/png" } })
        : new Response("", { status: 404 });
    });
    const resolver = createCompanySiteResolver({
      fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      searchOrganizations: async () => [
        { url: "https://club.example/", title: "Another Club" },
        {
          url: "https://www.linkedin.com/company/example-chess-club",
          title: "Example Chess Club",
          image: "https://logos.example/club.png",
        },
      ],
    });
    const answer = await resolver.companySite("Example Chess Club");
    expect(answer.host).toBeNull();
    expect(answer.icon).toMatch(/^data:image\/png;base64,/);
  });

  it("asks the index again when busy, and has the page ask later instead of a miss", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    const searchOrganizations = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce([{ url: "https://esu.edu/", title: "Example State University" }])
      .mockRejectedValue(new Error("rate limited"));
    const resolver = createCompanySiteResolver({ fetch, searchOrganizations });
    expect(await resolver.companySite("Example State University")).toEqual({ host: "esu.edu" });
    expect(await resolver.companySite("Busy Org")).toEqual({ host: null, retry: true });
    expect(searchOrganizations).toHaveBeenCalledTimes(5);
  }, 15_000);

  it("saves answers for every process but never a miss the index could not confirm", async () => {
    const saved = new Map<string, unknown>();
    const store = {
      get: vi.fn(async () => null),
      put: vi.fn(async (key: string, found: unknown) => void saved.set(key, found)),
    };
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    const resolver = createCompanySiteResolver({
      fetch,
      store,
      searchOrganizations: async (name) => {
        if (name === "busy org") throw new Error("rate limited");
        return [{ url: "https://esu.edu/", title: "Example State University" }];
      },
    });
    await resolver.companySite("Example State University");
    await resolver.companySite("Busy Org");
    expect([...saved]).toEqual([["example state university", { host: "esu.edu" }]]);
  }, 15_000);

  it("reads a page's saved answers in one store query and answers in the names' order", async () => {
    const future = Date.now() + 60_000;
    const store = {
      get: vi.fn(async () => null),
      getMany: vi.fn(
        async () =>
          new Map([
            ["acme", { host: "acme.com", expiresAt: future }],
            ["globex", { host: null, expiresAt: future }],
          ]),
      ),
      put: vi.fn(async () => undefined),
    };
    const searchOrganizations = vi.fn(async () => []);
    const resolver = createCompanySiteResolver({ store, searchOrganizations });
    expect(await resolver.companySites(["Globex", "Acme Inc.", "Acme", ""])).toEqual([
      { host: null },
      { host: "acme.com" },
      { host: "acme.com" },
      { host: null },
    ]);
    expect(store.getMany).toHaveBeenCalledExactlyOnceWith(["globex", "acme"]);
    expect(store.get).not.toHaveBeenCalled();
    expect(searchOrganizations).not.toHaveBeenCalled();
  });
});

async function sharpPng() {
  const { default: sharp } = await import("sharp");
  return sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
}
