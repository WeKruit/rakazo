import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncRecruitingCrmOwner } from "./recruiting-crm-autosync.js";
import { syncRecruitingCrm } from "./recruiting-crm-sync.js";

vi.mock("./recruiting-crm-sync.js", () => ({ syncRecruitingCrm: vi.fn() }));
vi.mock("./thread-target.js", () => ({
  resolveThreadTarget: vi.fn(async () => ({ kind: "group", threadId: "thread" })),
}));

const owner = { userId: "user", spaceId: "space", email: "person@example.test" };
const report = (nextCursor: string | null) =>
  ({ nextCursor }) as Awaited<ReturnType<typeof syncRecruitingCrm>>;

function deps(saved: { token: string; targetKey: string } | null) {
  return {
    prisma: {
      recruitingCrmSyncProgress: { findUnique: vi.fn(async () => saved) },
      spaceMember: { findFirst: vi.fn(async () => ({ userId: "user" })) },
    } as unknown as PrismaClient,
    connectors: { execute: vi.fn() },
  };
}

describe("CRM auto-sync", () => {
  beforeEach(() => vi.mocked(syncRecruitingCrm).mockReset());

  it("resumes an unfinished pass and runs it to the end", async () => {
    vi.mocked(syncRecruitingCrm)
      .mockResolvedValueOnce(report("second"))
      .mockResolvedValueOnce(report(null));
    await syncRecruitingCrmOwner(
      deps({ token: "saved", targetKey: JSON.stringify(["group", "thread"]) }),
      owner,
    );
    expect(vi.mocked(syncRecruitingCrm).mock.calls.map((call) => call[3])).toEqual([
      { cursor: "saved" },
      { cursor: "second" },
    ]);
    expect(vi.mocked(syncRecruitingCrm).mock.calls[0]![1]).toMatchObject({
      userId: "user",
      spaceId: "space",
      isDeploymentOwner: false,
    });
  });

  it("starts over once when the saved pass can no longer continue", async () => {
    vi.mocked(syncRecruitingCrm)
      .mockRejectedValueOnce(new Error("Start the CRM sync again."))
      .mockResolvedValueOnce(report(null));
    await syncRecruitingCrmOwner(
      deps({ token: "stale", targetKey: JSON.stringify(["group", "thread"]) }),
      owner,
    );
    expect(vi.mocked(syncRecruitingCrm).mock.calls.map((call) => call[3])).toEqual([
      { cursor: "stale" },
      { cursor: undefined },
    ]);
  });

  it("stops at a failure of a fresh pass so the next check retries", async () => {
    vi.mocked(syncRecruitingCrm).mockRejectedValueOnce(new Error("CRM unavailable"));
    await expect(syncRecruitingCrmOwner(deps(null), owner)).rejects.toThrow("CRM unavailable");
    expect(syncRecruitingCrm).toHaveBeenCalledTimes(1);
  });
});
