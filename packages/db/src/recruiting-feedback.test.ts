import type { AdapterContext, MemoryCommitRequest } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  authorizeRecruitingFeedbackMessage,
  authorizeRecruitingMemoryCommit,
  executeNativeRecruitingCandidateDecision,
  listRecruitingFeedback,
  prepareNativeRecruitingCandidateDecision,
  readRecruitingFeedbackContext,
} from "./recruiting.js";
import { IsolationError } from "./scope.js";

vi.mock("./events.js", async (load) => ({
  ...(await load<typeof import("./events.js")>()),
  appendEventInTransaction: vi.fn(async () => ({})),
}));

const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const quote = "Use Example Avery as a positive example, and Example Blair is not a fit.";
const selection = {
  roleId: "role",
  roleRevisionId: "revision",
  expectedRoleRevision: 1,
  candidateKeys: ["avery"],
  choice: "not_fit",
};
function fixture() {
  const role = {
    spaceId: actor.spaceId,
    userId: actor.userId,
    id: "role",
    sourceThreadId: "thread",
    title: "Engineer",
    currentRevisionId: "revision",
    revision: 1,
  };
  const source = {
    id: "human",
    threadId: "thread",
    role: "user",
    botId: null,
    externalTranscriptFor: null,
    seq: 1,
    blocks: [{ kind: "text", text: quote }] as unknown[],
    clientNonce: null as string | null,
    runId: null as string | null,
    createdAt: new Date(),
  };
  const input = {
    runId: "run",
    sourceMessageId: "human",
    roleId: "role",
    expectedRoleRevision: 1,
    intent: { basis: "direct" as const, quote },
    sourceRefs: [],
    candidateKeys: ["avery", "blair"],
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
    run: {
      findFirst: vi.fn(async (_query: unknown) => ({
        ...actor,
        id: "run",
        botId: "bot",
        bot: actor,
        threadId: "thread",
        sourceMessageId: "human",
        trigger: "follow_up",
        status: "running",
      })),
    },
    thread: {
      findFirst: vi.fn(async () => ({
        ...actor,
        id: "thread",
        botId: "bot",
        activeRecruitingRoleId: "role",
      })),
    },
    bot: { findFirst: vi.fn(async () => actor) },
    recruitingRole: { findFirst: vi.fn(async () => role) },
    recruitingRoleRevision: {
      findFirst: vi.fn(async () => ({
        id: "revision",
        roleId: "role",
        revision: 1,
        sourceRefs: [
          {
            id: "role-source",
            kind: "original_material",
            anchor: { kind: "message", messageId: "human", locator: "blocks[0].text" },
            quote,
            readState: "read",
            readAt: new Date().toISOString(),
          },
        ],
        criteria: [],
        preferences: [],
        definitionQuestions: [],
        createdAt: new Date(),
      })),
    },
    message: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id && where.id !== source.id ? null : source,
      ),
      findMany: vi.fn(async (_query: unknown) => [source]),
    },
    event: { findMany: vi.fn(async () => []) },
    steeringMessage: { findMany: vi.fn(async (_query: unknown) => [] as unknown[]) },
    recruitingCandidate: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { roleId: string; candidateKey: { in: readonly string[] } };
        }) =>
          where.roleId === "role"
            ? ["avery", "blair"]
                .filter((candidateKey) => where.candidateKey.in.includes(candidateKey))
                .map((candidateKey) => ({ candidateKey }))
            : [],
      ),
    },
    externalEffect: {
      findMany: vi.fn(async (_input: unknown) => []),
      findFirst: vi.fn(async () => null),
    },
  };
  const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  return { prisma, tx, input, source };
}

function handoffFixture() {
  const f = fixture();
  const handoff = {
    ...f.source,
    id: "handoff",
    seq: 2,
    role: "bot",
    botId: "sender-bot",
    runId: "sender-run",
    clientNonce: "group-handoff:sender-run",
    blocks: [
      {
        kind: "handoff",
        fromBotId: "sender-bot",
        toBotId: "bot",
        text: "Relay the latest human candidate feedback",
        hop: 1,
      },
    ],
  };
  const run = {
    ...actor,
    id: "run",
    botId: "bot",
    bot: actor,
    threadId: "thread",
    sourceMessageId: handoff.id,
    trigger: "follow_up",
    status: "running",
  };
  const sender = {
    ...run,
    id: "sender-run",
    botId: "sender-bot",
    sourceMessageId: f.source.id,
    trigger: "user",
    status: "completed",
  };
  f.tx.run.findFirst.mockImplementation(async (query) =>
    (query as { where: { id: string } }).where.id === sender.id ? sender : run,
  );
  f.tx.message.findFirst.mockImplementation(
    async ({ where }) => (where.id === handoff.id ? handoff : f.source) as never,
  );
  f.tx.thread.findFirst.mockResolvedValue({
    ...actor,
    id: "thread",
    groupId: "group",
    activeRecruitingRoleId: "role",
  } as never);
  const event = {
    payload: {
      messageId: handoff.id,
      fromBotId: sender.botId,
      toBotId: run.botId,
      text: handoff.blocks[0]!.text,
    },
  };
  const eventRead = vi.fn(async () => event);
  const membershipCount = vi.fn(async () => 2);
  Object.assign(f.tx.event, { findFirst: eventRead });
  Object.assign(f.tx, {
    chatGroup: { findFirst: vi.fn(async () => ({ ...actor, id: "group" })) },
    chatGroupMember: { findFirst: vi.fn(async () => ({})), count: membershipCount },
  });
  return {
    ...f,
    handoff,
    run,
    sender,
    eventRead,
    membershipCount,
    input: { ...f.input, sourceMessageId: handoff.id },
  };
}

describe("native recruiting memory admission", () => {
  const context: AdapterContext = {
    ...actor,
    botId: "bot",
    runId: "run",
    operationId: "role-note",
    traceId: "role-note",
    signal: new AbortController().signal,
  };
  const request: MemoryCommitRequest = {
    scope: "bot",
    botId: "bot",
    path: "role-notes.md",
    content: "The current task is waiting for a source response.",
    expectedRevision: 0,
    sourceRunId: "run",
    sourceThreadId: "thread",
  };

  it("allows a new native bot note in an active recruiting role", async () => {
    const f = fixture();
    await expect(
      authorizeRecruitingMemoryCommit(f.tx as never, request, context, null),
    ).resolves.toBeUndefined();
  });

  it("records resolved quote-only revocation coordinates while retaining current-human and CAS checks", async () => {
    const f = fixture();
    f.source.blocks = [{ kind: "text", text: `${quote}\nRemove only old.` }];
    Object.assign(f.tx, { memoryRevision: { findUnique: vi.fn(async () => null) } });
    const content = "🙂 keep\r\nold\nKeep this.";
    const start = content.indexOf("old");
    const edit: MemoryCommitRequest = {
      ...request,
      scope: "user",
      botId: undefined,
      expectedRevision: 2,
      content: content.slice(0, start) + content.slice(start + 3),
      recruiting: {
        sourceMessageId: f.source.id,
        feedback: {
          target: "preference",
          scope: "user",
          path: request.path,
          expectedRevision: 2,
          operation: "revoke",
          anchor: { quote: "old" },
          intent: { basis: "direct", quote: "Remove only old." },
          sourceRefs: [],
        },
      },
    };
    const existing = { id: "document", content, revision: 2 };
    await expect(
      authorizeRecruitingMemoryCommit(f.tx as never, edit, context, existing),
    ).resolves.toMatchObject({
      operation: "revoke",
      previousAnchor: { start, end: start + 3, quote: "old" },
      anchor: null,
      source: { anchor: { messageId: f.source.id }, quote: "Remove only old." },
    });
    await expect(
      authorizeRecruitingMemoryCommit(f.tx as never, edit, context, { ...existing, revision: 3 }),
    ).rejects.toThrow();
  });

  it("allows CAS edits to an ordinary private note without a preference receipt", async () => {
    const f = fixture();
    const findFirst = vi.fn(async () => null);
    Object.assign(f.tx.event, { findFirst });
    await expect(
      authorizeRecruitingMemoryCommit(f.tx as never, { ...request, expectedRevision: 2 }, context, {
        id: "note-document",
        content: "Previous task state.",
        revision: 2,
      }),
    ).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        spaceId: actor.spaceId,
        type: "memory.revised",
        AND: [
          { payload: { path: ["kind"], equals: "recruiting_preference" } },
          { payload: { path: ["documentId"], equals: "note-document" } },
          { payload: { path: ["scope"], equals: "bot" } },
          { payload: { path: ["path"], equals: request.path } },
        ],
      },
      select: { id: true },
    });
  });

  it.each([
    { scope: "bot" as const, activeRole: true },
    { scope: "bot" as const, activeRole: false },
    { scope: "user" as const, activeRole: true },
    { scope: "user" as const, activeRole: false },
  ])(
    "requires exact preference feedback for a marked $scope document (active role: $activeRole)",
    async ({ scope, activeRole }) => {
      const f = fixture();
      if (!activeRole)
        f.tx.thread.findFirst.mockResolvedValue({
          ...actor,
          id: "thread",
          botId: "bot",
          activeRecruitingRoleId: null,
        } as never);
      const findFirst = vi.fn(async (_query: unknown) => ({
        botId: scope === "user" ? "another-bot" : "bot",
        payload: { kind: "recruiting_preference" },
      }));
      Object.assign(f.tx.event, { findFirst });
      await expect(
        authorizeRecruitingMemoryCommit(
          f.tx as never,
          { ...request, scope, botId: scope === "bot" ? "bot" : undefined, expectedRevision: 2 },
          context,
          { id: "preference-document", content: "Original preference.", revision: 2 },
        ),
      ).rejects.toThrow(IsolationError);
      expect(findFirst).toHaveBeenCalled();
      if (scope === "user") expect(findFirst.mock.calls[0]?.[0]).not.toHaveProperty("where.botId");
    },
  );

  it("keeps an unmarked shared document on the native path when no role is active", async () => {
    const f = fixture();
    f.tx.thread.findFirst.mockResolvedValue({
      ...actor,
      id: "thread",
      botId: "bot",
      activeRecruitingRoleId: null,
    } as never);
    Object.assign(f.tx.event, { findFirst: vi.fn(async () => null) });
    await expect(
      authorizeRecruitingMemoryCommit(
        f.tx as never,
        { ...request, scope: "user", botId: undefined, expectedRevision: 2 },
        context,
        { id: "shared-note", content: "Previous task state.", revision: 2 },
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    { scope: "user", botId: undefined },
    { botId: "another-bot" },
    { sourceRunId: "another-run" },
    { sourceThreadId: "another-thread" },
    { recruiting: { sourceMessageId: "human", feedback: {} } },
  ])("keeps shared, foreign and explicit preference requests guarded: %j", async (patch) => {
    const f = fixture();
    await expect(
      authorizeRecruitingMemoryCommit(
        f.tx as never,
        { ...request, ...patch } as MemoryCommitRequest,
        context,
        null,
      ),
    ).rejects.toThrow();
  });

  it.each([{ userId: "another-user" }, { spaceId: "another-space" }, { botId: "another-bot" }])(
    "validates live run ownership before admitting a bot note: %j",
    async (patch) => {
      const f = fixture();
      await expect(
        authorizeRecruitingMemoryCommit(f.tx as never, request, { ...context, ...patch }, null),
      ).rejects.toThrow(IsolationError);
    },
  );

  it("rejects a bot note from a stopped run", async () => {
    const f = fixture();
    f.tx.run.findFirst.mockResolvedValue({
      ...actor,
      id: "run",
      botId: "bot",
      bot: actor,
      threadId: "thread",
      sourceMessageId: "human",
      trigger: "follow_up",
      status: "cancelled",
    });
    await expect(
      authorizeRecruitingMemoryCommit(f.tx as never, request, context, null),
    ).rejects.toThrow(IsolationError);
  });
});

describe("native recruiting feedback records", () => {
  it("records a selected subset from the original human source across a proven native handoff", async () => {
    const f = handoffFixture();
    const quote =
      "Use Example Avery as a positive example, Example Blair is not a fit, and inspect Example Casey only.";
    f.source.blocks = [{ kind: "text", text: quote }];
    f.tx.recruitingCandidate.findMany.mockResolvedValueOnce([
      { candidateKey: "avery" },
      { candidateKey: "blair" },
      { candidateKey: "casey" },
    ]);
    const result = await readRecruitingFeedbackContext(f.prisma, actor, {
      ...f.input,
      intent: { basis: "direct", quote },
      candidateKeys: ["avery", "blair", "casey"],
    });
    expect(result.source).toMatchObject({
      id: "human-message:human",
      quote,
      anchor: { messageId: f.source.id },
    });
    expect(result.source.id).not.toContain("handoff");
  });
  it.each(["event", "cancelled", "membership", "order", "bot-quote"] as const)(
    "rejects invalid native feedback handoff %s",
    async (boundary) => {
      const f = handoffFixture();
      if (boundary === "event") f.eventRead.mockResolvedValueOnce(null as never);
      if (boundary === "cancelled") f.sender.status = "cancelled";
      if (boundary === "membership") f.membershipCount.mockResolvedValueOnce(1);
      if (boundary === "order") f.source.seq = f.handoff.seq + 1;
      await expect(
        readRecruitingFeedbackContext(
          f.prisma,
          actor,
          boundary === "bot-quote"
            ? { ...f.input, intent: { basis: "direct", quote: f.handoff.blocks[0]!.text } }
            : f.input,
        ),
      ).rejects.toThrow(IsolationError);
    },
  );
  it("rejects newer claimed human input after a native handoff", async () => {
    const f = handoffFixture();
    const newer = {
      ...f.source,
      id: "newer-human",
      seq: f.handoff.seq + 1,
      blocks: [{ kind: "text", text: "Hold this search" }],
    };
    f.tx.steeringMessage.findMany.mockImplementation(async (query) =>
      (query as { where: { runId: string } }).where.runId === f.run.id
        ? [{ messageId: newer.id, message: newer }]
        : [],
    );
    await expect(readRecruitingFeedbackContext(f.prisma, actor, f.input)).rejects.toThrow(
      IsolationError,
    );
  });
  it("uses the sender's latest claimed human input before handoff without reviving an earlier quote", async () => {
    const f = handoffFixture();
    f.handoff.seq = 3;
    const newer = {
      ...f.source,
      id: "newer-human",
      seq: 2,
      blocks: [{ kind: "text", text: "Refine this search direction only" }],
    };
    f.tx.steeringMessage.findMany.mockImplementation(async (query) =>
      (query as { where: { runId: string } }).where.runId === f.sender.id
        ? [{ messageId: newer.id, message: newer }]
        : [],
    );
    f.tx.message.findFirst.mockImplementation(
      async ({ where }) =>
        (where.id === f.handoff.id ? f.handoff : where.id === newer.id ? newer : f.source) as never,
    );
    Object.assign(f.tx.message, { findUnique: vi.fn(async () => f.source) });
    const result = await readRecruitingFeedbackContext(f.prisma, actor, {
      ...f.input,
      candidateKeys: undefined,
      intent: { basis: "direct", quote: newer.blocks[0]!.text },
    });
    expect(result.source.anchor).toMatchObject({ messageId: newer.id });
    await expect(readRecruitingFeedbackContext(f.prisma, actor, f.input)).rejects.toThrow(
      IsolationError,
    );
  });
  it("rejects a cyclic native handoff chain", async () => {
    const f = handoffFixture();
    const second = {
      ...f.handoff,
      id: "cycle-handoff",
      seq: 3,
      botId: f.run.botId,
      runId: f.run.id,
      clientNonce: `group-handoff:${f.run.id}`,
      blocks: [
        {
          kind: "handoff",
          fromBotId: f.run.botId,
          toBotId: f.sender.botId,
          text: "Forward the human feedback",
          hop: 2,
        },
      ],
    };
    f.sender.sourceMessageId = second.id;
    f.sender.trigger = "follow_up";
    f.tx.message.findFirst.mockImplementation(
      async ({ where }) =>
        (where.id === f.handoff.id
          ? f.handoff
          : where.id === second.id
            ? second
            : f.source) as never,
    );
    f.eventRead.mockImplementation(async () => ({
      payload: {
        messageId: second.id,
        fromBotId: f.run.botId,
        toBotId: f.sender.botId,
        text: second.blocks[0]!.text,
      },
    }));
    f.eventRead.mockResolvedValueOnce({
      payload: {
        messageId: f.handoff.id,
        fromBotId: f.sender.botId,
        toBotId: f.run.botId,
        text: f.handoff.blocks[0]!.text,
      },
    });
    await expect(readRecruitingFeedbackContext(f.prisma, actor, f.input)).rejects.toThrow(
      IsolationError,
    );
    expect(f.eventRead).toHaveBeenCalledTimes(2);
  });
  it("reads authored form feedback without any model classification or provider call", async () => {
    const f = fixture();
    f.source.blocks = [{ kind: "text", text: quote, recruitingFeedback: selection }];
    await expect(
      listRecruitingFeedback(f.prisma, actor, { roleId: "role", candidateKey: "avery" }),
    ).resolves.toMatchObject({
      feedback: [
        {
          id: "human",
          choice: "not_fit",
          feedback: { candidateKeys: ["avery"] },
          source: { quote },
        },
      ],
      nextCursor: null,
    });
    expect(f.tx.message.findMany).toHaveBeenCalledTimes(1);
  });
  it("admits authored metadata only for the owned active role, current revision and existing candidates", async () => {
    const f = fixture();
    await authorizeRecruitingFeedbackMessage(f.tx as never, actor, "thread", selection);
    await expect(
      authorizeRecruitingFeedbackMessage(f.tx as never, actor, "thread", {
        ...selection,
        roleId: "foreign",
      }),
    ).rejects.toThrow(IsolationError);
    await expect(
      authorizeRecruitingFeedbackMessage(f.tx as never, actor, "thread", {
        ...selection,
        expectedRoleRevision: 2,
      }),
    ).rejects.toThrow("Recruiting revision changed");
    f.tx.recruitingCandidate.findMany.mockResolvedValueOnce([]);
    await expect(
      authorizeRecruitingFeedbackMessage(f.tx as never, actor, "thread", selection),
    ).rejects.toThrow(IsolationError);
  });
  it("applies only the selected role-local hold and restore with candidate CAS", async () => {
    const f = fixture();
    const updateMany = vi.fn(async (_query: unknown) => ({ count: 1 }));
    Object.assign(f.tx.recruitingCandidate, { updateMany });
    f.tx.recruitingCandidate.findMany.mockImplementation(
      async ({ where }) =>
        where.candidateKey.in.map((candidateKey) => ({
          candidateKey,
          consideration: null,
          revision: candidateKey === "avery" ? 2 : 0,
        })) as never,
    );
    const held = {
      ...selection,
      choice: "hold",
      candidateRevisions: [{ candidateKey: "avery", expectedRevision: 2 }],
    };
    f.source.blocks = [
      { kind: "text", text: "Hold Avery for this role", recruitingFeedback: held },
    ];
    await authorizeRecruitingFeedbackMessage(f.tx as never, actor, "thread", held, f.source.id);
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { roleId: "role", candidateKey: "avery", revision: 2 },
      data: {
        revision: { increment: 1 },
        consideration: expect.objectContaining({
          operation: "hold",
          source: expect.objectContaining({
            messageId: f.source.id,
            threadId: f.source.threadId,
            seq: f.source.seq,
            quote: "Hold Avery for this role",
            actor: { userId: actor.userId, spaceId: actor.spaceId },
          }),
        }),
      },
    });
    const resumed = {
      ...held,
      choice: "resume",
      candidateRevisions: [{ candidateKey: "avery", expectedRevision: 3 }],
    };
    const newer = {
      ...f.source,
      id: "newer",
      seq: 2,
      blocks: [{ kind: "text", text: "Resume Avery for this role", recruitingFeedback: resumed }],
    };
    f.tx.message.findFirst.mockResolvedValue(newer);
    f.tx.recruitingCandidate.findMany.mockResolvedValue([
      { candidateKey: "avery", revision: 3, consideration: null },
    ] as never);
    await authorizeRecruitingFeedbackMessage(f.tx as never, actor, "thread", resumed, newer.id);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { roleId: "role", candidateKey: "avery", revision: 3 },
      data: {
        revision: { increment: 1 },
        consideration: expect.objectContaining({
          operation: "resume",
          source: expect.objectContaining({ messageId: newer.id }),
        }),
      },
    });
    f.tx.recruitingCandidate.findMany.mockResolvedValue([
      { candidateKey: "avery", revision: 4, consideration: null },
    ] as never);
    await expect(
      authorizeRecruitingFeedbackMessage(f.tx as never, actor, "thread", resumed, newer.id),
    ).rejects.toThrow("Recruiting revision changed");
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("rejects an older intent from another thread even with the latest candidate revision", async () => {
    const f = fixture();
    const current = {
      ...selection,
      choice: "hold",
      candidateRevisions: [{ candidateKey: "avery", expectedRevision: 4 }],
    };
    f.source.createdAt = new Date("2026-10-18T01:00:00Z");
    f.source.seq = 100;
    f.source.blocks = [{ kind: "text", text: "Hold Avery", recruitingFeedback: current }];
    const newer = {
      ...f.source,
      id: "new-group-human",
      threadId: "another-thread",
      seq: 1,
      createdAt: new Date("2026-10-18T02:00:00Z"),
      blocks: [
        {
          kind: "text",
          text: "Resume Avery",
          recruitingFeedback: {
            ...current,
            choice: "resume",
            candidateRevisions: [{ candidateKey: "avery", expectedRevision: 3 }],
          },
        },
      ],
    };
    f.tx.message.findMany.mockResolvedValue([f.source, newer]);
    f.tx.recruitingCandidate.findMany.mockResolvedValue([
      {
        candidateKey: "avery",
        revision: 4,
        consideration: {
          operation: "resume",
          source: {
            messageId: newer.id,
            threadId: newer.threadId,
            seq: newer.seq,
            createdAt: newer.createdAt.toISOString(),
            quote: "Resume Avery",
            actor: { userId: actor.userId, spaceId: actor.spaceId },
          },
        },
      },
    ] as never);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    Object.assign(f.tx.recruitingCandidate, { updateMany });
    await expect(
      authorizeRecruitingFeedbackMessage(f.tx as never, actor, "thread", current, f.source.id),
    ).rejects.toThrow("Recruiting revision changed");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each(["chat", "authored form"])(
    "completes an executing native %s decision atomically and replays its receipt after a later restore",
    async (mode) => {
      const f = fixture();
      const feedback = {
        target: "candidate",
        operation: "hold",
        roleId: "role",
        expectedRoleRevision: 1,
        summary: "Pause consideration",
        intent: { basis: "direct", quote: "Hold Avery for this role" },
        sourceRefs: [],
        candidateKeys: ["avery"],
        candidateRevisions: [{ candidateKey: "avery", expectedRevision: 0 }],
      };
      f.source.blocks = [
        {
          kind: "text",
          text: feedback.intent.quote,
          ...(mode === "authored form"
            ? {
                recruitingFeedback: {
                  ...selection,
                  choice: "hold",
                  candidateRevisions: feedback.candidateRevisions,
                },
              }
            : {}),
        },
      ];
      const run = await f.tx.run.findFirst({});
      f.tx.run.findFirst.mockResolvedValue({
        ...run,
        leaseOwner: "worker",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      } as never);
      let revision = mode === "authored form" ? 1 : 0;
      let consideration: unknown =
        mode === "authored form"
          ? {
              operation: "hold",
              source: {
                messageId: f.source.id,
                threadId: f.source.threadId,
                seq: f.source.seq,
                createdAt: f.source.createdAt.toISOString(),
                quote: feedback.intent.quote,
                actor: { userId: actor.userId, spaceId: actor.spaceId },
              },
            }
          : null;
      f.tx.recruitingCandidate.findMany.mockImplementation(
        async () => [{ candidateKey: "avery", revision, consideration }] as never,
      );
      const updateMany = vi.fn(async ({ data }: { data: { consideration: unknown } }) => {
        revision++;
        consideration = data.consideration;
        return { count: 1 };
      });
      Object.assign(f.tx.recruitingCandidate, { updateMany });
      const effect = {
        id: "decision-effect",
        kind: "recruiting_feedback",
        spaceId: actor.spaceId,
        runId: "run",
        status: "executing",
        request: feedback,
        result: null as unknown,
      };
      f.tx.externalEffect.findFirst.mockResolvedValue(effect as never);
      const complete = vi.fn(async ({ data }: { data: object }) => {
        Object.assign(effect, data);
        return { count: 1 };
      });
      Object.assign(f.tx.externalEffect, { updateMany: complete });
      const trusted = {
        runId: "run",
        threadId: "thread",
        botId: "bot",
        sourceMessageId: "human",
        leaseOwner: "worker",
        leaseFence: 2,
        effectId: effect.id,
        effectRequest: feedback,
      };
      const result = await executeNativeRecruitingCandidateDecision(
        f.prisma,
        actor,
        trusted,
        feedback,
      );
      expect(result).toMatchObject({
        status: mode === "authored form" ? "already_recorded" : "recorded",
        feedback,
      });
      expect(revision).toBe(1);
      expect(effect.status).toBe("completed");
      revision = 2; // A newer human restore has already committed.
      consideration = { ...(consideration as object), operation: "resume" };
      f.tx.run.findFirst.mockResolvedValue({ ...run, status: "cancelled" } as never);
      await expect(
        executeNativeRecruitingCandidateDecision(f.prisma, actor, trusted, feedback),
      ).resolves.toEqual(result);
      expect(updateMany).toHaveBeenCalledTimes(mode === "authored form" ? 0 : 1);
      expect(complete).toHaveBeenCalledOnce();
    },
  );

  it.each(["valid", "stale", "missing name", "blank name"])(
    "prepares only verified candidate names for a %s decision approval",
    async (boundary) => {
      const f = fixture();
      const feedback = {
        target: "candidate",
        operation: "hold",
        roleId: "role",
        expectedRoleRevision: 1,
        summary: "Pause consideration",
        intent: { basis: "direct", quote },
        sourceRefs: [],
        candidateKeys: ["avery"],
        candidateRevisions: [
          { candidateKey: "avery", expectedRevision: boundary === "stale" ? 1 : 0 },
        ],
      };
      const run = await f.tx.run.findFirst({});
      f.tx.run.findFirst.mockResolvedValue({
        ...run,
        leaseOwner: "worker",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      } as never);
      f.tx.recruitingCandidate.findMany.mockResolvedValue([
        { candidateKey: "avery", consideration: null, revision: 0 },
      ] as never);
      f.tx.$queryRaw.mockResolvedValue([
        {
          id: "thread",
          name:
            boundary === "missing name" ? null : boundary === "blank name" ? "  " : "Example Avery",
          sourcePageId: null,
          profileSourcePageIds: [],
        },
      ] as never);
      const updateMany = vi.fn();
      Object.assign(f.tx.recruitingCandidate, { updateMany });
      const preflight = prepareNativeRecruitingCandidateDecision(
        f.prisma,
        actor,
        {
          runId: "run",
          threadId: "thread",
          botId: "bot",
          sourceMessageId: "human",
          leaseOwner: "worker",
          leaseFence: 2,
        },
        feedback,
      );
      if (boundary === "valid")
        await expect(preflight).resolves.toEqual({
          candidateNames: ["Example Avery"],
          roleTitle: "Engineer",
          operation: "hold",
        });
      else await expect(preflight).rejects.toThrow();
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["cancelled", "expired", "foreign-bot", "foreign-role", "stale", "race", "inferred"])(
    "rejects native decision boundary %s",
    async (boundary) => {
      const f = fixture();
      const feedback = {
        target: "candidate",
        operation: "pass",
        roleId: boundary === "foreign-role" ? "other" : "role",
        expectedRoleRevision: 1,
        summary: "Stop considering",
        intent: { basis: boundary === "inferred" ? "inferred" : "direct", quote },
        sourceRefs: [],
        candidateKeys: ["avery"],
        candidateRevisions: [
          { candidateKey: "avery", expectedRevision: boundary === "stale" ? 1 : 0 },
        ],
      };
      const run = await f.tx.run.findFirst({});
      f.tx.run.findFirst.mockResolvedValue({
        ...run,
        status: boundary === "cancelled" ? "cancelled" : "running",
        leaseOwner: "worker",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + (boundary === "expired" ? -60_000 : 60_000)),
      } as never);
      f.tx.recruitingCandidate.findMany.mockResolvedValue([
        { candidateKey: "avery", consideration: null, revision: 0 },
      ] as never);
      const updateMany = vi.fn(async () => ({ count: 0 }));
      Object.assign(f.tx.recruitingCandidate, { updateMany });
      f.tx.externalEffect.findFirst.mockResolvedValue({
        id: "effect",
        status: "executing",
        request: feedback,
      } as never);
      await expect(
        executeNativeRecruitingCandidateDecision(
          f.prisma,
          actor,
          {
            runId: "run",
            threadId: "thread",
            botId: boundary === "foreign-bot" ? "foreign" : "bot",
            sourceMessageId: "human",
            leaseOwner: "worker",
            leaseFence: 2,
            effectId: "effect",
            effectRequest: feedback,
          },
          feedback,
        ),
      ).rejects.toThrow();
      if (boundary === "race") expect(updateMany).toHaveBeenCalledOnce();
      else expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([["avery"], ["blair"], ["avery", "blair"]])(
    "applies an explicit pass only to the requested subset %j",
    async (...keys) => {
      const f = fixture();
      const candidateKeys = keys as string[];
      const selected = {
        ...selection,
        choice: "pass",
        candidateKeys,
        candidateRevisions: candidateKeys.map((candidateKey) => ({
          candidateKey,
          expectedRevision: 3,
        })),
      };
      f.source.blocks = [
        {
          kind: "text",
          text: "Stop considering only these people for this role",
          recruitingFeedback: selected,
        },
      ];
      f.tx.recruitingCandidate.findMany.mockImplementation(
        async ({ where }) =>
          where.candidateKey.in.map((candidateKey) => ({
            candidateKey,
            revision: 3,
            consideration: null,
          })) as never,
      );
      const updateMany = vi.fn(async (_query: unknown) => ({ count: 1 }));
      Object.assign(f.tx.recruitingCandidate, { updateMany });
      await authorizeRecruitingFeedbackMessage(
        f.tx as never,
        actor,
        "thread",
        selected,
        f.source.id,
      );
      expect(
        updateMany.mock.calls.map(
          ([input]) => (input as { where: { candidateKey: string } }).where.candidateKey,
        ),
      ).toEqual(candidateKeys);
    },
  );

  it("omits deleted human proof from history without losing its scan cursor", async () => {
    const f = fixture();
    const feedback = {
      target: "candidate",
      operation: "hold",
      roleId: "role",
      expectedRoleRevision: 1,
      candidateKeys: ["avery"],
      candidateRevisions: [{ candidateKey: "avery", expectedRevision: 0 }],
      summary: "Pause consideration",
      intent: { basis: "direct", quote },
      sourceRefs: [],
    };
    const source = {
      id: "human-message:human",
      kind: "original_material",
      anchor: { kind: "message", messageId: "human", locator: "blocks[0].text" },
      readState: "read",
      readAt: "2026-10-18T00:00:00.000Z",
      quote,
    };
    const retained = {
      id: "retained",
      createdAt: new Date("2026-10-18T01:00:00Z"),
      request: feedback,
      result: { feedback, source, workspace: { revision: { id: "revision" } } },
    };
    const removed = {
      ...retained,
      id: "deleted-proof",
      createdAt: new Date("2026-10-18T02:00:00Z"),
      result: {
        ...retained.result,
        source: { ...source, anchor: { ...source.anchor, messageId: "deleted-human" } },
      },
    };
    f.tx.externalEffect.findMany
      .mockResolvedValueOnce([removed, retained] as never)
      .mockResolvedValueOnce([retained] as never);
    f.tx.message.findMany.mockImplementation(async (query) =>
      (query as { where: { id?: unknown } }).where.id ? [f.source] : [],
    );
    const first = await listRecruitingFeedback(f.prisma, actor, { roleId: "role", limit: 1 });
    expect(first).toEqual({ feedback: [], nextCursor: removed.id });
    f.tx.externalEffect.findFirst.mockResolvedValueOnce(removed as never);
    const second = await listRecruitingFeedback(f.prisma, actor, {
      roleId: "role",
      limit: 1,
      before: first.nextCursor!,
    });
    expect(second.feedback.map((record) => record.id)).toEqual([retained.id]);
    expect(second.nextCursor).toBeNull();
  });

  it.each(["not_fit", "skip", "good_example"])(
    "keeps %s review feedback separate from hold/pass decisions",
    async (choice) => {
      const f = fixture();
      const updateMany = vi.fn();
      Object.assign(f.tx.recruitingCandidate, { updateMany });
      await authorizeRecruitingFeedbackMessage(f.tx as never, actor, "thread", {
        ...selection,
        choice,
      });
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it("merges native form and general feedback with one scope-bound cursor", async () => {
    const f = fixture();
    const form = {
      ...f.source,
      id: "form-human",
      createdAt: new Date("2026-10-18T01:00:00Z"),
      blocks: [
        {
          kind: "text",
          text: "Example Avery: Not a fit. No infrastructure ownership.",
          recruitingFeedback: selection,
        },
      ],
    };
    const feedback = {
      target: "round",
      operation: "scope",
      roleId: "role",
      expectedRoleRevision: 1,
      summary: "Use the supplied direction",
      intent: f.input.intent,
      sourceRefs: [],
    };
    const source = {
      id: "human-message:human",
      kind: "original_material",
      anchor: { kind: "message", messageId: "human", locator: "blocks[0].text" },
      readState: "read",
      readAt: "2026-10-18T02:00:00.000Z",
      quote,
    };
    const effect = {
      id: "round-feedback",
      createdAt: new Date("2026-10-18T02:00:00Z"),
      request: feedback,
      result: { feedback, source, workspace: { revision: { id: "revision" } } },
    };
    f.tx.message.findMany.mockImplementation(async (query) =>
      (query as { where: { id?: unknown } }).where.id ? [f.source] : [form],
    );
    f.tx.externalEffect.findMany.mockResolvedValueOnce([effect] as never).mockResolvedValueOnce([]);
    const first = await listRecruitingFeedback(f.prisma, actor, { roleId: "role", limit: 1 });
    expect(first.feedback.map((record) => record.id)).toEqual(["round-feedback"]);
    expect(first.nextCursor).toBe("round-feedback");
    f.tx.externalEffect.findFirst.mockResolvedValueOnce(effect as never);
    const second = await listRecruitingFeedback(f.prisma, actor, {
      roleId: "role",
      limit: 1,
      before: first.nextCursor!,
    });
    expect(second.feedback.map((record) => record.id)).toEqual(["form-human"]);
    expect(second.nextCursor).toBeNull();
    expect(f.tx.externalEffect.findMany.mock.calls[1]![0]).toMatchObject({
      where: {
        OR: [
          { createdAt: { lt: effect.createdAt } },
          { createdAt: effect.createdAt, id: { lt: effect.id } },
        ],
      },
    });
  });
  it.each([
    { basis: "direct", quote: "Recheck Avery and Blair only." },
    { basis: "direct", quote: "Recheck the first two people only." },
    { basis: "inferred", quote: "Recheck Avery and Blair only." },
    { basis: "inferred", quote: "Recheck the first two people only." },
  ] as const)("admits context-resolved $basis candidate references: $quote", async (intent) => {
    const f = fixture();
    f.source.blocks = [{ kind: "text", text: intent.quote }];
    const result = await readRecruitingFeedbackContext(f.prisma, actor, { ...f.input, intent });
    expect(result).toMatchObject({
      source: { quote: intent.quote, anchor: { kind: "message", messageId: "human" } },
      workspace: { role: { id: "role" } },
    });
    expect(f.tx.recruitingCandidate.findMany).toHaveBeenCalledWith({
      where: { roleId: "role", candidateKey: { in: ["avery", "blair"] } },
      select: { candidateKey: true },
    });
  });

  it.each([
    { basis: "direct", candidateKeys: ["avery", "foreign-role-candidate"] },
    { basis: "direct", candidateKeys: ["avery", "missing"] },
    { basis: "direct", candidateKeys: [] },
    { basis: "direct", candidateKeys: ["avery", "avery"] },
    { basis: "inferred", candidateKeys: ["avery", "foreign-role-candidate"] },
    { basis: "inferred", candidateKeys: ["avery", "missing"] },
    { basis: "inferred", candidateKeys: [] },
    { basis: "inferred", candidateKeys: ["avery", "avery"] },
  ] as const)(
    "rejects unauthorized or invalid $basis candidate keys: $candidateKeys",
    async (input) => {
      const f = fixture();
      await expect(
        readRecruitingFeedbackContext(f.prisma, actor, {
          ...f.input,
          candidateKeys: input.candidateKeys,
          intent: { ...f.input.intent, basis: input.basis },
        }),
      ).rejects.toThrow(IsolationError);
    },
  );

  it("preserves the authenticated form selection and refuses broader or different candidates", async () => {
    const f = fixture();
    f.source.blocks = [{ kind: "text", text: quote, recruitingFeedback: selection }];
    expect(
      await readRecruitingFeedbackContext(f.prisma, actor, {
        ...f.input,
        candidateKeys: ["avery"],
      }),
    ).toMatchObject({ choice: "not_fit" });
    expect(f.tx.recruitingCandidate.findMany).toHaveBeenCalledWith({
      where: { roleId: "role", candidateKey: { in: ["avery"] } },
      select: { candidateKey: true },
    });
    f.tx.recruitingCandidate.findMany.mockResolvedValueOnce([]);
    await expect(
      readRecruitingFeedbackContext(f.prisma, actor, { ...f.input, candidateKeys: ["avery"] }),
    ).rejects.toThrow(IsolationError);
    await expect(readRecruitingFeedbackContext(f.prisma, actor, f.input)).rejects.toThrow(
      IsolationError,
    );
    await expect(
      readRecruitingFeedbackContext(f.prisma, actor, { ...f.input, candidateKeys: ["blair"] }),
    ).rejects.toThrow(IsolationError);
    await expect(
      readRecruitingFeedbackContext(f.prisma, actor, { ...f.input, candidateKeys: undefined }),
    ).rejects.toThrow(IsolationError);
  });
  it("authorizes feedback history before reading effects and binds pagination to that scope", async () => {
    const f = fixture();
    await expect(
      listRecruitingFeedback(f.prisma, actor, { roleId: "role", candidateKey: "avery", limit: 3 }),
    ).resolves.toEqual({ feedback: [], nextCursor: null });
    expect(f.tx.externalEffect.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: actor.spaceId,
          run: { userId: actor.userId, spaceId: actor.spaceId },
        }),
        take: 4,
      }),
    );
    await expect(
      listRecruitingFeedback(f.prisma, actor, { roleId: "role", before: "foreign" }),
    ).rejects.toThrow(IsolationError);
    f.tx.recruitingRole.findFirst.mockResolvedValueOnce(null as never);
    f.tx.externalEffect.findMany.mockClear();
    await expect(listRecruitingFeedback(f.prisma, actor, { roleId: "foreign" })).rejects.toThrow(
      IsolationError,
    );
    expect(f.tx.externalEffect.findMany).not.toHaveBeenCalled();
  });

  it("reads only a completed recorded native effect with its real human source after restart", async () => {
    const f = fixture();
    const feedback = {
      target: "candidate",
      operation: "review",
      roleId: "role",
      expectedRoleRevision: 1,
      candidateKeys: ["avery", "blair"],
      summary: "Use the supplied feedback",
      intent: f.input.intent,
      sourceRefs: [],
    };
    const result = {
      status: "recorded",
      feedback,
      workspace: { revision: { id: "revision" } },
      source: {
        id: "human-message:human",
        kind: "original_material",
        anchor: { kind: "message", messageId: "human", locator: "blocks[0].text" },
        readState: "read",
        readAt: "2026-10-18T00:00:00.000Z",
        quote,
      },
    };
    f.tx.externalEffect.findMany.mockResolvedValue([
      { id: "receipt", createdAt: new Date("2026-10-18T00:00:00Z"), request: feedback, result },
    ] as never);
    expect(await listRecruitingFeedback(f.prisma, actor, { roleId: "role" })).toMatchObject({
      feedback: [
        { id: "receipt", source: { quote }, feedback: { candidateKeys: ["avery", "blair"] } },
      ],
      nextCursor: null,
    });
    const serialized = JSON.stringify(f.tx.externalEffect.findMany.mock.calls[0]![0]);
    expect(serialized).toContain('"status":"completed"');
    expect(serialized).toContain('"equals":"recorded"');
    expect(f.tx.message.findMany).toHaveBeenCalledTimes(2);
    expect(f.tx.thread.findFirst).toHaveBeenCalledTimes(1);
    f.source.blocks = [{ kind: "text", text: "Changed text" }];
    await expect(listRecruitingFeedback(f.prisma, actor, { roleId: "role" })).rejects.toThrow(
      IsolationError,
    );
  });
});
