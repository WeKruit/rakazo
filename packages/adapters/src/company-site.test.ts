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
});
