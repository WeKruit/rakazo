import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  currentBotMessageHop,
  loadBotMessageContext,
  messageBot,
  reportDelegatedTeamBlocked,
  returnBotMessageOutcome,
  showDelegatedTeamCard,
  teamProgress,
} from "./bot-messages.js";
import type { ExecutorDeps } from "./executor.js";
import * as mailReplies from "./mail-reply.js";

const run = {
  id: "run-1",
  spaceId: "workspace-1",
  threadId: "thread-sender",
  botId: "bot-sender",
  userId: "user-1",
  sourceMessageId: null as string | null,
};
const sender = { id: "bot-sender", name: "Researcher" };

function deps(
  options: {
    bots?: unknown[];
    hopBlocks?: unknown[];
    senderRunning?: boolean;
    alreadyDelivered?: unknown;
    targetArchived?: boolean;
    /** Simulate a unique (threadId, clientNonce) race after both retries miss. */
    uniqueConflictOnCommit?: boolean;
    transactionConflictOnce?: boolean;
    /** What a scoped lookup of another conversation returns. */
    addressedThread?: unknown;
    /** The role team's turn still working on an earlier request from the same conversation. */
    teamWorking?: unknown;
  } = {},
) {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const messageFindUnique = vi
    .fn()
    .mockImplementation(async (args: { where?: { threadId_clientNonce?: unknown } }) =>
      args?.where?.threadId_clientNonce
        ? (options.alreadyDelivered ?? null)
        : { blocks: options.hopBlocks ?? [] },
    );
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread" }]),
    run: {
      findFirst: vi.fn(async (args: { where: { trigger?: string; OR?: unknown } }) =>
        // The team's earlier turn for this conversation; otherwise the sender's own run.
        args.where.OR
          ? (options.teamWorking ?? null)
          : options.senderRunning === false
            ? null
            : { id: "run-1" },
      ),
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
      create: vi.fn().mockResolvedValue({ id: "run-2" }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    attempt: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    bot: {
      findFirst: vi.fn().mockResolvedValue(options.targetArchived ? null : { id: "bot-target" }),
    },
    task: {
      create: vi.fn().mockResolvedValue({ id: "task-1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    message: {
      findUnique: messageFindUnique,
      create: vi.fn().mockResolvedValue({ id: "message-1", seq: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    event: { create: vi.fn().mockResolvedValue({ seq: 7 }) },
    thread: { update: vi.fn().mockResolvedValue({}) },
    steeringMessage: { create: vi.fn().mockResolvedValue({ id: "steer-1" }) },
  };
  let transactionAttempts = 0;
  const prisma = {
    recruitingCandidateOccurrence: {
      findMany: vi.fn().mockResolvedValue([{ candidateKey: "a" }, { candidateKey: "b" }]),
    },
    bot: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          options.bots ?? [
            { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
          ],
        ),
    },
    message: { findUnique: messageFindUnique, findMany: vi.fn().mockResolvedValue([]) },
    run: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn(async (args?: { where?: { OR?: unknown } }) =>
        args?.where?.OR ? (options.teamWorking ?? null) : null,
      ),
    },
    thread: {
      findFirst: vi.fn().mockResolvedValue(options.addressedThread ?? null),
      findUnique: vi.fn().mockResolvedValue({ activeRecruitingRoleId: "role-1" }),
    },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => {
      transactionAttempts += 1;
      if (options.transactionConflictOnce && transactionAttempts === 1) {
        throw Object.assign(new Error("write conflict"), { code: "P2034" });
      }
      if (options.uniqueConflictOnCommit) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      return fn(tx);
    }),
  } as unknown as PrismaClient;
  return {
    deps: { prisma, events: { notify }, jobs: { enqueue } } as unknown as Pick<
      ExecutorDeps,
      "prisma" | "events" | "jobs"
    >,
    tx,
    enqueue,
    notify,
  };
}

describe("messaging another bot", () => {
  it("delivers into the target's own chat without marking either thread unread", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "  chart the q3 numbers  ",
    });

    expect(sent).toMatchObject({ ok: true, botId: "bot-target", name: "Analyst" });
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          prompt: expect.stringMatching(/not the user typing[\s\S]*untrusted peer content/),
        }),
      }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          status: "queued",
          trigger: "bot_message",
        }),
      }),
    );
    expect(harness.notify).toHaveBeenCalledWith("thread-target", 7);
    expect(harness.notify).toHaveBeenCalledWith("thread-sender", 7);
    expect(harness.tx.message.create).toHaveBeenCalledTimes(2);
    expect(
      harness.tx.thread.update.mock.calls.filter(
        ([call]) => (call as { data?: { unread?: boolean } }).data?.unread,
      ),
    ).toHaveLength(0);
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it("marks a forced failure return unread on both sides", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "Could not complete the delegated request.",
      "status",
      { forceUnread: true },
    );

    const unreadWrites = harness.tx.thread.update.mock.calls.filter(
      ([call]) => (call as { data?: { unread?: boolean } }).data?.unread === true,
    );
    expect(unreadWrites).toHaveLength(2);
  });

  it("refuses a bot messaging itself", async () => {
    const harness = deps({
      bots: [{ id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } }],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-sender",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "a bot cannot message itself" });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("refuses an unknown target without starting a run", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-missing",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "no bot found with that id or name" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("refuses an empty message", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "   ",
    });
    expect(sent).toEqual({ ok: false, error: "message is required" });
  });

  it("rejects an oversized message instead of silently truncating it", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "x".repeat(8_001),
    });
    expect(sent).toEqual({ ok: false, error: "message exceeds the 8000 character limit" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not deliver once the sending run is no longer active", async () => {
    const harness = deps({ senderRunning: false });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "hello",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stops a chain that has volleyed too many times", async () => {
    const harness = deps({
      hopBlocks: [
        { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "hi", hop: 6 },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "again" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("allows a final result back through after the request hop limit", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "please finish",
          hop: 6,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "finished", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(true);
    // Both conversations in one statement, role conversations first: answering a role's card
    // locks the same rows in that order, so the two cannot deadlock.
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [lockSql, ...lockedIds] = harness.tx.$queryRaw.mock.calls[0]!;
    expect(lockSql.join("?")).toMatch(/ORDER BY \("groupId" IS NULL\), id\s+FOR UPDATE/);
    expect(lockedIds).toEqual([run.threadId, expect.any(String)]);
    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          replyToMessageId: "message-request",
          blocks: expect.arrayContaining([expect.objectContaining({ intent: "result" })]),
        }),
      }),
    );
  });

  it("does not inherit a request reply link when messaging another bot", async () => {
    const harness = deps({
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-other", name: "Writer", title: "", thread: { id: "thread-other" } },
      ],
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "check Gmail",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    await messageBot(harness.deps, { ...run, sourceMessageId: "message-source" }, sender, {
      bot_id: "bot-other",
      message: "unrelated update",
      intent: "fyi",
    });

    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ replyToMessageId: undefined }),
      }),
    );
  });

  it("does not inherit a request reply link for an FYI to the requester", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "check Gmail",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    await messageBot(harness.deps, { ...run, sourceMessageId: "message-source" }, sender, {
      bot_id: "bot-target",
      message: "unrelated update",
      intent: "fyi",
    });

    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ replyToMessageId: undefined }),
      }),
    );
  });

  it("does not exempt a terminal reply to another terminal reply", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "finished",
          hop: 6,
          intent: "result",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "acknowledged", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not let a result label bypass the hop limit toward an unrelated bot", async () => {
    const harness = deps({
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-other", name: "Writer", title: "", thread: { id: "thread-other" } },
      ],
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "please finish",
          hop: 6,
          intent: "request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-other", message: "keep going", intent: "result" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("keeps model-supplied status updates subject to the hop limit", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "please finish",
          hop: 6,
          intent: "request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "still working", intent: "status" },
    );
    expect(sent.ok).toBe(false);
  });

  it("keeps a person-started chain going", async () => {
    const harness = deps({
      hopBlocks: [
        { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "hi", hop: 1 },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "carry on" },
    );
    expect(sent.ok).toBe(true);
  });
});

describe("delegating to a role team in another conversation", () => {
  const kruit = { id: "bot-main", name: "Main" };
  const globalRun = { ...run, botId: "bot-main", threadId: "thread-global" };
  const mainBot = [{ id: "bot-main", name: "Main", title: "", thread: null }];

  it("lets the same agent hand a request into the role team's conversation", async () => {
    const harness = deps({ bots: mainBot, addressedThread: { id: "thread-role" } });
    const sent = await messageBot(harness.deps, globalRun, kruit, {
      bot_id: "bot-main",
      thread_id: "thread-role",
      sender_label: "Kruit",
      target_label: "SUI Engineer team",
      message: "Find 50 more people",
    });
    expect(sent).toMatchObject({ ok: true, name: "SUI Engineer team" });
    expect(harness.deps.prisma.thread.findFirst).toHaveBeenCalledWith({
      where: {
        id: "thread-role",
        spaceId: run.spaceId,
        userId: run.userId,
        group: { archivedAt: null, members: { some: { botId: "bot-main" } } },
      },
      select: { id: true },
    });
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "bot-main", threadId: "thread-role" }),
      }),
    );
    const blocks = harness.tx.message.create.mock.calls.map(
      ([call]) => (call as { data: { blocks: unknown[] } }).data.blocks[0],
    );
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "bot_message_sent", toBotName: "SUI Engineer team" }),
        expect.objectContaining({
          kind: "bot_message_received",
          fromBotName: "Kruit",
          returnThreadId: "thread-global",
        }),
      ]),
    );
  });

  it("replaces an earlier request from the same conversation that has not started", async () => {
    // Staging 11-14: each "where's the new round?" queued as its own turn behind the round and
    // they ran one after another, so the recruiter's new instruction waited minutes.
    const harness = deps({ bots: mainBot, addressedThread: { id: "thread-role" } });
    harness.tx.run.findMany.mockResolvedValue([{ id: "run-stale", taskId: "task-stale" }]);
    harness.tx.run.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
      status: args.where.id === "run-stale" ? "cancelled" : "running",
    }));
    const sent = await messageBot(harness.deps, globalRun, kruit, {
      bot_id: "bot-main",
      thread_id: "thread-role",
      message: "Redo the ones without Kafka",
    });
    expect(sent).toMatchObject({ ok: true });
    expect(harness.tx.run.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        threadId: "thread-role",
        botId: "bot-main",
        status: "queued",
        leaseFence: 0,
        sourceMessage: {
          is: {
            blocks: {
              array_contains: [{ kind: "bot_message_received", returnThreadId: "thread-global" }],
            },
          },
        },
      }),
      select: { id: true, taskId: true },
    });
    expect(harness.tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["run-stale"] } },
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    expect(harness.tx.run.create).toHaveBeenCalled();
  });

  it("tells Kruit the team is still on its earlier request instead of a fresh start", async () => {
    // Staging 11-14: asked "where are they?" mid-search, Kruit read the role status, saw no new
    // round and told the recruiter three times that the search had not started.
    const harness = deps({
      bots: mainBot,
      addressedThread: { id: "thread-role" },
      teamWorking: {
        id: "run-team",
        botId: "bot-sourcer",
        createdAt: new Date(Date.now() - 5 * 60_000),
        startedAt: new Date(Date.now() - 3 * 60_000),
        bot: { name: "Sourcer" },
      },
    });
    const sent = await messageBot(harness.deps, globalRun, kruit, {
      bot_id: "bot-main",
      thread_id: "thread-role",
      message: "Where are the new people?",
    });
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) throw new Error("not sent");
    // Staging 11-15: queued behind the round, the request ran a second paid search after it.
    expect(harness.tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "message-1", botId: "bot-sourcer", userId: "user-1", runId: "run-team" },
    });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(sent.note).toContain("Sourcer has been working on the recruiter's request for 3 min");
    expect(harness.tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-role",
          status: { in: ["leased", "running"] },
          // The teammate the work was handed to counts too: with one lane per agent, a request
          // that missed it would start a second search beside it (reliability plan S3/S4).
          OR: expect.arrayContaining([{ trigger: "follow_up" }]),
        }),
      }),
    );
  });

  it("says nothing about earlier work when the team is idle", async () => {
    const harness = deps({ bots: mainBot, addressedThread: { id: "thread-role" } });
    const sent = await messageBot(harness.deps, globalRun, kruit, {
      bot_id: "bot-main",
      thread_id: "thread-role",
      message: "Find more like the rest",
    });
    if (!sent.ok) throw new Error("not sent");
    expect(sent.note).toMatch(/^Sent to /);
  });

  it("never replaces a request inside the same conversation", async () => {
    const harness = deps();
    await messageBot(harness.deps, run, sender, { bot_id: "bot-target", message: "hello" });
    expect(harness.tx.run.findMany).not.toHaveBeenCalled();
  });

  it("refuses a conversation outside this user's active role teams", async () => {
    const harness = deps({ bots: mainBot, addressedThread: null });
    const sent = await messageBot(harness.deps, globalRun, kruit, {
      bot_id: "bot-main",
      thread_id: "thread-foreign",
      message: "Find 50 more people",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("still refuses messaging itself in the same conversation", async () => {
    const harness = deps({ bots: mainBot, addressedThread: { id: "thread-global" } });
    const sent = await messageBot(harness.deps, globalRun, kruit, {
      bot_id: "bot-main",
      thread_id: "thread-global",
      message: "loop",
    });
    expect(sent).toEqual({ ok: false, error: "a bot cannot message itself" });
  });

});

describe("hop lookup", () => {
  it("treats a run a person started as the start of a chain", async () => {
    const prisma = { message: { findUnique: vi.fn() } } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, null)).toBe(0);
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
  });

  it("reads the hop back off the message that woke the bot", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            { kind: "text", text: "noise" },
            { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "x", hop: 3 },
          ],
        }),
      },
    } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, "message-1")).toBe(3);
  });

  it("requires the linked request to target the agent that sent the wake-up", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "requester",
              fromBotName: "Requester",
              text: "work on this",
              intent: "result",
              returnToMessageId: "request-message",
            },
          ],
          replyTo: {
            id: "different-message",
            blocks: [
              {
                kind: "bot_message_sent",
                toBotId: "other-agent",
                toBotName: "Other agent",
                text: "work on this",
                intent: "request",
              },
            ],
          },
        }),
      },
    } as unknown as PrismaClient;

    await expect(loadBotMessageContext(prisma, "message-source")).resolves.toMatchObject({
      repliesToRequest: false,
    });
  });

  it.each([
    ["result", true],
    ["status", true],
    ["fyi", true],
    ["request", false],
    ["question", false],
    [undefined, false],
  ])("classifies a linked %s message as a returned answer: %s", async (intent, expected) => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "requester",
              fromBotName: "Requester",
              text: "work on this",
              intent,
              returnToMessageId: "return-echo",
            },
          ],
          replyTo: {
            id: "request-message",
            blocks: [
              {
                kind: "bot_message_sent",
                toBotId: "requester",
                toBotName: "Requester",
                text: "work on this",
                intent: "request",
              },
            ],
          },
        }),
      },
    } as unknown as PrismaClient;

    await expect(loadBotMessageContext(prisma, "message-source")).resolves.toMatchObject({
      repliesToRequest: expected,
    });
  });
});

describe("hardening", () => {
  it("does not deliver twice when the tool call is re-executed", async () => {
    const harness = deps({ alreadyDelivered: { id: "message-1" } });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({ ok: true, replayed: true, botId: "bot-target" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stamps the delivery so a retry can recognise it", async () => {
    const harness = deps();
    await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });
    expect(harness.tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: "bot-message:call-1" }),
      }),
    );
  });

  it("still delivers when the caller supplies no delivery key", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalled();
  });

  it("does not deliver to a bot archived while the message was being sent", async () => {
    const harness = deps({ targetArchived: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("treats a delivery-key unique conflict as a replay", async () => {
    const harness = deps({ uniqueConflictOnCommit: true });
    // After both retries miss and the loser hits P2002, the winner is visible.
    (harness.deps.prisma.message.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "message-winner",
    });

    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({ ok: true, replayed: true, botId: "bot-target" });
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("retries a serialization conflict without dropping the delivery", async () => {
    const harness = deps({ transactionConflictOnce: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.deps.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });
});

describe("automatic outcome return", () => {
  it.each(["Research found three qualified people.", "I am drafting the reply now."])(
    "keeps additional child text separate from verified mail facts: %s",
    async (text) => {
      const h = deps({
        hopBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-target",
            fromBotName: "Coordinator",
            text: "research this",
            hop: 1,
            intent: "request",
            returnToMessageId: "message-request",
          },
        ],
      });
      const outcome = mailReplies.mailReplyOutcome({ status: "sent" });
      const read = vi
        .spyOn(mailReplies, "readMailReplyOutcomeReport")
        .mockResolvedValue({ facts: [], text: outcome });
      try {
        await returnBotMessageOutcome(
          h.deps,
          { ...run, sourceMessageId: "message-source" },
          sender,
          text,
        );
        const delivered = JSON.stringify(h.tx.message.create.mock.calls);
        expect(delivered).toContain(outcome);
        expect(delivered).toContain(
          "Additional child output (may include earlier progress; the mail status above is authoritative)",
        );
        expect(delivered).toContain(text);
        expect(delivered.indexOf(outcome)).toBeLessThan(delivered.indexOf(text));
      } finally {
        read.mockRestore();
      }
    },
  );

  it("routes a delegated run's final text back to its coordinator", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );
    expect(returned).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "bot_message" }) }),
    );
    expect(harness.tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["completed", "failed", "cancelled"] },
        }),
      }),
    );
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: run.id,
        status: { in: ["completed", "failed", "cancelled"] },
        botOutcomeReturnedAt: null,
      },
      data: { botOutcomeReturnedAt: expect.any(Date) },
    });
  });

  it("still returns a final result after an interim status update", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "still looking",
            hop: 2,
            intent: "status",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("skips the automatic return when a result was already sent", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "done",
            hop: 2,
            intent: "result",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalled();
  });
});

describe("teamProgress", () => {
  it("says a round recorded while the team works is already shown (staging 2026-11-15)", async () => {
    // Global Kruit said "the new ten aren't finalized yet" a minute after round 2 was recorded.
    const startedAt = new Date(Date.now() - 3 * 60_000);
    const prisma = {
      run: {
        findFirst: vi.fn(async () => ({ createdAt: startedAt, startedAt, bot: { name: "Lead" } })),
      },
      thread: { findUnique: vi.fn() },
      recruitingCandidateOccurrence: { findMany: vi.fn(async () => [{ candidateKey: "a" }]) },
      recruitingCalibrationRound: {
        findFirst: vi.fn(async () => ({ round: 2, createdAt: new Date(Date.now() - 60_000) })),
      },
    } as unknown as PrismaClient;
    const progress = await teamProgress(prisma, {
      threadId: "role-thread",
      returnThreadId: "global",
      roleId: "role",
    });
    expect(progress?.note).toContain("Round 2 is recorded");
  });

  it("counts the turn of a role opened from Kruit's chat as the team working (staging 2026-11-15)", async () => {
    // Asked "where are the people?" while a role opened from Kruit's chat ran its first round,
    // Kruit listed seven unchecked people from Results: only delegated turns counted as working.
    const startedAt = new Date(Date.now() - 60_000);
    const prisma = {
      run: {
        findFirst: vi.fn(async ({ where }: { where: { OR?: Array<Record<string, unknown>> } }) =>
          JSON.stringify(where.OR ?? []).includes("start-role:")
            ? { id: "start", botId: "lead", createdAt: startedAt, startedAt, bot: { name: "Lead" } }
            : null,
        ),
      },
      thread: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const progress = await teamProgress(prisma, {
      threadId: "role-thread",
      returnThreadId: "global",
    });
    expect(progress?.name).toBe("Lead");
  });

  it("counts a team turn requeued after a follow-up as still working (staging 2026-11-15)", async () => {
    // A follow-up steered into the team's turn requeued it for 50 s; in between Kruit listed
    // three pages of unchecked people from Results with repeats.
    const findFirst = vi.fn(async () => null);
    const prisma = { run: { findFirst } } as unknown as PrismaClient;
    await teamProgress(prisma, { threadId: "role-thread", returnThreadId: "global", roleId: "r" });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["queued", "leased", "running"] } }),
      }),
    );
  });
});
