import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { findClosedAskAnswer, recordClosedAskAnswer } from "./closed-asks.js";

const card = {
  kind: "ask",
  text: "Remote or onsite?",
  status: "expired",
  actions: [
    { id: "remote", label: "Remote is fine" },
    { id: "onsite", label: "Onsite only" },
  ],
};

function client(options: { runStatus: string; blocks?: unknown[]; newerCard?: boolean }) {
  let blocks = options.blocks ?? [card];
  const events: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: {
      findFirst: vi.fn(async (args: { where: { id?: string } }) =>
        args.where.id
          ? { botId: "sourcer", status: options.runStatus }
          : options.newerCard
            ? { id: "run-newer" }
            : null,
      ),
      findUnique: vi.fn(async () => ({ status: options.runStatus, startedAt: null })),
    },
    message: {
      findFirst: vi.fn(async () => ({ id: "ask-1", botId: "sourcer", blocks })),
      update: vi.fn(async (args: { data: { blocks: unknown[] } }) => {
        blocks = args.data.blocks;
        return {};
      }),
    },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 42, userId: "user-1" })) },
    event: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        events.push(args.data);
        return { threadId: "thread-1", ...args.data };
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (work: (inner: typeof tx) => unknown) => work(tx)),
  };
  return { prisma, events, blocks: () => blocks };
}

const target = { spaceId: "space-1", threadId: "thread-1", runId: "run-1", messageId: "ask-1" };

describe("closed cards", () => {
  it("reads a press on an expired card as the message the person would have typed", async () => {
    const { prisma } = client({ runStatus: "cancelled" });
    await expect(
      findClosedAskAnswer(prisma as unknown as PrismaClient, { ...target, answer: "onsite" }),
    ).resolves.toEqual({ botId: "sourcer", text: "Onsite only", recorded: "onsite" });
  });

  it("leaves a card whose run is still waiting to the live answer path", async () => {
    for (const runStatus of ["waiting_input", "queued", "running"]) {
      const { prisma } = client({ runStatus });
      await expect(
        findClosedAskAnswer(prisma as unknown as PrismaClient, { ...target, answer: "onsite" }),
      ).resolves.toBeNull();
    }
  });

  it("answers a stopped run's still-pending card the same way", async () => {
    const { prisma } = client({ runStatus: "cancelled", blocks: [{ ...card, status: "pending" }] });
    await expect(
      findClosedAskAnswer(prisma as unknown as PrismaClient, { ...target, answer: "remote" }),
    ).resolves.toMatchObject({ text: "Remote is fine" });
  });

  it("leaves a newer waiting card from the same agent to be answered on its own", async () => {
    const { prisma } = client({ runStatus: "cancelled", newerCard: true });
    await expect(
      findClosedAskAnswer(prisma as unknown as PrismaClient, { ...target, answer: "onsite" }),
    ).resolves.toBeNull();
  });

  it("does not answer a card twice", async () => {
    const { prisma } = client({
      runStatus: "cancelled",
      blocks: [{ ...card, status: "answered", answer: "remote" }],
    });
    await expect(
      findClosedAskAnswer(prisma as unknown as PrismaClient, { ...target, answer: "onsite" }),
    ).resolves.toBeNull();
    await expect(
      recordClosedAskAnswer(prisma as unknown as PrismaClient, {
        ...target,
        answer: { text: "Onsite only", recorded: "onsite" },
      }),
    ).resolves.toBeNull();
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it("records the answer on the card exactly as a live answer does", async () => {
    const { prisma, events, blocks } = client({ runStatus: "cancelled" });
    await expect(
      recordClosedAskAnswer(prisma as unknown as PrismaClient, {
        ...target,
        answer: { text: "Onsite only", recorded: "onsite" },
      }),
    ).resolves.toBe(41);
    expect(blocks()).toEqual([{ ...card, status: "answered", answer: "onsite" }]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "thread.message.updated",
        runId: "run-1",
        botId: "sourcer",
        payload: { messageId: "ask-1", role: "bot", blocks: blocks() },
      }),
    ]);
  });
});
