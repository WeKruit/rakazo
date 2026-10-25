import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireQuickSearchBeforeResearch } from "./recruiting-research.js";

const db = vi.hoisted(() => ({ listRunToolResults: vi.fn() }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listRunToolResults: db.listRunToolResults,
}));

const context = { userId: "person-a", spaceId: "personal-a", runId: "run-1" };
const research = { transport: "streamable_http", endpoint: "https://api.autumn.ai/mcp" };

function prisma(counts: { search?: number; tasks?: number; accepted?: number } = {}) {
  return {
    run: { findFirst: vi.fn(async () => ({ thread: { activeRecruitingRoleId: "role-1" } })) },
    botMcpServer: { count: vi.fn(async () => counts.search ?? 1) },
    recruitingResearchTask: { count: vi.fn(async () => counts.tasks ?? 0) },
    recruitingCalibrationRound: { count: vi.fn(async () => counts.accepted ?? 0) },
  } as never;
}

describe("requireQuickSearchBeforeResearch", () => {
  beforeEach(() => db.listRunToolResults.mockReset().mockResolvedValue([]));

  it("sends a new role's first research to the people search", async () => {
    await expect(
      requireQuickSearchBeforeResearch(prisma(), context, research, "research", { prompt: "x" }),
    ).rejects.toThrow("built-in people search");
  });

  it("allows research to top up a people search from the same run", async () => {
    db.listRunToolResults.mockResolvedValue([
      { endpoint: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa" },
    ]);
    await expect(
      requireQuickSearchBeforeResearch(prisma(), context, research, "research", { prompt: "x" }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["no people search assigned", { search: 0 }],
    ["research already exists", { tasks: 1 }],
    ["a round was accepted", { accepted: 1 }],
  ])("keeps the existing flow when %s", async (_label, counts) => {
    await expect(
      requireQuickSearchBeforeResearch(prisma(counts), context, research, "research", {
        prompt: "x",
      }),
    ).resolves.toBeUndefined();
  });

  it("leaves follow-ups and other connectors alone", async () => {
    const p = prisma();
    await requireQuickSearchBeforeResearch(p, context, research, "get_task", { task_id: "t" });
    await requireQuickSearchBeforeResearch(
      p,
      context,
      { transport: "streamable_http", endpoint: "https://mcp.example.test/mcp" },
      "research",
      {},
    );
    expect(db.listRunToolResults).not.toHaveBeenCalled();
  });
});
