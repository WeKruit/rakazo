import type { Actor } from "@rakazo/contracts";
import { ReadRecruitingViewInput } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { readRecruitingView } from "./recruiting-read-view.js";

const reads = vi.hoisted(() => ({ workspace: vi.fn(), candidates: vi.fn(), research: vi.fn() }));
vi.mock("./recruiting.js", () => ({
  getRecruitingWorkspace: reads.workspace,
  listRecruitingCandidates: reads.candidates,
  listRecruitingResearch: reads.research,
}));
const actor = {
  userId: "test-user",
  spaceId: "test-space",
  email: "test@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
const deps = { prisma: {}, artifacts: {} } as Parameters<typeof readRecruitingView>[0];
const workspace = { role: { id: "role" }, revision: { id: "revision" }, crmTarget: null };
const page = { roleId: "role", roleRevisionId: "revision", items: [] };
const input = {
  kind: "candidates" as const,
  threadId: "thread",
  roleId: "role",
  roleRevisionId: "revision",
  query: { limit: 30 },
};
beforeEach(() => {
  vi.resetAllMocks();
  reads.workspace.mockResolvedValue(workspace);
  reads.candidates.mockResolvedValue(page);
  reads.research.mockResolvedValue({ tasks: [], actions: [], observations: [] });
});

it("returns a candidate view only after a fresh scoped post-read binding check", async () => {
  const result = await readRecruitingView(deps, actor, input);
  expect(result).toEqual({ kind: "candidates", workspace, data: page });
  expect(reads.workspace).toHaveBeenCalledTimes(2);
  expect(reads.workspace).toHaveBeenNthCalledWith(2, deps.prisma, actor, { threadId: "thread" });
  expect(reads.candidates).toHaveBeenCalledWith(deps, actor, { roleId: "role", limit: 30 });
  expect(reads.workspace.mock.invocationCallOrder[0]).toBeLessThan(
    reads.candidates.mock.invocationCallOrder[0]!,
  );
  expect(reads.workspace.mock.invocationCallOrder[1]).toBeGreaterThan(
    reads.candidates.mock.invocationCallOrder[0]!,
  );
});
it("does not read a role outside the initially authorized thread binding", async () => {
  reads.workspace.mockResolvedValue({ ...workspace, role: { id: "other" } });
  expect((await readRecruitingView(deps, actor, input)).data).toBeNull();
  expect(reads.candidates).not.toHaveBeenCalled();
});
it.each(["role", "revision", "missing"])(
  "discards candidate data when the post-read binding changes: %s",
  async (change) => {
    const next = change === "missing" ? null : { ...workspace, [change]: { id: "changed" } };
    reads.workspace.mockResolvedValueOnce(workspace).mockResolvedValueOnce(next);
    expect(await readRecruitingView(deps, actor, input)).toEqual({
      kind: "candidates",
      workspace: next,
      data: null,
    });
  },
);
it.each(["roleId", "roleRevisionId"])(
  "rejects mismatched candidate data provenance: %s",
  async (field) => {
    reads.candidates.mockResolvedValue({ ...page, [field]: "other" });
    expect((await readRecruitingView(deps, actor, input)).data).toBeNull();
  },
);
it.each(["initial", "post-read"])(
  "propagates account/Space denial at %s without returning data",
  async (phase) => {
    const denied = new Error("Scope denied");
    if (phase === "post-read") reads.workspace.mockResolvedValueOnce(workspace);
    reads.workspace.mockRejectedValueOnce(denied);
    await expect(readRecruitingView(deps, actor, input)).rejects.toBe(denied);
    if (phase === "initial") expect(reads.candidates).not.toHaveBeenCalled();
  },
);
it("discards research on a concurrent role revision change", async () => {
  reads.workspace
    .mockResolvedValueOnce(workspace)
    .mockResolvedValueOnce({ ...workspace, revision: { id: "next" } });
  const result = await readRecruitingView(deps, actor, {
    kind: "research",
    threadId: "thread",
    roleId: "role",
    roleRevisionId: "revision",
  });
  expect(result.data).toBeNull();
  expect(reads.research).toHaveBeenCalledWith(deps.prisma, actor, { roleId: "role" });
});
it("rejects role overrides and unbounded candidate reads at the contract boundary", () => {
  expect(ReadRecruitingViewInput.safeParse({ ...input, query: { roleId: "other" } }).success).toBe(
    false,
  );
  expect(ReadRecruitingViewInput.safeParse({ ...input, query: { limit: 201 } }).success).toBe(
    false,
  );
});
it("does not return research tasks from a different role", async () => {
  reads.research.mockResolvedValue({
    tasks: [{ id: "task", roleId: "other" }],
    actions: [],
    observations: [],
  });
  expect(
    (
      await readRecruitingView(deps, actor, {
        kind: "research",
        threadId: "thread",
        roleId: "role",
        roleRevisionId: "revision",
      })
    ).data,
  ).toBeNull();
});
it("rechecks session authorization after data reads before returning any view", async () => {
  const stillAuthorized = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(readRecruitingView(deps, actor, input, stillAuthorized)).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  expect(stillAuthorized).toHaveBeenCalledTimes(2);
  expect(reads.candidates).toHaveBeenCalledOnce();
});
it("never starts data reads for an already revoked session", async () => {
  await expect(readRecruitingView(deps, actor, input, async () => false)).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  expect(reads.candidates).not.toHaveBeenCalled();
});
