import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
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
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
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
    thread: {
      findUnique: vi.fn(async () => ({
        userId: "user",
        group: { id: "group" },
        activeRecruitingRole: { title: "Staff Engineer" },
      })),
    },
    user: {
      findUnique: vi.fn(async () => ({ email: "recruiter@example.test", emailVerified: true })),
    },
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
  it("skips a thread another transaction holds instead of waiting on it", async () => {
    const f = fixture();
    f.tx.$queryRaw.mockResolvedValueOnce([]);
    await reconcileRecruitingQuestions(f.deps);
    expect(f.tx.run.findFirst).not.toHaveBeenCalled();
    expect(f.tx.thread.update).not.toHaveBeenCalled();
  });
  it.each([{ approval: true }, { answered: true }, { previous: true }])(
    "does not nudge an approval, answered card or duplicate: %j",
    async (options) => {
      const f = fixture(options);
      const send = vi.fn(async () => undefined);
      await reconcileRecruitingQuestions({ ...f.deps, email: mailer(send) });
      expect(f.tx.thread.update).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("emails the verified owner once with a link to the conversation", async () => {
    const f = fixture();
    const send = vi.fn(async () => undefined);
    await reconcileRecruitingQuestions({
      ...f.deps,
      email: mailer(send),
      webOrigin: "https://app.example.test",
    });
    expect(send).toHaveBeenCalledWith({
      to: "recruiter@example.test",
      subject: "Staff Engineer: your answer is needed",
      text: "Kruit has a question before it can continue.\n\nOpen it: https://app.example.test/app/g/group",
    });
  });
  it("does not email an unverified address", async () => {
    const f = fixture();
    f.prisma.user.findUnique.mockResolvedValueOnce({
      email: "recruiter@example.test",
      emailVerified: false,
    });
    const send = vi.fn(async () => undefined);
    await reconcileRecruitingQuestions({ ...f.deps, email: mailer(send) });
    expect(send).not.toHaveBeenCalled();
  });
});

function mailer(send: TransactionalEmailProvider["send"]): TransactionalEmailProvider {
  return {
    describe: () => ({
      id: "test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { transactional: true },
    }),
    send,
  };
}
