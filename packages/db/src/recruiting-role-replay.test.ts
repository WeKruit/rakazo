import type { Actor } from "@rakazo/contracts";
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
    botId: null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: source.quote }],
  };
  const effect = { status: "completed", request: input, result: saved };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
    run: {
      findFirst: vi.fn(async () => ({
        id: "run",
        ...actor,
        threadId: "thread",
        botId: "bot",
        status: "completed",
        bot: actor,
      })),
    },
    thread: { findFirst: vi.fn(async () => thread) },
    bot: { findFirst: vi.fn(async () => actor) },
    message: {
      findFirst: vi.fn(async () => human),
      findUnique: vi.fn(async () => human),
      findMany: vi.fn(async () => [human]),
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
  return { prisma, context, input, saved, row, tx, effect, thread };
}
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
