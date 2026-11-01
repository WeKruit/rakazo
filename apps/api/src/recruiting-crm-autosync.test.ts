import { indexSavedRecruitingInbox } from "@rakazo/adapters/recruiting-reads";
import type { PrismaClient } from "@rakazo/db";
import { indexRecruitingInboxBatch } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  indexRecruitingStoredMailOwner,
  startRecruitingCrmAutoSync,
  syncRecruitingCrmOwner,
} from "./recruiting-crm-autosync.js";
import { syncRecruitingCrm } from "./recruiting-crm-sync.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  indexRecruitingInboxBatch: vi.fn(),
}));
vi.mock("@rakazo/adapters/recruiting-reads", () => ({ indexSavedRecruitingInbox: vi.fn() }));
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

describe("saved-mail background indexing", () => {
  beforeEach(() => {
    vi.mocked(syncRecruitingCrm).mockReset();
    vi.mocked(indexRecruitingInboxBatch).mockReset();
    vi.mocked(indexSavedRecruitingInbox).mockReset();
  });
  afterEach(() => vi.useRealTimers());
  const fixture = () =>
    ({
      spaceMember: { findUnique: vi.fn(async () => ({ userId: owner.userId })) },
    }) as unknown as PrismaClient;
  it("runs every concrete chunk to completion without another Inbox read or a provider call", async () => {
    vi.mocked(indexRecruitingInboxBatch).mockImplementation(async (_prisma, _actor, authorize) => {
      await authorize?.();
      return {
        importsComplete: vi.mocked(indexRecruitingInboxBatch).mock.calls.length >= 48,
        crmComplete: true,
      };
    });
    await indexRecruitingStoredMailOwner(fixture(), owner);
    expect(indexRecruitingInboxBatch).toHaveBeenCalledTimes(48);
    expect(indexSavedRecruitingInbox).toHaveBeenCalledTimes(1);
    expect(syncRecruitingCrm).not.toHaveBeenCalled();
  });
  it("stops a revoked owner's batch before metadata or messages commit", async () => {
    const prisma = fixture();
    vi.mocked(prisma.spaceMember.findUnique).mockResolvedValue(null);
    vi.mocked(indexRecruitingInboxBatch).mockImplementation(async (_prisma, _actor, authorize) => {
      await authorize?.();
      return { importsComplete: true, crmComplete: true };
    });
    await expect(indexRecruitingStoredMailOwner(prisma, owner)).rejects.toThrow();
    expect(indexSavedRecruitingInbox).not.toHaveBeenCalled();
  });
  it("runs for native/import-only owners without a configured CRM endpoint", async () => {
    vi.useFakeTimers();
    vi.mocked(indexRecruitingInboxBatch).mockResolvedValue({
      importsComplete: true,
      crmComplete: true,
    });
    const prisma = {
      ...fixture(),
      $queryRaw: vi.fn(async () => [owner]),
    } as unknown as PrismaClient;
    startRecruitingCrmAutoSync({
      prisma,
      connectors: { execute: vi.fn() },
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(indexRecruitingInboxBatch).toHaveBeenCalledTimes(1);
    expect(indexSavedRecruitingInbox).toHaveBeenCalledTimes(1);
    expect(syncRecruitingCrm).not.toHaveBeenCalled();
  });
});
