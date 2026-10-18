import type { Actor, MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { executeRecruitingRoleMutation } from "./recruiting.js";
import { IsolationError } from "./scope.js";

const actor: Actor = {
  spaceId: "space",
  userId: "human",
  email: "human@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const source = {
    id: "human-source",
    kind: "original_material" as const,
    anchor: { kind: "message" as const, messageId: "message", locator: "blocks[0].text" },
    readState: "read" as const,
    readAt: "2026-10-15T00:00:00.000Z",
    quote: "Create this role",
  };
  const input = {
    operation: "create" as const,
    title: "Example engineer",
    sourceRefs: [source],
    criteria: [],
    preferences: [],
    definitionQuestions: [],
    intent: { basis: "direct" as const, quote: source.quote },
  };
  // Immutable JSON in the pre-brief receipt format. No brief key existed in this schema.
  const saved = {
    status: "saved" as const,
    changed: true,
    source,
    workspace: {
      role: {
        id: "role",
        spaceId: "space",
        userId: "human",
        sourceThreadId: "thread",
        title: input.title,
        revision: 1,
        currentRevisionId: "revision-1",
      },
      revision: {
        id: "revision-1",
        roleId: "role",
        revision: 1,
        sourceRefs: [source],
        criteria: [],
        preferences: [] as string[],
        definitionQuestions: [],
        createdAt: "2026-10-15T00:00:00.000Z",
      },
    },
  };
  const row = {
    ...structuredClone(saved.workspace.revision),
    createdAt: new Date(saved.workspace.revision.createdAt),
    brief: null,
  };
  const thread = { id: "thread", spaceId: "space", userId: "human", botId: "bot" };
  const human = {
    id: "message",
    threadId: "thread",
    role: "user",
    botId: null as string | null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: source.quote }] as MessageBlock[],
    seq: 0,
    runId: null as string | null,
    createdAt: new Date(0),
  };
  const effect = { id: "effect", status: "completed", request: input, result: saved };
  const run = {
    id: "run",
    ...actor,
    threadId: "thread",
    botId: "bot",
    status: "completed",
    bot: actor,
    sourceMessageId: human.id,
    trigger: "user",
    leaseOwner: "worker",
    leaseFence: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
    run: {
      findFirst: vi.fn(async () => run),
    },
    thread: { findFirst: vi.fn(async () => thread) },
    bot: { findFirst: vi.fn(async () => actor) },
    message: {
      findFirst: vi.fn(async (_query?: unknown) => human),
      findUnique: vi.fn(async (_query?: unknown) => human),
      findMany: vi.fn(async (_query?: unknown) => [human]),
    },
    externalEffect: { findFirst: vi.fn(async () => effect) },
    // Current state has advanced; replay must check the historical row without rewinding it.
    recruitingRole: {
      findFirst: vi.fn(async () => ({
        ...saved.workspace.role,
        revision: 2,
        currentRevisionId: "revision-2",
      })),
    },
    recruitingRoleRevision: { findFirst: vi.fn(async () => row) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  const context = {
    runId: "run",
    threadId: "thread",
    botId: "bot",
    sourceMessageId: "message",
    leaseOwner: "expired-worker",
    leaseFence: 1,
    effectId: "effect",
    effectRequest: input,
  };
  return { prisma, context, input, saved, row, tx, effect, thread, run, human };
}

describe("native role creation after clarification", () => {
  it.each([
    "valid",
    "latest hint",
    "latest intent",
    "stale hint",
    "reversed source",
    "foreign thread",
    "foreign actor",
    "bot source",
    "forged answer",
    "new steering",
    "bind",
  ])(
    "preserves the original hiring intent with multiple authenticated answers: %s",
    async (boundary) => {
      const f = fixture();
      f.run.status = "running";
      f.effect.status = "executing";
      f.context.leaseOwner = f.run.leaseOwner;
      const answers = ["https://example.test/job", "Local only."].map((text, index) => ({
        ...f.human,
        id: `answer-${index}`,
        seq: index * 2 + 2,
        blocks: [{ kind: "text", text }] as MessageBlock[],
      }));
      const cards = answers.map((answer, index) => ({
        ...f.human,
        id: `card-${index}`,
        seq: answer.seq - 1,
        role: "bot",
        botId: f.run.botId,
        runId: f.run.id,
        blocks: [
          {
            kind: "ask",
            text: "Clarify this field",
            status: "answered",
            answer: answer.blocks[0]!.kind === "text" ? answer.blocks[0]!.text : "",
          },
        ] as MessageBlock[],
      }));
      const receipts = cards.flatMap((card, index) => [
        { type: "run.waiting_input", seq: index * 2 + 1, payload: {} as Record<string, unknown> },
        {
          type: "thread.choice",
          seq: index * 2 + 2,
          payload: {
            messageId: card.id,
            askIndex: 0,
            answerMessageId: answers[index]!.id,
            answeredByUserId: actor.userId,
          },
        },
      ]);
      const messages = [f.human, ...cards, ...answers];
      f.tx.message.findFirst.mockImplementation(async (query) => {
        const { where } = query as { where: { id: string; threadId: string } };
        return messages.find(
          (message) => message.id === where.id && message.threadId === where.threadId,
        ) as typeof f.human;
      });
      f.tx.message.findUnique.mockImplementation(
        async (query) =>
          messages.find(
            (message) => message.id === (query as { where: { id: string } }).where.id,
          ) as typeof f.human,
      );
      f.tx.message.findMany.mockImplementation(async (query) => {
        const { where } = query as { where: { id: { in: string[] }; threadId?: string } };
        return messages.filter(
          (message) =>
            where.id.in.includes(message.id) &&
            (!where.threadId || message.threadId === where.threadId),
        );
      });
      const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
      Object.assign(f.tx.recruitingRole, { create });
      Object.assign(f.tx.recruitingRoleRevision, {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
          Object.assign(f.row, data, { brief: null }),
        ),
      });
      Object.assign(f.tx.thread, { update: vi.fn(async () => ({ ...f.thread, nextEventSeq: 1 })) });
      Object.assign(f.tx.run, { findUnique: vi.fn(async () => f.run) });
      Object.assign(f.tx.externalEffect, { updateMany: vi.fn(async () => ({ count: 1 })) });
      Object.assign(f.tx, {
        event: {
          findMany: vi.fn(async () => receipts),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        },
        steeringMessage: {
          findMany: vi.fn(async () =>
            boundary === "new steering"
              ? [{ messageId: "newer", message: { ...f.human, id: "newer", seq: 5 } }]
              : [],
          ),
        },
      });
      for (const answer of answers)
        f.input.sourceRefs.push({
          ...f.input.sourceRefs[0]!,
          id: `source-${answer.id}`,
          anchor: { kind: "message", messageId: answer.id, locator: "blocks[0].text" },
          quote: answer.blocks[0]!.kind === "text" ? answer.blocks[0]!.text : "",
        });
      if (boundary === "latest intent") f.input.intent.quote = "Local only.";
      if (boundary === "latest hint") f.context.sourceMessageId = answers.at(-1)!.id;
      if (boundary === "stale hint") f.context.sourceMessageId = "unrelated";
      if (boundary === "reversed source") f.human.seq = 5;
      if (boundary === "foreign thread") f.human.threadId = "foreign";
      if (boundary === "bot source") f.human.role = "bot";
      if (boundary === "forged answer") receipts.at(-1)!.payload.answeredByUserId = "foreign";
      const input =
        boundary === "bind"
          ? { operation: "bind" as const, roleId: null, intent: f.input.intent }
          : f.input;
      Object.assign(f.effect, { request: input });
      const result = executeRecruitingRoleMutation(
        f.prisma,
        boundary === "foreign actor" ? { ...actor, spaceId: "foreign" } : actor,
        { ...f.context, effectRequest: input },
        input,
      );
      if (!["valid", "latest hint", "latest intent"].includes(boundary)) {
        await expect(result).rejects.toThrow(IsolationError);
        expect(create).not.toHaveBeenCalled();
        return;
      }
      const saved = await result;
      expect(saved.status).toBe("saved");
      expect(saved.source?.anchor).toMatchObject({
        messageId: boundary === "latest intent" ? answers.at(-1)!.id : f.human.id,
      });
      expect(
        saved.workspace?.revision.sourceRefs.map(
          (source) => source.anchor.kind === "message" && source.anchor.messageId,
        ),
      ).toEqual(expect.arrayContaining([f.human.id, ...answers.map((answer) => answer.id)]));
      expect(create).toHaveBeenCalledOnce();
    },
  );
});

describe("pre-brief immutable recruiting role receipt replay", () => {
  it("replays the original completed receipt against a migrated null brief without rewriting it", async () => {
    const f = fixture();
    const before = JSON.stringify(f.saved);
    expect(await executeRecruitingRoleMutation(f.prisma, actor, f.context, f.input)).toEqual(
      f.saved,
    );
    expect(JSON.stringify(f.effect.result)).toBe(before);
    expect(f.saved.workspace.revision).not.toHaveProperty("brief");
    expect(f.tx.recruitingRoleRevision.findFirst).toHaveBeenCalledWith({
      where: { id: "revision-1", roleId: "role", revision: 1 },
    });
  });
  it.each(["userId", "spaceId"] as const)(
    "rejects a foreign actor %s before replay",
    async (key) => {
      const f = fixture();
      await expect(
        executeRecruitingRoleMutation(f.prisma, { ...actor, [key]: "foreign" }, f.context, f.input),
      ).rejects.toThrow(IsolationError);
    },
  );
  it.each(["preferences", "sources", "timestamp", "revision", "owner", "space", "thread", "brief"])(
    "still rejects a mismatched %s",
    async (boundary) => {
      const f = fixture();
      if (boundary === "preferences") f.row.preferences = ["Tampered preference"];
      if (boundary === "sources") f.row.sourceRefs[0]!.quote = "Changed quote";
      if (boundary === "timestamp") f.row.createdAt = new Date("2026-10-16T00:00:00Z");
      if (boundary === "revision") f.saved.workspace.role.revision = 2;
      if (boundary === "owner") f.saved.workspace.role.userId = "other-human";
      if (boundary === "space") f.saved.workspace.role.spaceId = "other-space";
      if (boundary === "thread") f.saved.workspace.role.sourceThreadId = "other-thread";
      if (boundary === "brief")
        Object.assign(f.row, {
          brief: { searchFilters: [], fields: [], questions: [], rules: [], confirmation: null },
        });
      await expect(
        executeRecruitingRoleMutation(f.prisma, actor, f.context, f.input),
      ).rejects.toThrow(IsolationError);
    },
  );
});
