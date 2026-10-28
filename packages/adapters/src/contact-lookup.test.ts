import { describe, expect, it } from "vitest";
import { FindEmailsInput, findEmails } from "./contact-lookup.js";

const people = [
  { name: "Ada Example", linkedin_url: "https://www.linkedin.com/in/ada-example", company: "Acme" },
  { name: "Bo Sample", linkedin_url: "https://www.linkedin.com/in/bo-sample" },
  { name: "Cy Nobody", linkedin_url: "https://www.linkedin.com/in/cy-nobody" },
];
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function provider(routes: Record<string, (url: URL, init?: RequestInit) => Response>) {
  const calls: string[] = [];
  const fetch = async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    calls.push(`${init?.method ?? "GET"} ${url.hostname}${url.pathname}`);
    const route = Object.entries(routes).find(([prefix]) => url.href.startsWith(prefix));
    if (!route) throw new Error(`unexpected ${url.href}`);
    return route[1](url, init);
  };
  return { fetch, calls };
}

const options = {
  signal: new AbortController().signal,
  sleep: async () => undefined,
  pollMs: 0,
};

describe("findEmails", () => {
  it("runs each next source only for people still without an email and keeps a receipt", async () => {
    const { fetch, calls } = provider({
      "https://app.fullenrich.com/api/v1/contact/enrich/bulk/": () =>
        ok({
          status: "FINISHED",
          datas: [
            {
              custom: { person: "0" },
              contact: {
                emails: [{ email: "ada@acme.com", status: "DELIVERABLE" }],
                personal_emails: [{ email: "Ada.Example@gmail.com", status: "DELIVERABLE" }],
              },
            },
            { custom: { person: "1" }, contact: { emails: [], personal_emails: [] } },
            { custom: { person: "2" }, contact: { emails: [], personal_emails: [] } },
          ],
        }),
      "https://app.fullenrich.com/api/v1/contact/enrich/bulk": () => ok({ enrichment_id: "job-1" }),
      "https://api.contactout.com/": (url) =>
        url.searchParams.get("profile")?.includes("bo-sample")
          ? ok({ profile: { personal_email: ["bo@example.org"], work_email: [] } })
          : new Response("{}", { status: 404 }),
      "https://api.leadmagic.io/": () => new Response("{}", { status: 402 }),
    });
    const result = await findEmails(
      { people },
      { ...options, fetch, keys: { fullenrich: "k1", contactout: "k2", leadmagic: "k3" } },
    );
    expect(result.summary).toEqual({ looked_up: 3, found: 2, verified: 1 });
    expect(result.people[0]!.emails).toEqual([
      {
        address: "ada.example@gmail.com",
        type: "personal",
        status: "DELIVERABLE",
        provider: "fullenrich",
      },
      { address: "ada@acme.com", type: "work", status: "DELIVERABLE", provider: "fullenrich" },
    ]);
    expect(result.people[1]!.emails).toEqual([
      { address: "bo@example.org", type: "personal", status: null, provider: "contactout" },
    ]);
    expect(result.people[2]!.lookups).toEqual([
      { provider: "fullenrich", outcome: "not_found" },
      { provider: "contactout", outcome: "not_found" },
      { provider: "leadmagic", outcome: "failed", detail: "leadmagic has no credits left" },
    ]);
    // Ada was found first, so only Bo and Cy reach the next source; only Cy reaches the last.
    expect(calls.filter((call) => call.includes("contactout"))).toHaveLength(2);
    expect(calls.filter((call) => call.includes("leadmagic"))).toHaveLength(1);
  });

  it("skips sources without a key, reuses saved emails and keeps going when one fails", async () => {
    const { fetch, calls } = provider({
      "https://app.fullenrich.com/": () => {
        throw new TypeError("network down");
      },
    });
    const result = await findEmails(
      { people: people.slice(0, 2) },
      {
        ...options,
        fetch,
        keys: { fullenrich: "k1" },
        saved: new Map([
          [
            "linkedin:/in/ada-example",
            [
              {
                address: "ada@acme.com",
                type: "work" as const,
                status: "DELIVERABLE",
                provider: "fullenrich" as const,
              },
            ],
          ],
        ]),
      },
    );
    expect(result.people[0]!.lookups).toEqual([{ provider: "saved", outcome: "found" }]);
    expect(result.people[1]!.lookups).toEqual([
      { provider: "fullenrich", outcome: "failed", detail: "request failed" },
      { provider: "contactout", outcome: "skipped", detail: "not configured" },
      { provider: "leadmagic", outcome: "skipped", detail: "not configured" },
    ]);
    expect(calls).toEqual(["POST app.fullenrich.com/api/v1/contact/enrich/bulk"]);
  });

  it("records a lookup still running at the deadline and moves on", async () => {
    const { fetch } = provider({
      "https://app.fullenrich.com/api/v1/contact/enrich/bulk/": () => ok({ status: "IN_PROGRESS" }),
      "https://app.fullenrich.com/api/v1/contact/enrich/bulk": () => ok({ enrichment_id: "job-2" }),
    });
    const result = await findEmails(
      { people: people.slice(1, 2) },
      { ...options, fetch, keys: { fullenrich: "k1" }, waitMs: 0 },
    );
    expect(result.people[0]!.lookups[0]).toEqual({
      provider: "fullenrich",
      outcome: "pending",
      detail: "IN_PROGRESS",
    });
  });
  it("looks up the first 50 of a longer list and names who is left", async () => {
    const many = Array.from({ length: 81 }, (_, index) => ({
      name: `Person ${index}`,
      linkedin_url: `https://www.linkedin.com/in/person-${index}`,
    }));
    expect(FindEmailsInput.safeParse({ people: many }).success).toBe(true);
    const result = await findEmails(
      { people: many },
      { ...options, fetch: async () => ok({}), keys: {} },
    );
    expect(result.people).toHaveLength(50);
    expect(result.summary.not_looked_up).toBe(31);
    expect(result.summary.next_step).toContain("Person 50");
  });
});
