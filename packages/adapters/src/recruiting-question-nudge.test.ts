import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { reconcileRecruitingQuestions } from "./recruiting-question-nudge.js";

vi.mock("@rakazo/db", () => ({ appendEventInTransaction: vi.fn(async () => ({ seq: 9 })) }));

function fixture(options: { approval?: boolean; answered?: boolean; previous?: boolean } = {}) {
  const run = {
    id: "run",
    threadId: "thread",
    spaceId: "space",
    botId: "bot",
    updatedAt: new Date("2026-10-23T00:00:00Z"),
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: { findFirst: vi.fn(async () => (options.answered ? null : { id: run.id })) },
    message: {
      findFirst: vi.fn(async () => ({
        id: "card",
        blocks: [
          {
            kind: "ask",
            status: "pending",
            ...(options.approval ? { approvalEffectId: "effect" } : {}),
          },
        ],
      })),
    },
    event: { findFirst: vi.fn(async () => (options.previous ? { id: "notice" } : null)) },
    thread: { update: vi.fn(async () => ({})) },
  };
  const prisma = {
    run: { findMany: vi.fn(async () => [run]) },
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  };
  const notify = vi.fn(async () => undefined);
  return {
    tx,
    prisma,
    notify,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      events: { notify } as never,
      now: new Date("2026-10-23T00:10:00Z"),
      batchSize: 100,
    },
  };
}

describe("recruiting question nudge", () => {
  it("marks the existing conversation unread once without starting work or answering", async () => {
    const f = fixture();
    await reconcileRecruitingQuestions(f.deps);
    expect(f.prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "waiting_input",
          updatedAt: { lte: new Date("2026-10-23T00:00:00Z") },
        }),
      }),
    );
    expect(f.tx.thread.update).toHaveBeenCalledWith({
      where: { id: "thread" },
      data: { unread: true },
    });
    expect(f.notify).toHaveBeenCalledWith("thread", 9);
  });
  it.each([{ approval: true }, { answered: true }, { previous: true }])(
    "does not nudge an approval, answered card or duplicate: %j",
    async (options) => {
      const f = fixture(options);
      await reconcileRecruitingQuestions(f.deps);
      expect(f.tx.thread.update).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
    },
  );
});
