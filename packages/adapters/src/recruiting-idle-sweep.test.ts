import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepIdleRecruitingRoles } from "./recruiting-idle-sweep.js";
import type * as TurnEndGuard from "./turn-end-guard.js";
import { guardRecruitingTurnEnd } from "./turn-end-guard.js";

vi.mock("./turn-end-guard.js", async (original) => ({
  ...(await original<typeof TurnEndGuard>()),
  guardRecruitingTurnEnd: vi.fn(async () => ({
    action: "continued",
    runId: "next",
    stage: "calibration_10",
    label: "出 10 人校准名单",
    count: 1,
  })),
}));

const now = new Date("2026-10-24T22:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

function fixture(
  options: {
    status?: string;
    updatedAt?: Date;
    busy?: boolean;
    pending?: boolean;
    autoContinues?: number;
  } = {},
) {
  const run = {
    id: "run",
    spaceId: "space",
    threadId: "thread",
    botId: "main",
    userId: "user",
    trigger: "user",
    status: options.status ?? "failed",
    updatedAt: options.updatedAt ?? minutesAgo(30),
  };
  const prisma = {
    thread: {
      findMany: vi.fn(async () => [{ id: "thread", activeRecruitingRoleId: "role" }]),
    },
    run: {
      findFirst: vi.fn(async (args: { where: { threadId?: string } }) =>
        args.where.threadId ? run : options.busy ? { id: "specialist" } : null,
      ),
    },
    message: {
      findMany: vi.fn(async () => [
        ...Array.from({ length: options.autoContinues ?? 0 }, (_, i) => ({
          clientNonce: `autocontinue:earlier:${i}`,
        })),
        { clientNonce: null },
      ]),
      findFirst: vi.fn(async () => ({
        blocks: options.pending
          ? [{ kind: "ask", status: "pending" }]
          : [{ kind: "text", text: "搜索出错了" }],
      })),
    },
  };
  const sweep = () =>
    sweepIdleRecruitingRoles({
      prisma: prisma as unknown as PrismaClient,
      jobs: { enqueue: vi.fn() } as unknown as JobPublisher,
      events: { sendUserMessage: vi.fn() } as unknown as ThreadEvents,
      now,
      batchSize: 10,
      max: 3,
    });
  return { prisma, sweep };
}

describe("sweepIdleRecruitingRoles", () => {
  beforeEach(() => vi.mocked(guardRecruitingTurnEnd).mockClear());

  it("re-applies the turn-end guard to a role thread whose last turn failed", async () => {
    const { sweep } = fixture();
    expect(await sweep()).toBe(1);
    expect(guardRecruitingTurnEnd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        roleId: "role",
        run: expect.objectContaining({ id: "run", trigger: "user" }),
        blocks: [{ kind: "text", text: "搜索出错了" }],
        max: 3,
      }),
    );
  });

  it("only looks at recent idle threads with no work running", async () => {
    const { prisma, sweep } = fixture();
    await sweep();
    expect(prisma.thread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          activeRecruitingRole: { archivedAt: null },
          runs: {
            some: {
              status: { in: ["completed", "failed"] },
              updatedAt: { gte: minutesAgo(24 * 60), lte: minutesAgo(10) },
            },
            none: { status: { in: expect.arrayContaining(["running", "waiting_input"]) } },
          },
        }),
      }),
    );
  });

  it.each([
    ["a turn the user stopped", { status: "cancelled" }],
    ["a turn that just ended", { updatedAt: minutesAgo(2) }],
    ["a specialist still working on the role", { busy: true }],
    ["a pending question card", { pending: true }],
    ["the cap already reached since the last human message", { autoContinues: 3 }],
  ])("leaves %s alone", async (_, options) => {
    const { sweep } = fixture(options);
    expect(await sweep()).toBe(0);
    expect(guardRecruitingTurnEnd).not.toHaveBeenCalled();
  });
});
