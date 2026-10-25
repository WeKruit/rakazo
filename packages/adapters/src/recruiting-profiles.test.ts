import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  listRecruitingSavedProfiles: vi.fn(),
  listRunToolResults: vi.fn(),
  saveRecruitingSavedProfile: vi.fn(),
}));
vi.mock("@rakazo/db", () => db);

import {
  executeRecruitingProfilesTool,
  linkedinPersonKey,
  peopleFromSearch,
  profileFromLookup,
  RecruitingProfileError,
} from "./recruiting-profiles.js";

const ENDPOINT = "https://mcp.coresignal.com/mcp/v2";
const PLATFORM_SEARCH = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa";
const KEY = "linkedin:/in/ada-example";
const record = {
  linkedin_url: "https://uk.linkedin.com/in/Ada-Example/",
  picture_url: "https://media.example.com/ada.jpg",
  headline: "Warehouse operations lead",
  experience: [
    {
      position_title: "Operations Manager",
      company_name: "Acme Logistics",
      company_website: "acme-logistics.example",
      company_logo_url: "https://logos.example/acme.png",
      company_industry: "Logistics",
      company_size_range: "1,001-5,000 employees",
      date_from_year: 2021,
      date_from_month: 3,
      date_to: null,
      active_experience: 1,
    },
    {
      position_title: "Shift Supervisor",
      company_name: "Beta Freight",
      company_website: "javascript:alert(1)",
      date_from: "June 2017",
      date_to: "February 2021",
      active_experience: 0,
    },
  ],
  education: [
    {
      institution_name: "Example University",
      degree: "B.S. Supply Chain",
      institution_logo_url: "https://logos.example/eu.png",
      institution_website: "https://www.eu.example",
      date_from_year: 2013,
      date_to_year: 2017,
    },
  ],
};
const mcpResult = { content: [{ type: "text", text: JSON.stringify({ data: record }) }] };

describe("linkedinPersonKey", () => {
  it("matches the pool key across hosts, case and a missing scheme", () => {
    expect(linkedinPersonKey("https://uk.linkedin.com/in/Ada-Example/")).toBe(KEY);
    expect(linkedinPersonKey("linkedin.com/in/ada-example")).toBe(KEY);
    expect(linkedinPersonKey("https://example.com/in/ada-example")).toBeNull();
    expect(linkedinPersonKey("https://www.linkedin.com/company/acme")).toBeNull();
  });
});

describe("profileFromLookup", () => {
  it("maps the person's own record into dated history, logos and photo", () => {
    const found = profileFromLookup(mcpResult, ENDPOINT, KEY);
    expect(found?.provider).toBe("coresignal");
    expect(found?.facts.profileImageUrl).toBe("https://media.example.com/ada.jpg");
    expect(found?.facts.experience[0]).toMatchObject({
      title: "Operations Manager",
      company_name: "Acme Logistics",
      company_url: "https://acme-logistics.example/",
      company_logo_url: "https://logos.example/acme.png",
      company_industry: "Logistics",
      company_size: "1,001-5,000 employees",
      start_date: "2021-03",
      end_date: null,
      is_current: true,
    });
    expect(found?.facts.experience[1]).toMatchObject({
      company_url: null,
      start_date: "June 2017",
      end_date: "February 2021",
      is_current: false,
    });
    expect(found?.facts.education[0]).toMatchObject({
      school_name: "Example University",
      school_logo_url: "https://logos.example/eu.png",
      start_date: "2013",
      end_date: "2017",
    });
  });

  it("never saves another person's record or an unknown connector's result", () => {
    expect(profileFromLookup(mcpResult, ENDPOINT, "linkedin:/in/someone-else")).toBeNull();
    expect(profileFromLookup(mcpResult, "https://mcp.other.example/mcp", KEY)).toBeNull();
    expect(
      profileFromLookup({ content: [{ type: "text", text: "no data" }] }, ENDPOINT, KEY),
    ).toBeNull();
  });
});

describe("executeRecruitingProfilesTool", () => {
  const actor = {
    spaceId: "s1",
    userId: "u1",
    email: "owner@example.com",
    isDeploymentOwner: false,
  };
  const prisma = {} as never;
  beforeEach(() => vi.resetAllMocks());

  it("saves the newest matching lookup of this run with its own time", async () => {
    const createdAt = new Date("2026-10-24T22:00:00Z");
    db.listRunToolResults.mockResolvedValue([
      { effectId: "e-other", toolName: "entity_fetch", endpoint: ENDPOINT, result: {}, createdAt },
      {
        effectId: "e1",
        toolName: "entity_fetch",
        endpoint: ENDPOINT,
        result: mcpResult,
        createdAt,
      },
    ]);
    db.saveRecruitingSavedProfile.mockImplementation(async (_p, _a, _r, input) => ({
      ...input.profile,
      personKey: input.personKey,
      provider: input.provider,
      fetchedAt: input.fetchedAt.toISOString(),
    }));
    const result = await executeRecruitingProfilesTool(prisma, actor, "run1", {
      operation: "save",
      candidateKey: KEY,
    });
    expect(db.saveRecruitingSavedProfile).toHaveBeenCalledWith(
      prisma,
      actor,
      "run1",
      expect.objectContaining({ personKey: KEY, sourceEffectId: "e1", fetchedAt: createdAt }),
    );
    expect(result).toMatchObject({
      saved: true,
      positions: 2,
      datedPositions: 2,
      degrees: 1,
      photo: true,
    });
  });

  it("refuses to save without a lookup or a LinkedIn identity", async () => {
    db.listRunToolResults.mockResolvedValue([]);
    await expect(
      executeRecruitingProfilesTool(prisma, actor, "run1", {
        operation: "save",
        candidateKey: KEY,
      }),
    ).rejects.toBeInstanceOf(RecruitingProfileError);
    await expect(
      executeRecruitingProfilesTool(prisma, actor, "run1", {
        operation: "save",
        candidateKey: "name:ada",
      }),
    ).rejects.toBeInstanceOf(RecruitingProfileError);
    expect(db.saveRecruitingSavedProfile).not.toHaveBeenCalled();
  });

  it("lists who already has a saved profile", async () => {
    db.listRecruitingSavedProfiles.mockResolvedValue(
      new Map([
        [
          KEY,
          {
            personKey: KEY,
            provider: "coresignal",
            fetchedAt: "2026-10-24T22:00:00.000Z",
            headline: null,
            profileImageUrl: null,
            experience: [],
            education: [],
          },
        ],
      ]),
    );
    const result = await executeRecruitingProfilesTool(prisma, actor, "run1", {
      operation: "list",
      candidateKeys: [KEY, "linkedin:/in/new"],
    });
    expect(result).toEqual({
      items: [
        expect.objectContaining({ candidateKey: KEY, saved: true }),
        { candidateKey: "linkedin:/in/new", saved: false },
      ],
    });
  });
});

describe("peopleFromSearch", () => {
  it("reads people from JSON previews, nested records and markdown tables", () => {
    const json = {
      structuredContent: {
        total: 412,
        preview: [
          {
            full_name: "Ada Example",
            active_experience_title: "Sort Center Manager",
            active_experience_company_name: "Acme Parcel",
            location_full: "Edison, New Jersey, United States",
            professional_network_url: "https://uk.linkedin.com/in/Ada-Example/?trk=x",
            experience: [{ title: "Shift Lead", company_name: "Beta", url: "https://x.example" }],
          },
          { full_name: "No Link", active_experience_title: "Manager" },
          { name: "Acme Parcel", linkedin_url: "https://www.linkedin.com/company/acme" },
        ],
      },
    };
    const table = {
      content: [
        {
          type: "text",
          text: "Found 2 people\n\n| Full name | Job title | Company name | Location | LinkedIn URL |\n|---|---|---|---|---|\n| Ben Sample | Warehouse Ops Supervisor | Gamma Fulfillment | Newark, NJ | linkedin.com/in/ben-sample |\n| Ada Example | Sort Center Manager | Acme Parcel | Edison, NJ | https://www.linkedin.com/in/ada-example |",
        },
      ],
    };
    expect(peopleFromSearch(json, ENDPOINT)).toEqual([
      {
        name: "Ada Example",
        linkedin_url: "https://www.linkedin.com/in/ada-example",
        current_title: "Sort Center Manager",
        current_company: "Acme Parcel",
        location: "Edison, New Jersey, United States",
      },
    ]);
    expect(peopleFromSearch(table, ENDPOINT).map((person) => person.linkedin_url)).toEqual([
      "https://www.linkedin.com/in/ben-sample",
      "https://www.linkedin.com/in/ada-example",
    ]);
    expect(peopleFromSearch(table, ENDPOINT)[0]).toMatchObject({
      name: "Ben Sample",
      current_title: "Warehouse Ops Supervisor",
      current_company: "Gamma Fulfillment",
    });
  });

  it("reads people from a web-search listing, preferring the current job", () => {
    const text = [
      "Title: Ada Example",
      "URL: https://www.linkedin.com/in/ada-example",
      "Published: N/A",
      "Highlights:",
      "# Ada Example",
      "",
      "Sort Center Manager at Acme Parcel",
      "",
      "Edison, New Jersey, United States (US)",
      "",
      "## Experience",
      "### Shift Lead - [Beta Freight](https://beta.example)",
      "### Sort Center Manager - [Acme Parcel](https://acme.example) (Current)",
      "---",
      "Title: Ben Sample",
      "URL: https://linkedin.com/in/ben-sample/",
      "Highlights:",
      "# Ben Sample",
      "",
      "Operations leader",
      "",
      "Newark, NJ (US)",
      "",
      "## Experience",
      "### [Gamma Fulfillment](https://gamma.example)",
      "",
      "#### Area Manager (Current)",
      "---",
      "Title: Acme Parcel",
      "URL: https://www.linkedin.com/company/acme",
    ].join("\n");
    const listing = { content: [{ type: "text", text }] };
    expect(peopleFromSearch(listing, PLATFORM_SEARCH)).toEqual([
      {
        name: "Ada Example",
        linkedin_url: "https://www.linkedin.com/in/ada-example",
        current_title: "Sort Center Manager",
        current_company: "Acme Parcel",
        location: "Edison, New Jersey, United States",
      },
      {
        name: "Ben Sample",
        linkedin_url: "https://www.linkedin.com/in/ben-sample",
        current_title: "Area Manager",
        current_company: "Gamma Fulfillment",
        location: "Newark, NJ",
      },
    ]);
  });

  it("ignores connectors that are not profile-data providers", () => {
    expect(
      peopleFromSearch(
        { full_name: "Ada", linkedin_url: "https://www.linkedin.com/in/ada" },
        "https://mcp.other.example/mcp",
      ),
    ).toEqual([]);
  });
});
