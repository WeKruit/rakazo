import { createHash } from "node:crypto";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor, CreateRecruitingRoleInput, RecruitingSourceRef } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  bindRecruitingRole,
  createDb,
  createRecruitingRole,
  reviseRecruitingRole,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAgentMemoryContext } from "./memory-context.js";
import { loadRecruitingRunContext } from "./recruiting-context.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("native recruiting context adoption (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `adoption-org-${suffix}`;
  const spaceId = `adoption-space-${suffix}`;
  const userId = `adoption-user-${suffix}`;
  const actor: Actor = { spaceId, userId, email: "owner@example.test", isDeploymentOwner: false };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: "Synthetic owner", email: `${userId}@example.test` },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Synthetic adoption",
        slug: organizationId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Synthetic adoption" } },
      },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await close();
    }
  });

  async function fixture(group = false) {
    const bot = await prisma.bot.create({ data: { spaceId, userId, name: "Main", color: "ink" } });
    const chatGroup = group
      ? await prisma.chatGroup.create({ data: { spaceId, userId, name: "Crew" } })
      : null;
    if (chatGroup)
      await prisma.chatGroupMember.create({ data: { groupId: chatGroup.id, botId: bot.id } });
    const thread = await prisma.thread.create({
      data: { spaceId, userId, ...(chatGroup ? { groupId: chatGroup.id } : { botId: bot.id }) },
    });
    const message = await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        blocks: [{ kind: "text", text: "Seven years" }],
      },
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Synthetic adoption",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
        sourceMessageId: message.id,
        checkpoint: "A checkpoint is not the recruiting source of truth",
      },
    });
    const context: AdapterContext = {
      spaceId,
      userId,
      botId: bot.id,
      runId: run.id,
      operationId: run.id,
      traceId: run.id,
      signal: new AbortController().signal,
    };
    const source: RecruitingSourceRef = {
      id: `source-${message.id}`,
      kind: "recruiter_verified",
      anchor: { kind: "message", messageId: message.id, locator: "text:0" },
      readState: "read",
      readAt: "2026-10-15T00:00:00.000Z",
    };
    const input: CreateRecruitingRoleInput = {
      sourceThreadId: thread.id,
      expectedRevision: 0,
      title: "Software engineer",
      sourceRefs: [source],
      preferences: [],
      definitionQuestions: [],
      criteria: [
        {
          id: "years",
          priority: "hard",
          expression: { kind: "atom", id: "years", statement: "Seven years" },
          sourceRefs: [source],
          definitionQuestions: [],
        },
      ],
    };
    const workspace = await createRecruitingRole(prisma, actor, input);
    const { sourceThreadId: _sourceThreadId, ...definition } = input;
    const blobs = new Map<string, Uint8Array>();
    let number = 0;
    let beforePut: () => Promise<void> = async () => undefined;
    const artifacts: ArtifactStore = {
      describe: () => ({
        id: "test",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { stream: false },
      }),
      async put({ bytes }) {
        const id = `blob-${run.id}-${++number}`;
        blobs.set(id, new Uint8Array(bytes));
        await beforePut();
        return { id, hash: "not-a-sha256" };
      },
      async get(id) {
        const value = blobs.get(id);
        if (!value) throw new Error("Blob missing");
        return value;
      },
      async remove(id) {
        blobs.delete(id);
      },
    };
    const deps = { prisma, artifacts, events: { notify: vi.fn(async () => undefined) } };
    return {
      run,
      context,
      workspace,
      input,
      definition,
      blobs,
      deps,
      chatGroup,
      beforePut: (callback: () => Promise<void>) => {
        beforePut = callback;
      },
    };
  }

  it("publishes one native artifact and ref-only event for concurrent identical adoption and resume", async () => {
    const f = await fixture(true);
    const memory = await loadAgentMemoryContext(
      {
        read: async ({ scope }) => ({
          documents:
            scope === "bot"
              ? [
                  {
                    id: "omitted",
                    path: "omitted.md",
                    content: "private body omitted by budget",
                    revision: 2,
                  },
                  { id: "revoked", path: "revoked.md", content: "", revision: 3 },
                ]
              : [],
        }),
      } as Parameters<typeof loadAgentMemoryContext>[0],
      f.run.botId,
      f.context,
      0,
    );
    const [first, concurrent] = await Promise.all([
      loadRecruitingRunContext(f.deps, f.run, memory, f.context, { reason: "run" }),
      loadRecruitingRunContext(f.deps, f.run, memory, f.context, { reason: "run" }),
    ]);
    const resumed = await loadRecruitingRunContext(f.deps, f.run, memory, f.context, {
      reason: "restart",
    });
    expect(concurrent!.contextArtifact).toEqual(first!.contextArtifact);
    expect(resumed!.manifest).toEqual(first!.manifest);
    const rows = await prisma.artifact.findMany({ where: { runId: f.run.id } });
    const events = await prisma.event.findMany({
      where: { runId: f.run.id, type: "recruiting.context.adopted" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.groupId).toBe(f.chatGroup!.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      roleId: f.workspace.role.id,
      roleRevisionId: f.workspace.revision.id,
      contextArtifact: first!.contextArtifact,
    });
    const bytes = f.blobs.get(rows[0]!.storageKey)!;
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(rows[0]!.hash);
    const manifest = JSON.parse(Buffer.from(bytes).toString("utf8"));
    expect(
      manifest.memory.documents.map((doc: { disposition: string }) => doc.disposition).sort(),
    ).toEqual(["budget", "empty"]);
    expect(Buffer.from(bytes).toString("utf8")).not.toContain("private body omitted by budget");
    expect(f.blobs.size).toBe(3);
    expect(f.deps.events.notify).toHaveBeenCalledTimes(1);
  });

  it("adopts current DB state in the same run and a new bound thread while preserving initial revision", async () => {
    const f = await fixture();
    const first = await loadRecruitingRunContext(f.deps, f.run, { documents: [] }, f.context, {
      reason: "run",
    });
    const revised = await reviseRecruitingRole(prisma, actor, {
      ...f.definition,
      roleId: f.workspace.role.id,
      expectedRevision: 1,
      title: "Senior engineer",
      criteria: [
        {
          ...f.input.criteria[0]!,
          expression: { kind: "atom", id: "years", statement: "Eight years" },
        },
      ],
    });
    const next = await loadRecruitingRunContext(f.deps, f.run, { documents: [] }, f.context, {
      reason: "role_tool",
      placement: "tool_result",
    });
    expect(next!.workspace.revision.id).toBe(revised.revision.id);
    expect(next!.text).toContain("Eight years");
    expect(next!.contextArtifact.artifactId).not.toBe(first!.contextArtifact.artifactId);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } }))
        .initialRecruitingRoleRevisionId,
    ).toBe(first!.workspace.revision.id);
    const sourceBot = await prisma.bot.create({
      data: { spaceId, userId, name: "Sourcer", color: "ink" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: sourceBot.id } });
    await bindRecruitingRole(prisma, actor, { threadId: thread.id, roleId: revised.role.id });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: sourceBot.id,
        threadId: thread.id,
        prompt: "Synthetic handoff",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: sourceBot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
    const restored = await loadRecruitingRunContext(
      f.deps,
      run,
      { documents: [] },
      { ...f.context, botId: sourceBot.id, runId: run.id },
      { reason: "run" },
    );
    expect(restored!.workspace.revision.id).toBe(revised.revision.id);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: run.id } }))
        .initialRecruitingRoleRevisionId,
    ).toBe(revised.revision.id);
  });

  it.each(["revision", "binding", "cancelled"] as const)(
    "rejects stale %s state before recording adoption",
    async (change) => {
      const f = await fixture();
      f.beforePut(async () => {
        if (change === "revision")
          await reviseRecruitingRole(prisma, actor, {
            ...f.definition,
            roleId: f.workspace.role.id,
            expectedRevision: 1,
            title: "Changed",
          });
        if (change === "binding")
          await bindRecruitingRole(prisma, actor, { threadId: f.run.threadId, roleId: null });
        if (change === "cancelled")
          await prisma.run.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
      });
      await expect(
        loadRecruitingRunContext(f.deps, f.run, { documents: [] }, f.context, {
          reason: "role_tool",
          trustedWorkspace: f.workspace,
        }),
      ).rejects.toThrow();
      expect(await prisma.artifact.count({ where: { runId: f.run.id } })).toBe(0);
      expect(
        await prisma.event.count({
          where: { runId: f.run.id, type: "recruiting.context.adopted" },
        }),
      ).toBe(0);
      expect(f.blobs.size).toBe(1);
      expect(f.deps.events.notify).not.toHaveBeenCalled();
      expect(
        (await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } }))
          .initialRecruitingRoleRevisionId,
      ).toBeNull();
    },
  );

  it.each(["run", "bot", "source"] as const)(
    "rejects a sibling thread's %s at the native adoption boundary",
    async (mismatch) => {
      const f = await fixture();
      const other = await fixture();
      const run = {
        ...f.run,
        ...(mismatch === "run" ? { id: other.run.id } : {}),
        ...(mismatch === "bot" ? { botId: other.run.botId } : {}),
      };
      await expect(
        loadRecruitingRunContext(
          f.deps,
          run,
          { documents: [] },
          { ...f.context, runId: run.id, botId: run.botId },
          {
            reason: "role_tool",
            trustedWorkspace: f.workspace,
            ...(mismatch === "source" ? { sourceMessageId: other.run.sourceMessageId } : {}),
          },
        ),
      ).rejects.toThrow("Resource not found");
      expect(
        await prisma.artifact.count({ where: { runId: { in: [f.run.id, other.run.id] } } }),
      ).toBe(0);
      expect(
        await prisma.event.count({
          where: { runId: { in: [f.run.id, other.run.id] }, type: "recruiting.context.adopted" },
        }),
      ).toBe(0);
    },
  );

  it("rejects an external conversation attached to a different owned bot", async () => {
    const f = await fixture();
    const other = await fixture();
    const conversation = await prisma.externalConversation.create({
      data: {
        provider: "synthetic",
        workspaceId: spaceId,
        externalKey: `external-${f.run.id}`,
        conversationId: `conversation-${f.run.id}`,
        spaceId,
        userId,
        botId: other.run.botId,
      },
    });
    await prisma.thread.update({
      where: { id: f.run.threadId },
      data: { botId: null, externalConversationId: conversation.id },
    });
    await expect(
      loadRecruitingRunContext(f.deps, f.run, { documents: [] }, f.context, {
        reason: "role_tool",
        trustedWorkspace: f.workspace,
      }),
    ).rejects.toThrow("Resource not found");
    expect(await prisma.artifact.count({ where: { runId: f.run.id } })).toBe(0);
    expect(
      await prisma.event.count({ where: { runId: f.run.id, type: "recruiting.context.adopted" } }),
    ).toBe(0);
  });
});
