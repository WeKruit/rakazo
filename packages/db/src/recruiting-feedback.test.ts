import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  authorizeRecruitingFeedbackMessage,
  listRecruitingFeedback,
  readRecruitingFeedbackContext,
} from "./recruiting.js";
import { IsolationError } from "./scope.js";

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
      findFirst: vi.fn(async () => ({
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
    steeringMessage: { findMany: vi.fn(async () => []) },
    recruitingCandidate: {
      findUnique: vi.fn(async () => ({ roleId: "role", candidateKey: "avery" })),
      findMany: vi.fn(async () => [{ candidateKey: "avery" }]),
    },
    recruitingCandidateOccurrence: {
      findMany: vi.fn(async () => [
        { candidateKey: "avery", name: "Example Avery", linkedinUrl: null, resumeUrl: null },
        { candidateKey: "blair", name: "Example Blair", linkedinUrl: null, resumeUrl: null },
      ]),
      count: vi.fn(async (_input: unknown) => 0),
    },
    externalEffect: {
      findMany: vi.fn(async (_input: unknown) => []),
      findFirst: vi.fn(async () => null),
    },
  };
  const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  return { prisma, tx, input, source };
}

describe("native recruiting feedback records", () => {
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
  it("validates every selected candidate against the actual human quote", async () => {
    const f = fixture();
    expect(await readRecruitingFeedbackContext(f.prisma, actor, f.input)).toMatchObject({
      source: { quote },
    });
    f.tx.recruitingCandidateOccurrence.findMany.mockResolvedValueOnce([
      { candidateKey: "other", name: "Other Person", linkedinUrl: null, resumeUrl: null },
    ]);
    await expect(
      readRecruitingFeedbackContext(f.prisma, actor, { ...f.input, candidateKeys: ["other"] }),
    ).rejects.toThrow(IsolationError);
    f.tx.recruitingCandidateOccurrence.count.mockResolvedValueOnce(1);
    await expect(readRecruitingFeedbackContext(f.prisma, actor, f.input)).rejects.toThrow(
      IsolationError,
    );
  });
  it("preserves the authenticated form selection and refuses broader or different candidates", async () => {
    const f = fixture();
    f.source.blocks = [{ kind: "text", text: quote, recruitingFeedback: selection }];
    f.tx.recruitingCandidateOccurrence.findMany.mockResolvedValueOnce([]);
    expect(
      await readRecruitingFeedbackContext(f.prisma, actor, {
        ...f.input,
        candidateKeys: ["avery"],
      }),
    ).toMatchObject({ choice: "not_fit" });
    expect(f.tx.recruitingCandidateOccurrence.findMany).not.toHaveBeenCalled();
    f.tx.recruitingCandidate.findUnique.mockResolvedValueOnce(null as never);
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
  it("refuses case-insensitive name ambiguity instead of selecting a different saved candidate", async () => {
    const f = fixture();
    f.tx.recruitingCandidateOccurrence.count.mockImplementationOnce(async (query) => {
      const name = (query as { where: { name: unknown } }).where.name;
      return typeof name === "object" &&
        name !== null &&
        "mode" in name &&
        name.mode === "insensitive"
        ? 1
        : 0;
    });
    await expect(
      readRecruitingFeedbackContext(f.prisma, actor, { ...f.input, candidateKeys: ["avery"] }),
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
