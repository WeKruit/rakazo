import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { confirmRecruitingBrief } from "./recruiting.js";

const actor: Actor = {
  spaceId: "space",
  userId: "human",
  email: "human@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const thread = {
    id: "thread",
    spaceId: "space",
    userId: "human",
    botId: "bot",
    activeRecruitingRoleId: "role",
  };
  let role = {
    id: "role",
    spaceId: "space",
    userId: "human",
    sourceThreadId: "thread",
    title: "Example engineer",
    revision: 1,
    currentRevisionId: "revision-1",
  };
  const source = {
    id: "jd",
    kind: "original_material",
    anchor: { kind: "message", messageId: "jd-message", locator: "blocks[0].text" },
    readState: "read",
    readAt: "2026-10-16T18:00:00Z",
    quote: "GBP 90,000 to 120,000",
  };
  const revisions = [
    {
      id: "revision-1",
      roleId: "role",
      revision: 1,
      sourceRefs: [source],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
      createdAt: new Date(0),
      brief: {
        fields: [
          {
            key: "salary_range",
            value: "GBP 90,000 to 120,000",
            state: "known",
            origin: "jd",
            consequential: true,
            sourceRefIds: ["jd"],
          },
        ],
        questions: [],
        rules: [],
        confirmation: null,
      },
    },
  ];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: {
      findFirst: vi.fn(async () => thread),
      update: vi.fn(async () => ({ nextMessageSeq: 2 })),
    },
    bot: { findFirst: vi.fn(async () => actor) },
    message: {
      findUnique: vi.fn(async () => ({
        id: "jd-message",
        role: "user",
        botId: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "GBP 90,000 to 120,000" }],
      })),
      findMany: vi.fn(async () => [{ id: "jd-message", threadId: "thread" }]),
      create: vi.fn(async ({ data }) => ({ id: "human-confirmation", ...data })),
    },
    recruitingRole: {
      findFirst: vi.fn(async () => role),
      updateMany: vi.fn(async ({ data }) => {
        role = { ...role, ...data };
        return { count: 1 };
      }),
    },
    recruitingRoleRevision: {
      findFirst: vi.fn(async ({ where }) => revisions.find((revision) => revision.id === where.id)),
      create: vi.fn(async ({ data }) => {
        const revision = { id: "revision-2", createdAt: new Date(), ...data };
        revisions.push(revision);
        return revision;
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx, thread, revisions };
}
describe("native human brief confirmation", () => {
  it("stores the authenticated human message and a new immutable confirmed revision in one transaction", async () => {
    const f = fixture();
    const saved = await confirmRecruitingBrief(f.prisma, actor, {
      threadId: "thread",
      roleId: "role",
      expectedRevision: 1,
    });
    expect(saved.revision.revision).toBe(2);
    expect(saved.revision.brief?.confirmation).toMatchObject({
      revision: 2,
      userId: actor.userId,
      messageId: "human-confirmation",
    });
    expect(f.revisions[0]!.brief.confirmation).toBeNull();
    expect(f.tx.message.create).toHaveBeenCalledOnce();
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
  });
  it("rejects stale, foreign and unbound requests before writing a human message", async () => {
    for (const mode of ["stale", "foreign", "unbound"]) {
      const f = fixture();
      if (mode === "foreign") f.thread.userId = "someone-else";
      if (mode === "unbound") f.thread.activeRecruitingRoleId = "other-role";
      await expect(
        confirmRecruitingBrief(f.prisma, actor, {
          threadId: "thread",
          roleId: "role",
          expectedRevision: mode === "stale" ? 2 : 1,
        }),
      ).rejects.toThrow();
      expect(f.tx.message.create).not.toHaveBeenCalled();
    }
  });
  it("rejects material conflicts and caller-supplied confirmation metadata", async () => {
    const f = fixture();
    f.revisions[0]!.brief.fields[0]!.state = "conflict";
    await expect(
      confirmRecruitingBrief(f.prisma, actor, {
        threadId: "thread",
        roleId: "role",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/questions/);
    await expect(
      confirmRecruitingBrief(f.prisma, actor, {
        threadId: "thread",
        roleId: "role",
        expectedRevision: 1,
        confirmation: { userId: "invented" },
      }),
    ).rejects.toThrow();
    expect(f.tx.message.create).not.toHaveBeenCalled();
  });
});

it("revalidates the original quoted material before recording confirmation", async () => {
  const f = fixture();
  f.tx.message.findUnique.mockResolvedValueOnce({
    id: "jd-message",
    role: "user",
    botId: null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: "Different source text" }],
  });
  await expect(
    confirmRecruitingBrief(f.prisma, actor, {
      threadId: "thread",
      roleId: "role",
      expectedRevision: 1,
    }),
  ).rejects.toThrow(/quote/);
  expect(f.tx.message.create).not.toHaveBeenCalled();
});

it("accepts actual native human provenance for a user instruction", async () => {
  const f = fixture();
  f.revisions[0]!.brief.fields[0]!.origin = "user_instruction";
  const native = {
    id: "jd-message",
    threadId: "thread",
    role: "user",
    botId: null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: "GBP 90,000 to 120,000" }],
  };
  f.tx.message.findMany.mockResolvedValue([native]);
  const saved = await confirmRecruitingBrief(f.prisma, actor, {
    threadId: "thread",
    roleId: "role",
    expectedRevision: 1,
  });
  expect(saved.revision.brief?.confirmation?.userId).toBe(actor.userId);
  expect(f.tx.message.create).toHaveBeenCalledOnce();
});

it("rejects bot-authored evidence mislabeled as a user instruction", async () => {
  const f = fixture();
  f.revisions[0]!.brief.fields[0]!.origin = "user_instruction";
  const bot = {
    id: "jd-message",
    threadId: "thread",
    role: "bot",
    botId: "bot",
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: "GBP 90,000 to 120,000" }],
  };
  f.tx.message.findMany.mockResolvedValue([bot]);
  await expect(
    confirmRecruitingBrief(f.prisma, actor, {
      threadId: "thread",
      roleId: "role",
      expectedRevision: 1,
    }),
  ).rejects.toThrow();
  expect(f.tx.message.create).not.toHaveBeenCalled();
});
