import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  assignedMcpEndpoints: vi.fn(),
  listRecruitingSavedProfiles: vi.fn(),
  listRunToolResults: vi.fn(),
  saveRecruitingSavedProfile: vi.fn(),
}));
vi.mock("@rakazo/db", () => db);

import {
  executeRecruitingProfilesTool,
  linkedinPersonKey,
  profileFromLookup,
  RecruitingProfileError,
} from "./recruiting-profiles.js";

const ENDPOINT = "https://mcp.coresignal.com/mcp/v2";
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
  it("tells the agent to request the connection when none is assigned", async () => {
    db.listRecruitingSavedProfiles.mockResolvedValue(new Map());
    db.assignedMcpEndpoints.mockResolvedValue(["https://api.autumn.ai/mcp"]);
    const missing = await executeRecruitingProfilesTool(
      prisma,
      actor,
      "run1",
      { operation: "list", candidateKeys: [KEY] },
      "bot1",
    );
    expect(missing).toMatchObject({ next: expect.stringContaining("request_connection") });
    db.assignedMcpEndpoints.mockResolvedValue([ENDPOINT]);
    expect(
      await executeRecruitingProfilesTool(
        prisma,
        actor,
        "run1",
        { operation: "list", candidateKeys: [KEY] },
        "bot1",
      ),
    ).toEqual({ items: [{ candidateKey: KEY, saved: false }] });
  });
});
