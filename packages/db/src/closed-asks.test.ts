import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { findClosedAskAnswer, recordClosedAskAnswer } from "./closed-asks.js";
import { mirrorAskInTransaction, syncMirroredAsksInTransaction } from "./mirrored-asks.js";

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

  it("records a sign-in on a connect card that typing closed as not connected", async () => {
    const connect = {
      kind: "ask",
      text: "Connect Gmail",
      status: "answered",
      answer: "not_connected",
      connection: { serverId: "server-1", name: "Gmail", reason: "Send the email" },
    };
    const { prisma, blocks } = client({ runStatus: "completed", blocks: [connect] });
    const found = await findClosedAskAnswer(prisma as unknown as PrismaClient, {
      ...target,
      answer: "connected",
    });
    expect(found).toEqual({ botId: "sourcer", text: "Connected Gmail.", recorded: "connected" });
    await recordClosedAskAnswer(prisma as unknown as PrismaClient, { ...target, answer: found! });
    expect(blocks()).toEqual([{ ...connect, answer: "connected" }]);
    // Signed in: nothing more to record.
    await expect(
      findClosedAskAnswer(prisma as unknown as PrismaClient, { ...target, answer: "connected" }),
    ).resolves.toBeNull();
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

describe("a role team's card copied into the conversation that delegated the work", () => {
  type Row = {
    id: string;
    threadId: string;
    runId: string;
    botId: string;
    role: string;
    blocks: unknown[];
    clientNonce?: string;
  };
  function store(sourceBlocks: unknown[]) {
    const rows: Row[] = [
      {
        id: "source",
        threadId: "role",
        runId: "team-run",
        botId: "main",
        role: "bot",
        blocks: sourceBlocks,
      },
    ];
    const events: Array<Record<string, unknown>> = [];
    const tx = {
      message: {
        findFirst: vi.fn(
          async ({ where }: { where: { id?: string; threadId?: string; clientNonce?: string } }) =>
            rows.find((row) =>
              where.clientNonce
                ? row.clientNonce === where.clientNonce
                : row.id === where.id && row.threadId === where.threadId,
            ) ?? null,
        ),
        findUnique: vi.fn(
          async ({
            where,
          }: {
            where: { threadId_clientNonce: { threadId: string; clientNonce: string } };
          }) =>
            rows.find(
              (row) =>
                row.threadId === where.threadId_clientNonce.threadId &&
                row.clientNonce === where.threadId_clientNonce.clientNonce,
            ) ?? null,
        ),
        findMany: vi.fn(
          async ({ where }: { where: { runId: string; threadId: { not: string } } }) =>
            rows.filter((row) => row.runId === where.runId && row.threadId !== where.threadId.not),
        ),
        create: vi.fn(async ({ data }: { data: Omit<Row, "id"> }) => {
          const row = { ...data, id: `copy-${rows.length}` };
          rows.push(row);
          return row;
        }),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: { blocks: unknown[] } }) => {
            rows.find((row) => row.id === where.id)!.blocks = data.blocks;
            return {};
          },
        ),
      },
      thread: {
        update: vi.fn(async () => ({ nextEventSeq: 7, nextMessageSeq: 3, userId: "user-1" })),
      },
      run: { findUnique: vi.fn(async () => ({ status: "waiting_input", startedAt: null })) },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          events.push(data);
          return data;
        }),
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, rows, events };
  }
  const question = {
    kind: "ask",
    text: "Remote or onsite?",
    status: "pending",
    actions: card.actions,
  };
  const mirror = {
    spaceId: "space-1",
    sourceThreadId: "role",
    sourceMessageId: "source",
    runId: "team-run",
    targetThreadId: "main-chat",
    botId: "kruit",
  };

  it("writes one copy that points at the card, however often the pause is replayed", async () => {
    const { tx, rows } = store([question]);
    await expect(mirrorAskInTransaction(tx, mirror)).resolves.toMatchObject({
      threadId: "main-chat",
    });
    await expect(mirrorAskInTransaction(tx, mirror)).resolves.toBeNull();
    const copies = rows.filter((row) => row.threadId === "main-chat");
    expect(copies).toEqual([
      expect.objectContaining({
        botId: "kruit",
        runId: "team-run",
        blocks: [
          {
            ...question,
            answerTarget: { threadId: "role", runId: "team-run", messageId: "source" },
          },
        ],
      }),
    ]);
  });

  // team-stuck-tell-me 11-16: the team's calendar sign-in sat in the role, where the recruiter
  // never looks. The person signs in from the copy; the server is theirs and the team's bot has it.
  it("copies a sign-in card, and leaves a secret card with the team", async () => {
    const connect = {
      kind: "ask",
      text: "Connect Google Calendar",
      status: "pending",
      connection: { serverId: "s", name: "Google Calendar", reason: "book the interview" },
    };
    const signIn = store([connect]);
    await expect(mirrorAskInTransaction(signIn.tx, mirror)).resolves.toMatchObject({
      threadId: "main-chat",
    });
    expect(signIn.rows).toHaveLength(2);
    const secret = store([{ kind: "ask", text: "API key?", status: "pending", input: "secret" }]);
    await expect(mirrorAskInTransaction(secret.tx, mirror)).resolves.toBeNull();
    expect(secret.rows).toHaveLength(1);
  });

  it("closes the copy when the card is answered or expires", async () => {
    const { tx, rows } = store([question]);
    await mirrorAskInTransaction(tx, mirror);
    const answered = [{ ...question, status: "answered", answer: "remote" }];
    await expect(
      syncMirroredAsksInTransaction(tx, {
        spaceId: "space-1",
        sourceThreadId: "role",
        sourceMessageId: "source",
        runId: "team-run",
        blocks: answered as MessageBlock[],
      }),
    ).resolves.toEqual([expect.objectContaining({ threadId: "main-chat" })]);
    expect(rows.find((row) => row.threadId === "main-chat")?.blocks).toEqual([
      {
        ...answered[0],
        answerTarget: { threadId: "role", runId: "team-run", messageId: "source" },
      },
    ]);
  });
});
