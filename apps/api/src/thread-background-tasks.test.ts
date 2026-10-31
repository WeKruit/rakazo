import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, threadStopRunWhere } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import { cancelThreadBackgroundTask, listThreadBackgroundTasks } from "./thread-target.js";

const actor = { spaceId: "space", userId: "owner" } as Actor;
const target = { kind: "bot", botId: "bot", threadId: "thread" } as ThreadTarget;
const scope = { spaceId: "space", userId: "owner", threadId: "thread" };

describe("stop scopes", () => {
  it("keeps background tools, automation and handed-off stages out of Stop", () => {
    expect(threadStopRunWhere("thread")).toMatchObject({
      threadId: "thread",
      trigger: {
        notIn: expect.arrayContaining([
          "tool_background",
          "recruiting_research",
          "recruiting_grade",
          "routine",
        ]),
      },
      NOT: { sourceMessage: { is: { blocks: { array_contains: [{ kind: "handoff" }] } } } },
    });
    expect(threadStopRunWhere("thread", undefined, "all")).not.toHaveProperty("trigger");
    expect(threadStopRunWhere("thread", "stage")).toMatchObject({
      threadId: "thread",
      id: "stage",
    });
    expect(threadStopRunWhere("thread", "stage")).not.toHaveProperty("NOT");
  });
});

function fixture(owned = true) {
  const research = {
    findMany: vi.fn(async () => [{ id: "research" }]),
    findFirst: vi.fn(async () =>
      owned ? { id: "research", providerTaskId: "provider-task" } : null,
    ),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const cloud = {
    findMany: vi.fn(async () => [{ id: "cloud", cancelRequested: true }]),
    findFirst: vi.fn(async () => (owned ? { id: "cloud" } : null)),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const tx = {
    $queryRaw: vi.fn(),
    recruitingResearchTask: research,
    cloudAgent: cloud,
    externalEffect: {
      findMany: vi.fn(async () => [{ id: "search-effect" }]),
      findFirst: vi.fn(async () =>
        owned ? { id: "search-effect", idempotencyKey: "work_estimate:agent_run_example" } : null,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    run: {
      findMany: vi.fn(async () => [{ id: "research-wake" }]),
      findFirst: vi.fn(async () => (owned ? { id: "native-background" } : null)),
    },
  };
  const prisma = {
    ...tx,
    run: { findMany: vi.fn(async () => [{ id: "native-background" }]) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { prisma: prisma as unknown as PrismaClient, research, cloud, tx };
}

it("lists only records sharing the already-authorized thread's owner in one snapshot query", async () => {
  const f = fixture();
  const rows = [
    { id: "research", kind: "research", status: "running" },
    { id: "cloud", kind: "cloud_agent", status: "cancelling" },
    { id: "native-background", kind: "run", status: "running" },
    { id: "search-effect", kind: "agent_run", status: "running" },
  ];
  f.tx.$queryRaw.mockResolvedValueOnce(rows);
  expect(await listThreadBackgroundTasks(f.prisma, target)).toEqual(rows);
  expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
  const [parts, ...values] = f.tx.$queryRaw.mock.calls[0]!;
  const sql = (parts as TemplateStringsArray).join("?");
  expect(values[0]).toBe("thread");
  expect(sql).toContain('r."spaceId" = o."spaceId" AND r."userId" = o."userId"');
  expect(sql).toContain('c."spaceId" = o."spaceId" AND c."userId" = o."userId"');
  expect(sql).toContain('rr."spaceId" = o."spaceId" AND rr."userId" = o."userId"');
  expect(sql).toContain('e."spaceId" = o."spaceId"');
  expect(sql).toContain("starts_with(e.\"idempotencyKey\", 'work_estimate:agent_run_')");
  expect(JSON.stringify(values)).toContain("recruiting_grade");
  expect(JSON.stringify(values)).toContain("tool_background");
});

it("closes one research follow-up without touching other work", async () => {
  const f = fixture();
  const wakes = await cancelThreadBackgroundTask(f.prisma, actor, target, {
    id: "research",
    kind: "research",
  });
  expect(wakes).toEqual(["research-wake"]);
  expect(f.tx.run.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        ...scope,
        OR: [
          { clientNonce: "recruiting-research-wake:research:provider-task" },
          { clientNonce: { startsWith: "recruiting-research-wake:research:provider-task:" } },
        ],
      }),
    }),
  );
  expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
  expect(f.research.updateMany).toHaveBeenCalledExactlyOnceWith({
    where: { id: "research", state: "active", createdByRun: scope },
    data: { state: "closed" },
  });
  expect(f.cloud.updateMany).not.toHaveBeenCalled();
});

it("requests cloud cancellation through its existing outbox without claiming it finished", async () => {
  const f = fixture();
  await cancelThreadBackgroundTask(f.prisma, actor, target, { id: "cloud", kind: "cloud_agent" });
  expect(f.cloud.updateMany).toHaveBeenCalledExactlyOnceWith({
    where: { id: "cloud", ...scope, status: "running" },
    data: { cancelRequested: true, version: { increment: 1 }, nextPollAt: expect.any(Date) },
  });
  expect(f.research.updateMany).not.toHaveBeenCalled();
});

it("stops following one search and returns its active native wakes for cancellation", async () => {
  const f = fixture();
  expect(
    await cancelThreadBackgroundTask(f.prisma, actor, target, {
      id: "search-effect",
      kind: "agent_run",
    }),
  ).toEqual(["research-wake"]);
  expect(f.tx.externalEffect.updateMany).toHaveBeenCalledExactlyOnceWith({
    where: {
      id: "search-effect",
      kind: "work_estimate",
      status: "running",
      idempotencyKey: { startsWith: "work_estimate:agent_run_" },
      spaceId: "space",
      run: scope,
    },
    data: { status: "cancelled" },
  });
  expect(f.tx.run.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        ...scope,
        clientNonce: { startsWith: "recruiting-agent-run-wait:agent_run_example:" },
      }),
    }),
  );
});

it("only selects owned native automation or handed-off tasks for cancellation", async () => {
  const f = fixture();
  expect(
    await cancelThreadBackgroundTask(f.prisma, actor, target, {
      id: "native-background",
      kind: "run",
    }),
  ).toEqual(["native-background"]);
  expect(f.tx.run.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        ...scope,
        id: "native-background",
        OR: [
          {
            trigger: {
              in: expect.arrayContaining([
                "tool_background",
                "recruiting_grade",
                "routine",
                "webhook",
              ]),
            },
          },
          { sourceMessage: { is: { blocks: { array_contains: [{ kind: "handoff" }] } } } },
        ],
      }),
    }),
  );
});

it.each(["research", "cloud_agent", "agent_run", "run"] as const)(
  "rejects another account's %s task before mutation",
  async (kind) => {
    const f = fixture(false);
    await expect(
      cancelThreadBackgroundTask(f.prisma, actor, target, { id: "foreign", kind }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(f.research.updateMany).not.toHaveBeenCalled();
    expect(f.cloud.updateMany).not.toHaveBeenCalled();
    expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
  },
);
