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
const context = {
  userId: "user-1",
  spaceId: "space-1",
  runId: "run-1",
  signal: new AbortController().signal,
} as never;
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

type Save = { createdAt: Date; idempotencyKey: string; result: unknown };

const updateMany = vi.fn(async (..._args: unknown[]) => ({ count: 1 }));

function deps(
  previousSave: Date | null,
  autoSaves: Save[] = [],
  role?: { asked: string; held: string[] },
) {
  const saves: Save[] = [
    ...(previousSave ? [{ createdAt: previousSave, idempotencyKey: "explicit", result: {} }] : []),
    ...autoSaves,
  ];
  const held = role?.held.map((name) => `linkedin:/in/${name}`) ?? [];
  return {
    prisma: {
      externalEffect: {
        findMany: vi.fn(async () => saves),
        updateMany,
      },
      run: {
        findFirst: vi.fn(async () =>
          role ? { threadId: "thread-1", thread: { activeRecruitingRoleId: "role-1" } } : null,
        ),
      },
      message: {
        findMany: vi.fn(async () => [
          { createdAt: new Date(2026, 9, 26, 3, 0), blocks: [{ kind: "text", text: role?.asked }] },
        ]),
      },
      recruitingCandidate: {
        count: vi.fn(async () => held.length),
        findMany: vi.fn(async ({ where }: { where: { candidateKey: { in: string[] } } }) =>
          where.candidateKey.in
            .filter((key) => held.includes(key))
            .map((candidateKey) => ({
              candidateKey,
            })),
        ),
      },
      // Everyone held was saved after the ask, by this search.
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async ({ where }: { where: { page: { observedAt: { lt?: Date } } } }) =>
          where.page.observedAt.lt ? [] : held.map((candidateKey) => ({ candidateKey })),
        ),
      },
    },
    artifacts: { put: vi.fn(async () => ({ id: "artifact-1" })) },
  } as never;
}

describe("saveRecruitingPeopleSearch", () => {
  beforeEach(() => {
    db.saveRecruitingCandidatePeopleSearch.mockClear();
    updateMany.mockClear();
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

  it("saves no more new people than the recruiter's number leaves room for", async () => {
    // Long-search-finishes 11-20 (dc97b5bc): "最多20个" saved 25. With 19 held, one more fits;
    // someone already held is saved again whatever the number.
    db.listRunToolResults.mockResolvedValue([
      call("search-3", 7, "third"),
      call("search-2", 5, "second"),
      call("search-1", 1, "first"),
    ]);
    const held = ["first", ...Array.from({ length: 18 }, (_, i) => `held-${i}`)];
    await saveRecruitingPeopleSearch(
      deps(null, [], { asked: "Senior SRE in Austin, at most 20", held }),
      trusted,
      {} as never,
      context,
    );
    expect(saved()).toEqual(["first", "second"]);
  });

  it("saves just the one search that returned when the server saves it as it returns", async () => {
    await saveRecruitingPeopleSearch(deps(null), trusted, {} as never, context, "search-2");
    expect(saved()).toEqual(["second"]);
  });

  const autoSave = (search: string, minute: number, key: string): Save => ({
    createdAt: new Date(2026, 9, 26, 3, minute),
    idempotencyKey: `people-search-autosave:${search}`,
    result: { candidateRows: [{ candidateKey: key, alreadyInPool: false, name: key }] },
  });

  it("returns the rows already saved as searches returned instead of saving them again", async () => {
    const result = await saveRecruitingPeopleSearch(
      deps(null, [autoSave("search-1", 2, "first"), autoSave("search-2", 6, "second")]),
      trusted,
      {} as never,
      context,
    );
    expect(db.saveRecruitingCandidatePeopleSearch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "saved",
      newPeople: 2,
      candidateRows: [{ candidateKey: "first" }, { candidateKey: "second" }],
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "save-2", status: "executing" } }),
    );
  });

  it("saves only the searches the server did not save yet and lists both", async () => {
    db.saveRecruitingCandidatePeopleSearch.mockResolvedValueOnce({
      status: "saved",
      candidateRows: [{ candidateKey: "second", alreadyInPool: false }],
    } as never);
    const result = await saveRecruitingPeopleSearch(
      deps(null, [autoSave("search-1", 2, "first")]),
      trusted,
      {} as never,
      context,
    );
    expect(saved()).toEqual(["second"]);
    expect(result).toMatchObject({
      newPeople: 2,
      candidateRows: [{ candidateKey: "first" }, { candidateKey: "second" }],
    });
  });
});
