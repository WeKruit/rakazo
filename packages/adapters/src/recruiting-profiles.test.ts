import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  listRecruitingRolePoolRuns: vi.fn(),
  listRecruitingSavedProfiles: vi.fn(),
  listRunToolResults: vi.fn(),
  saveRecruitingSavedProfile: vi.fn(),
}));
vi.mock("@rakazo/db", () => db);

import {
  executeRecruitingProfilesTool,
  fillRecruitingRoleProfiles,
  keepSearchHistory,
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
  it("reads the people a finished agent run returned, with their education", () => {
    const body = {
      success: true,
      id: "agent_run_1",
      status: "completed",
      output: {
        text: "Found two.",
        structured: {
          people: [
            {
              name: "Ada Example",
              linkedin_url: "https://linkedin.com/in/ada-example?trk=x",
              current_role: "Payments Engineer",
              current_company: "Acme",
              location: "New York, NY",
              education: ["State University | BS, Computer Science | 2012 – 2016"],
              evidence: "Built the ledger service in Go.",
            },
            { name: "No Link", linkedin_url: null, evidence: "n/a" },
          ],
        },
      },
    };
    const result = { content: [{ type: "text", text: JSON.stringify(body) }] };
    expect(peopleFromSearch(result, PLATFORM_SEARCH)).toEqual([
      {
        name: "Ada Example",
        linkedin_url: "https://www.linkedin.com/in/ada-example",
        current_title: "Payments Engineer",
        current_company: "Acme",
        location: "New York, NY",
        snippet: "Built the ledger service in Go.",
        education: "State University | BS, Computer Science | 2012 – 2016",
      },
    ]);
    const running = { id: "agent_run_1", status: "running", outputReady: false };
    expect(
      peopleFromSearch(
        { content: [{ type: "text", text: JSON.stringify(running) }] },
        PLATFORM_SEARCH,
      ),
    ).toEqual([]);
  });

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
      "",
      "Apr 2015 - Oct 2019 (4 years and 6 months)",
      "",
      "Ran the night shift.",
      "### Sort Center Manager - Acme Parcel, Inc. (Current)",
      "",
      "Jul 2019 - Present (7 years) in Edison, New Jersey, United States",
      "",
      "## Education",
      "### B.S. Logistics - [Rutgers University](https://rutgers.example)",
      "",
      "2011 - 2015",
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
      "",
      "Mar 2023 - Present (3 years)",
      "#### Shift Lead",
      "Jan 2021 - Mar 2023 (2 years) in Newark, NJ",
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
        current_company: "Acme Parcel, Inc.",
        location: "Edison, New Jersey, United States",
        snippet: expect.stringMatching(/^Sort Center Manager at Acme Parcel Edison/),
        experience: [
          "Shift Lead | Beta Freight |  | Apr 2015 – Oct 2019",
          "Sort Center Manager | Acme Parcel, Inc. |  | Jul 2019 – Present | Edison, New Jersey, United States",
        ].join("\n"),
        education: "Rutgers University | B.S. Logistics | 2011 – 2015",
      },
      {
        name: "Ben Sample",
        linkedin_url: "https://www.linkedin.com/in/ben-sample",
        current_title: "Area Manager",
        current_company: "Gamma Fulfillment",
        location: "Newark, NJ",
        snippet: expect.stringMatching(/^Operations leader Newark, NJ \(US\)/),
        experience: [
          "Area Manager | Gamma Fulfillment |  | Mar 2023 – Present",
          "Shift Lead | Gamma Fulfillment |  | Jan 2021 – Mar 2023 | Newark, NJ",
        ].join("\n"),
      },
    ]);
  });

  it("reads people from the advanced search's JSON results", () => {
    const text = JSON.stringify({
      results: [
        {
          url: "https://www.linkedin.com/in/cara-example",
          title: "Cara Example",
          image:
            "https://media.licdn.com/dms/image/v2/X/profile-displayphoto-shrink_200_200/0/1?e=1",
          highlights: ["Ran a 120-person distribution center"],
          entities: [
            {
              type: "person",
              properties: {
                name: "Cara Example",
                location: "Atlanta Metropolitan Area",
                workHistory: [
                  {
                    title: "Warehouse Manager",
                    company: { name: "Delta Freight" },
                    dates: { from: "2020-02-01", to: null },
                  },
                  { title: "Supervisor", company: { name: "Old Co" }, dates: { to: "2020-01-01" } },
                ],
                educationHistory: [
                  {
                    degree: "MBA",
                    institution: { name: "Emory University" },
                    dates: { to: "2019" },
                  },
                ],
              },
            },
          ],
        },
        { url: "https://www.linkedin.com/company/acme", title: "Acme" },
      ],
    });
    expect(peopleFromSearch({ content: [{ type: "text", text }] }, PLATFORM_SEARCH)).toEqual([
      {
        name: "Cara Example",
        linkedin_url: "https://www.linkedin.com/in/cara-example",
        current_title: "Warehouse Manager",
        current_company: "Delta Freight",
        location: "Atlanta Metropolitan Area",
        snippet: "Ran a 120-person distribution center",
        experience:
          "Warehouse Manager | Delta Freight |  | Feb 2020 – Present\nSupervisor | Old Co",
        education: "Emory University | MBA | 2019",
        profile_image_url:
          "https://media.licdn.com/dms/image/v2/X/profile-displayphoto-shrink_200_200/0/1?e=1",
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

describe("profile lookups through the people search", () => {
  const actor = {
    spaceId: "s1",
    userId: "u1",
    email: "owner@example.com",
    isDeploymentOwner: false,
  };
  beforeEach(() => vi.resetAllMocks());

  it("saves each looked-up person and reports who had no lookup", async () => {
    const createdAt = new Date("2026-10-28T21:00:00Z");
    const text = JSON.stringify({
      results: [
        {
          url: "https://linkedin.com/in/cara",
          title: "Cara",
          entities: [
            {
              properties: {
                name: "Cara",
                workHistory: [
                  { title: "Lead", company: { name: "Delta" }, dates: { from: "2021-05" } },
                ],
              },
            },
          ],
        },
      ],
    });
    db.listRunToolResults.mockResolvedValue([
      {
        effectId: "e1",
        toolName: "web_search_advanced_exa",
        endpoint: PLATFORM_SEARCH,
        result: { content: [{ type: "text", text }] },
        createdAt,
      },
    ]);
    db.saveRecruitingSavedProfile.mockImplementation(async (_p, _a, _r, input) => ({
      ...input.profile,
      personKey: input.personKey,
      provider: input.provider,
      fetchedAt: input.fetchedAt.toISOString(),
    }));
    const result = await executeRecruitingProfilesTool({} as never, actor, "run1", {
      operation: "save_many",
      candidateKeys: ["linkedin:/in/cara", "linkedin:/in/dan", "name:erin"],
    });
    expect(result).toEqual({
      items: [
        expect.objectContaining({
          candidateKey: "linkedin:/in/cara",
          saved: true,
          datedPositions: 1,
        }),
        { candidateKey: "linkedin:/in/dan", saved: false },
        { candidateKey: "name:erin", saved: false, reason: "no LinkedIn profile on record" },
      ],
    });
    expect(db.saveRecruitingSavedProfile.mock.calls[0]![3]).toMatchObject({
      provider: "people_search",
      sourceEffectId: "e1",
      profile: { experience: [{ title: "Lead", company_name: "Delta", start_date: "May 2021" }] },
    });
  });
});

describe("fillRecruitingRoleProfiles", () => {
  const actor = {
    spaceId: "s1",
    userId: "u1",
    email: "owner@example.com",
    isDeploymentOwner: false,
  };
  beforeEach(() => vi.resetAllMocks());

  it("saves history and photo from the role's earlier searches for people missing it", async () => {
    const createdAt = new Date("2026-10-27T10:00:00Z");
    const photo = "https://media.licdn.com/dms/image/v2/A/profile-displayphoto-shrink_200_200/0/1";
    const person = (slug: string, extra: Record<string, unknown> = {}) => ({
      url: `https://www.linkedin.com/in/${slug}`,
      title: slug,
      ...extra,
      entities: [
        {
          properties: {
            name: slug,
            workHistory: [
              { title: "Manager", company: { name: "Delta" }, dates: { from: "2020-02-01" } },
              { title: "Lead", company: { name: "Old" }, dates: { from: "2018", to: "2020-01" } },
            ],
            educationHistory: [{ degree: "BS", institution: { name: "State U" } }],
          },
        },
      ],
    });
    const text = JSON.stringify({
      results: [person("cara", { image: photo }), person("dan"), person("eve")],
    });
    db.listRecruitingRolePoolRuns.mockResolvedValue({
      personKeys: ["linkedin:/in/cara", "linkedin:/in/dan", "linkedin:/in/zed"],
      runIds: ["run1"],
    });
    const danSaved = {
      personKey: "linkedin:/in/dan",
      provider: "people_search",
      fetchedAt: "2026-10-26T10:00:00.000Z",
      headline: null,
      profileImageUrl: null,
      experience: [{ title: "x" }],
      education: [],
    };
    db.listRecruitingSavedProfiles.mockResolvedValue(new Map([["linkedin:/in/dan", danSaved]]));
    db.saveRecruitingSavedProfile.mockImplementation(async (_p, _a, _r, input) => ({
      ...input.profile,
      personKey: input.personKey,
      provider: input.provider,
      fetchedAt: input.fetchedAt.toISOString(),
    }));
    db.listRunToolResults.mockResolvedValue([
      {
        effectId: "e1",
        toolName: "web_search_advanced_exa",
        endpoint: PLATFORM_SEARCH,
        result: { content: [{ type: "text", text }] },
        createdAt,
      },
    ]);
    const result = await fillRecruitingRoleProfiles({} as never, actor, "role1", async () => {
      const { default: sharp } = await import("sharp");
      return sharp({ create: { width: 8, height: 8, channels: 3, background: "#777777" } })
        .png()
        .toBuffer();
    });
    expect(result).toEqual({ people: 3, filled: 2, photos: 1, missing: 1 });
    expect(db.saveRecruitingSavedProfile).toHaveBeenCalledTimes(2);
    // A saved work history stays; the search only adds the missing education.
    expect(db.saveRecruitingSavedProfile.mock.calls[1]![3]).toMatchObject({
      personKey: "linkedin:/in/dan",
      provider: "people_search",
      fetchedAt: new Date(danSaved.fetchedAt),
      profile: {
        experience: [{ title: "x" }],
        education: [{ school_name: "State U", degree: "BS" }],
      },
    });
    const [, , runId, input] = db.saveRecruitingSavedProfile.mock.calls[0]!;
    expect(runId).toBe("run1");
    expect(input).toMatchObject({
      personKey: "linkedin:/in/cara",
      sourceEffectId: "e1",
      fetchedAt: createdAt,
      profile: {
        headline: null,
        profileImageUrl: expect.stringMatching(/^data:image\/webp;base64,/),
        experience: [
          {
            title: "Manager",
            company_name: "Delta",
            start_date: "Feb 2020",
            end_date: null,
            is_current: true,
          },
          {
            title: "Lead",
            company_name: "Old",
            start_date: "2018",
            end_date: "Jan 2020",
            is_current: false,
          },
        ],
        education: [{ school_name: "State U", degree: "BS", start_date: null, end_date: null }],
      },
    });
  });
});

describe("keepSearchHistory", () => {
  const actor = {
    spaceId: "s1",
    userId: "u1",
    email: "owner@example.com",
    isDeploymentOwner: false,
  };
  beforeEach(() => vi.resetAllMocks());

  it("keeps a search's education on the saved profile so a later grading row cannot hide it", async () => {
    const complete = {
      personKey: "linkedin:/in/kim",
      provider: "people_search",
      fetchedAt: "2026-10-26T10:00:00.000Z",
      headline: null,
      profileImageUrl: null,
      experience: [{ title: "Lead" }],
      education: [{ school_name: "Old U" }],
    };
    db.listRecruitingSavedProfiles.mockResolvedValue(new Map([["linkedin:/in/kim", complete]]));
    db.saveRecruitingSavedProfile.mockImplementation(async (_p, _a, _r, input) => input.profile);
    const createdAt = new Date("2026-10-30T10:00:00Z");
    const result = await keepSearchHistory({} as never, actor, "run1", [
      {
        row: {
          name: "Joe Example",
          linkedin_url: "https://www.linkedin.com/in/joe-example",
          experience: "Site Leader | Amazon |  | Jan 2020 – Present",
          education: "Rutgers University | BS, Supply Chain | 2010 – 2014",
        },
        effectId: "e1",
        createdAt,
      },
      {
        row: {
          name: "Kim Example",
          linkedin_url: "https://www.linkedin.com/in/kim",
          education: "New U | MBA",
        },
        effectId: "e1",
        createdAt,
      },
      {
        row: { name: "No History", linkedin_url: "https://www.linkedin.com/in/none" },
        effectId: "e1",
        createdAt,
      },
    ]);
    expect(result.filled).toEqual(new Set(["linkedin:/in/joe-example"]));
    expect(db.saveRecruitingSavedProfile).toHaveBeenCalledTimes(1);
    expect(db.saveRecruitingSavedProfile.mock.calls[0]![3]).toMatchObject({
      personKey: "linkedin:/in/joe-example",
      provider: "people_search",
      sourceEffectId: "e1",
      fetchedAt: createdAt,
      profile: {
        experience: [{ title: "Site Leader", company_name: "Amazon", is_current: true }],
        education: [
          {
            school_name: "Rutgers University",
            degree: "BS, Supply Chain",
            start_date: "2010",
            end_date: "2014",
          },
        ],
      },
    });
  });
});
