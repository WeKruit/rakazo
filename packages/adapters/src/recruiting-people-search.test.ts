import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveRecruitingPeopleSearch } from "./recruiting-tools.js";

const db = vi.hoisted(() => ({
  listRunToolResults: vi.fn(),
  saveRecruitingCandidatePeopleSearch: vi.fn(async (..._args: unknown[]) => ({ saved: true })),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listRunToolResults: db.listRunToolResults,
  saveRecruitingCandidatePeopleSearch: db.saveRecruitingCandidatePeopleSearch,
}));

const ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa";
const context = { userId: "user-1", spaceId: "space-1", runId: "run-1" } as never;
const trusted = {
  actor: { userId: "user-1", spaceId: "space-1" },
  runId: "run-1",
  leaseOwner: "worker",
  leaseFence: 1,
  effectId: "save-2",
  effectRequest: {},
} as never;

function call(effectId: string, minute: number, name: string) {
  return {
    effectId,
    toolName: "web_search_exa",
    endpoint: ENDPOINT,
    createdAt: new Date(2026, 9, 26, 3, minute),
    result: {
      content: [
        { type: "text", text: `Title: ${name}\nURL: https://www.linkedin.com/in/${name}\n` },
      ],
    },
  };
}

function deps(previousSave: Date | null) {
  return {
    prisma: {
      externalEffect: {
        findFirst: vi.fn(async () => (previousSave ? { createdAt: previousSave } : null)),
      },
    },
    artifacts: { put: vi.fn(async () => ({ id: "artifact-1" })) },
  } as never;
}

describe("saveRecruitingPeopleSearch", () => {
  beforeEach(() => {
    db.saveRecruitingCandidatePeopleSearch.mockClear();
    // Newest first, as the run's tool results are listed.
    db.listRunToolResults.mockResolvedValue([
      call("search-2", 5, "second"),
      call("search-1", 1, "first"),
    ]);
  });

  const saved = () =>
    (
      db.saveRecruitingCandidatePeopleSearch.mock.calls[0]![4] as {
        rows: Array<{ row: { name: string } }>;
      }
    ).rows.map(({ row }) => row.name);

  it("saves every search of the run on its first save", async () => {
    await saveRecruitingPeopleSearch(deps(null), trusted, {} as never, context);
    expect(saved()).toEqual(["first", "second"]);
  });

  it("saves only the searches made after the run's previous save", async () => {
    await saveRecruitingPeopleSearch(
      deps(new Date(2026, 9, 26, 3, 3)),
      trusted,
      {} as never,
      context,
    );
    expect(saved()).toEqual(["second"]);
  });
});
