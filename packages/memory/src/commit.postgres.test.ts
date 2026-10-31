import type { AdapterContext, MemoryCommitRequest } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { createDb, createRecruitingRole, readRecruitingFeedbackContext } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("memory commits (PostgreSQL)", () => {
  const context: AdapterContext = {
    operationId: "memory-commit-test",
    traceId: "memory-commit-test",
    spaceId: "memory-commit-space",
    userId: "memory-commit-user",
    signal: new AbortController().signal,
  };
  let prisma: PrismaClient;
  let store: MarkdownMemoryStore;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    store = new MarkdownMemoryStore(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: context.userId, name: "Memory owner", email: "memory-owner@example.test" },
    });
    await prisma.organization.create({
      data: {
        id: context.spaceId,
        name: "Memory Test Organization",
        slug: context.spaceId,
        createdAt: new Date(),
        spaces: {
          create: {
            id: context.spaceId,
            name: "Memory Test Space",
            bots: {
              create: {
                id: "memory-commit-bot",
                userId: context.userId,
                name: "Memory Test Bot",
                color: "ink",
              },
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: context.spaceId } });
      await prisma.user.deleteMany({ where: { id: context.userId } });
    } finally {
      await close();
    }
  });

  function request(path: string, content: string, expectedRevision = 0): MemoryCommitRequest {
    return {
      scope: "user",
      path,
      content,
      expectedRevision,
      sourceRunId: `run-${content}`,
      sourceThreadId: `thread-${content}`,
    };
  }

  async function document(path: string) {
    return prisma.memoryDocument.findFirstOrThrow({
      where: { spaceId: context.spaceId, path },
      include: { revisions: { orderBy: { revision: "asc" } } },
    });
  }

  async function agentFixture(boundRole = true) {
    const bot = await prisma.bot.create({
      data: {
        spaceId: context.spaceId,
        userId: context.userId,
        name: "Recruiting",
        color: "ink",
      },
    });
    const thread = await prisma.thread.create({
      data: {
        spaceId: context.spaceId,
        userId: context.userId,
        botId: bot.id,
      },
    });
    const source = await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        blocks: [{ kind: "text", text: "Always show the complete prompt" }],
      },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: context.spaceId,
        userId: context.userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Recruiting preference",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: context.spaceId,
        userId: context.userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        sourceMessageId: source.id,
        trigger: "user",
        status: "running",
      },
    });
    if (boundRole)
      await createRecruitingRole(
        prisma,
        {
          spaceId: context.spaceId,
          userId: context.userId,
          email: "owner@example.test",
          isDeploymentOwner: false,
        },
        {
          sourceThreadId: thread.id,
          expectedRevision: 0,
          title: "Synthetic engineer",
          sourceRefs: [
            {
              id: `human-${source.id}`,
              kind: "original_material",
              anchor: { kind: "message", messageId: source.id, locator: "blocks[0].text" },
              readState: "read",
              readAt: new Date().toISOString(),
            },
          ],
          criteria: [],
          preferences: [],
          definitionQuestions: [],
        },
      );
    const path = `preference-${run.id}.md`;
    const agentContext = { ...context, botId: bot.id, runId: run.id };
    const commit: MemoryCommitRequest = {
      scope: "user",
      path,
      content: "Show complete prompts",
      expectedRevision: 0,
      sourceRunId: run.id,
      sourceThreadId: thread.id,
    };
    const feedback = {
      target: "preference" as const,
      operation: "add" as const,
      scope: "user" as const,
      path,
      expectedRevision: 0,
      intent: { basis: "direct" as const, quote: "Always show the complete prompt" },
      sourceRefs: [],
      content: commit.content,
    };
    const recruiting = { sourceMessageId: source.id, feedback };
    return { bot, thread, source, run, path, agentContext, commit, feedback, recruiting };
  }

  it("rejects agent memory writes that bypass recruiting intent without creating document or history", async () => {
    const f = await agentFixture();
    await expect(store.commit(f.commit, f.agentContext)).rejects.toThrow();
    expect(
      await prisma.memoryDocument.count({ where: { spaceId: context.spaceId, path: f.path } }),
    ).toBe(0);
    expect(await prisma.memoryRevision.count({ where: { sourceRunId: f.run.id } })).toBe(0);
  });

  it("applies exact preference add, replacement and revocation while preserving unrelated bytes and history", async () => {
    const f = await agentFixture();
    const untouched = "Keep this line.\r\nKeep its whitespace.\n";
    await store.commit({ ...f.commit, content: untouched }, context);
    const appended = `${untouched}\n\n${f.feedback.content}`;
    const added = await store.commit(
      {
        ...f.commit,
        expectedRevision: 1,
        content: appended,
        recruiting: { ...f.recruiting, feedback: { ...f.feedback, expectedRevision: 1 } },
      },
      f.agentContext,
    );
    expect(added.content).toBe(appended);
    expect(added.revision).toBe(2);
    const start = untouched.length + 2;
    const nextText = "Show every complete prompt";
    const replaced = await store.commit(
      {
        ...f.commit,
        expectedRevision: 2,
        content: `${untouched}\n\n${nextText}`,
        recruiting: {
          ...f.recruiting,
          feedback: {
            ...f.feedback,
            operation: "replace",
            expectedRevision: 2,
            anchor: { start, end: start + f.feedback.content.length, quote: f.feedback.content },
            content: nextText,
          },
        },
      },
      f.agentContext,
    );
    expect(replaced.revision).toBe(3);
    const { content: _content, ...base } = f.feedback;
    const revoked = await store.commit(
      {
        ...f.commit,
        expectedRevision: 3,
        content: `${untouched}\n\n`,
        recruiting: {
          ...f.recruiting,
          feedback: {
            ...base,
            operation: "revoke",
            expectedRevision: 3,
            anchor: { start, end: start + nextText.length, quote: nextText },
          },
        },
      },
      f.agentContext,
    );
    expect(revoked.content).toBe(`${untouched}\n\n`);
    expect((await document(f.path)).revisions).toHaveLength(4);
    const receipts = await prisma.event.findMany({
      where: { runId: f.run.id, type: "memory.revised" },
      orderBy: { seq: "asc" },
    });
    expect(receipts).toHaveLength(3);
    expect(receipts[0]?.payload).toMatchObject({
      kind: "recruiting_preference",
      documentId: added.id,
      revision: 2,
      previousSourceVerified: false,
      scope: "user",
      path: f.path,
      operation: "add",
      previousAnchor: null,
      anchor: { start, end: start + f.feedback.content.length, quote: f.feedback.content },
      source: {
        anchor: { kind: "message", messageId: f.source.id },
        quote: f.feedback.intent.quote,
      },
    });
    expect(receipts[1]?.payload).toMatchObject({
      operation: "replace",
      previousAnchor: { start, end: start + f.feedback.content.length, quote: f.feedback.content },
      anchor: { start, end: start + nextText.length, quote: nextText },
    });
    expect(receipts[2]?.payload).toMatchObject({
      revision: 4,
      operation: "revoke",
      anchor: null,
      previousAnchor: { start, end: start + nextText.length, quote: nextText },
    });
  });

  it.each(["bot", "user"] as const)(
    "revokes the final %s preference to empty without deleting history",
    async (scope) => {
      const f = await agentFixture();
      const feedback = { ...f.feedback, scope };
      const commit = { ...f.commit, scope, ...(scope === "bot" ? { botId: f.bot.id } : {}) };
      const saved = await store.commit(
        { ...commit, recruiting: { ...f.recruiting, feedback } },
        f.agentContext,
      );
      const { content: _content, ...base } = feedback;
      await store.commit(
        {
          ...commit,
          content: "",
          expectedRevision: 1,
          recruiting: {
            ...f.recruiting,
            feedback: {
              ...base,
              operation: "revoke",
              expectedRevision: 1,
              anchor: { start: 0, end: saved.content.length, quote: saved.content },
            },
          },
        },
        f.agentContext,
      );
      expect(await document(f.path)).toMatchObject({ content: "", revision: 2 });
      expect((await document(f.path)).revisions).toHaveLength(2);
    },
  );

  it("rolls back memory and history when its recruiting source event cannot be saved", async () => {
    const f = await agentFixture();
    const rejectingStore = new MarkdownMemoryStore(
      prisma.$extends({
        query: {
          event: {
            async create({ args, query }) {
              return query({
                ...args,
                data: {
                  ...(args.data as Prisma.EventUncheckedCreateInput),
                  threadId: "missing-receipt-thread",
                },
              });
            },
          },
        },
      }) as PrismaClient,
    );
    // Role setup records its own thread event; the failed commit must not take a sequence.
    const { nextEventSeq } = await prisma.thread.findUniqueOrThrow({ where: { id: f.thread.id } });
    await expect(
      rejectingStore.commit({ ...f.commit, recruiting: f.recruiting }, f.agentContext),
    ).rejects.toThrow();
    expect(
      await prisma.memoryDocument.count({ where: { spaceId: context.spaceId, path: f.path } }),
    ).toBe(0);
    expect(await prisma.memoryRevision.count({ where: { sourceRunId: f.run.id } })).toBe(0);
    expect(await prisma.event.count({ where: { runId: f.run.id } })).toBe(0);
    expect(
      (await prisma.thread.findUniqueOrThrow({ where: { id: f.thread.id } })).nextEventSeq,
    ).toBe(nextEventSeq);
  });

  it("allows a current human to edit owned memory after its prior source message is deleted", async () => {
    const prior = await agentFixture();
    const original = await store.commit(
      { ...prior.commit, recruiting: prior.recruiting },
      prior.agentContext,
    );
    await prisma.message.delete({ where: { id: prior.source.id } });
    expect(
      await prisma.event.count({ where: { runId: prior.run.id, type: "memory.revised" } }),
    ).toBe(1);
    const current = await agentFixture();
    const loaded = (await store.read({ scope: "user", path: prior.path }, current.agentContext))
      .documents[0]!;
    const content = "Show every complete prompt";
    const replaced = await store.commit(
      {
        ...current.commit,
        path: prior.path,
        expectedRevision: loaded.revision,
        content,
        recruiting: {
          ...current.recruiting,
          feedback: {
            ...current.feedback,
            operation: "replace",
            path: prior.path,
            expectedRevision: loaded.revision,
            content,
            anchor: { start: 0, end: loaded.content.length, quote: loaded.content },
          },
        },
      },
      current.agentContext,
    );
    expect(replaced).toMatchObject({ id: original.id, revision: 2, content });
    const event = await prisma.event.findFirstOrThrow({
      where: { runId: current.run.id, type: "memory.revised" },
    });
    expect(event.payload).toMatchObject({
      documentId: original.id,
      revision: 2,
      previousSourceVerified: false,
      source: { anchor: { messageId: current.source.id } },
    });
  });

  it("prevents an older live run from reapplying its human input over a newer preference source", async () => {
    const older = await agentFixture();
    const newer = await agentFixture();
    const original = await store.commit(
      { ...older.commit, recruiting: older.recruiting },
      older.agentContext,
    );
    const text = "Use compact reports";
    await prisma.message.update({
      where: { id: newer.source.id },
      data: { blocks: [{ kind: "text", text }] },
    });
    const feedback = {
      ...newer.feedback,
      operation: "replace" as const,
      path: older.path,
      expectedRevision: 1,
      intent: { basis: "direct" as const, quote: text },
      anchor: { start: 0, end: original.content.length, quote: original.content },
      content: text,
    };
    await store.commit(
      {
        ...newer.commit,
        path: older.path,
        content: text,
        expectedRevision: 1,
        recruiting: { sourceMessageId: newer.source.id, feedback },
      },
      newer.agentContext,
    );
    await expect(
      store.commit(
        {
          ...older.commit,
          content: original.content,
          expectedRevision: 2,
          recruiting: {
            ...older.recruiting,
            feedback: {
              ...older.feedback,
              operation: "replace",
              expectedRevision: 2,
              anchor: { start: 0, end: text.length, quote: text },
            },
          },
        },
        older.agentContext,
      ),
    ).rejects.toThrow();
    expect((await document(older.path)).content).toBe(text);
    const refined = await store.commit(
      {
        ...newer.commit,
        path: older.path,
        content: "Compact reports",
        expectedRevision: 2,
        recruiting: {
          sourceMessageId: newer.source.id,
          feedback: {
            ...feedback,
            expectedRevision: 2,
            anchor: { start: 0, end: text.length, quote: text },
            content: "Compact reports",
          },
        },
      },
      newer.agentContext,
    );
    expect(refined.revision).toBe(3);
  });

  it("allows explicit preferences before role selection and preserves ordinary agent memory behavior outside recruiting", async () => {
    const ordinary = await agentFixture(false);
    await expect(store.commit(ordinary.commit, ordinary.agentContext)).resolves.toMatchObject({
      revision: 1,
    });
    const preference = await agentFixture(false);
    await expect(
      store.commit(
        { ...preference.commit, recruiting: preference.recruiting },
        preference.agentContext,
      ),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it("rejects inferred, forged, mismatched or unverified preference commits without writes", async () => {
    const f = await agentFixture();
    const valid = { ...f.commit, recruiting: f.recruiting };
    const attempts: MemoryCommitRequest[] = [
      {
        ...valid,
        recruiting: {
          ...f.recruiting,
          feedback: { ...f.feedback, intent: { ...f.feedback.intent, basis: "inferred" } },
        },
      },
      {
        ...valid,
        recruiting: { ...f.recruiting, feedback: { ...f.feedback, target: "role" } as never },
      },
      { ...valid, recruiting: { ...f.recruiting, feedback: { ...f.feedback, scope: "bot" } } },
      { ...valid, recruiting: { ...f.recruiting, feedback: { ...f.feedback, path: "other.md" } } },
      {
        ...valid,
        recruiting: { ...f.recruiting, feedback: { ...f.feedback, expectedRevision: 1 } },
      },
      {
        ...valid,
        recruiting: {
          ...f.recruiting,
          feedback: { ...f.feedback, intent: { ...f.feedback.intent, quote: "Invented consent" } },
        },
      },
      { ...valid, sourceRunId: "other-run" },
      { ...valid, sourceThreadId: "other-thread" },
      { ...valid, content: "Also erase unrelated preferences" },
      { ...valid, scope: "bot", botId: "other-bot" },
    ];
    for (const attempt of attempts)
      await expect(store.commit(attempt, f.agentContext)).rejects.toThrow();
    await expect(store.commit(valid, context)).rejects.toThrow();
    await expect(
      store.commit(valid, { ...f.agentContext, userId: "other-owner" }),
    ).rejects.toThrow();
    const unclaimed = await prisma.message.create({
      data: {
        threadId: f.thread.id,
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: f.feedback.intent.quote }],
      },
    });
    await expect(
      store.commit(
        { ...valid, recruiting: { ...f.recruiting, sourceMessageId: unclaimed.id } },
        f.agentContext,
      ),
    ).rejects.toThrow();
    await prisma.message.update({
      where: { id: f.source.id },
      data: {
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: f.bot.id,
            fromBotName: "Peer",
            text: f.feedback.intent.quote,
          },
        ],
      },
    });
    await expect(store.commit(valid, f.agentContext)).rejects.toThrow();
    expect(
      await prisma.memoryDocument.count({ where: { spaceId: context.spaceId, path: f.path } }),
    ).toBe(0);
    expect(await prisma.memoryRevision.count({ where: { sourceRunId: f.run.id } })).toBe(0);
  });

  it("rejects a formerly valid source after newer claimed human steering", async () => {
    const f = await agentFixture();
    const newer = await prisma.message.create({
      data: {
        threadId: f.thread.id,
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "Use compact reports instead" }],
      },
    });
    await prisma.steeringMessage.create({
      data: {
        messageId: newer.id,
        botId: f.bot.id,
        userId: context.userId,
        runId: f.run.id,
        claimedAt: new Date(),
      },
    });
    await expect(
      store.commit({ ...f.commit, recruiting: f.recruiting }, f.agentContext),
    ).rejects.toThrow();
    expect(
      await prisma.memoryDocument.count({ where: { spaceId: context.spaceId, path: f.path } }),
    ).toBe(0);
  });

  it("rechecks live run state inside the memory transaction after an earlier authorization", async () => {
    const f = await agentFixture();
    await readRecruitingFeedbackContext(
      prisma,
      {
        spaceId: context.spaceId,
        userId: context.userId,
        email: "owner@example.test",
        isDeploymentOwner: false,
      },
      { runId: f.run.id, sourceMessageId: f.source.id, intent: f.feedback.intent, sourceRefs: [] },
    );
    let cancelled = false;
    const cancellingStore = new MarkdownMemoryStore(
      prisma.$extends({
        query: {
          memoryDocument: {
            async findFirst({ args, query }) {
              const result = await query(args);
              if (!cancelled && args.where?.path === f.path) {
                cancelled = true;
                await prisma.run.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
              }
              return result;
            },
          },
        },
      }) as PrismaClient,
    );
    await expect(
      cancellingStore.commit({ ...f.commit, recruiting: f.recruiting }, f.agentContext),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(
      await prisma.memoryDocument.count({ where: { spaceId: context.spaceId, path: f.path } }),
    ).toBe(0);
    expect(await prisma.memoryRevision.count({ where: { sourceRunId: f.run.id } })).toBe(0);
  });

  it.each([
    ["user", false],
    ["bot", false],
    ["user", true],
    ["bot", true],
  ] as const)(
    "accepts one overlapping %s replacement and preserves history (existing: %s)",
    async (scope, existing) => {
      const path = `concurrent-${scope}-${existing}.md`;
      const write = (content: string, expectedRevision = 0): MemoryCommitRequest => ({
        ...request(path, content, expectedRevision),
        scope,
        botId: scope === "bot" ? "memory-commit-bot" : undefined,
      });
      const initial = existing ? await store.commit(write("initial"), context) : undefined;
      const preparedRevision = initial?.revision ?? 0;
      let reads = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      const concurrentStore = new MarkdownMemoryStore(
        prisma.$extends({
          query: {
            memoryDocument: {
              async findFirst({ args, query }) {
                const result = await query(args);
                reads += 1;
                // Both first attempts see the same target before either can write.
                if (reads === 2) release();
                if (reads <= 2) await bothRead;
                return result;
              },
            },
          },
        }) as PrismaClient,
      );

      const results = await Promise.allSettled([
        concurrentStore.commit(write("first", preparedRevision), context),
        concurrentStore.commit(write("second", preparedRevision), context),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { message: MEMORY_REVISION_CONFLICT_ERROR },
      });
      expect(reads).toBe(3);
      const saved = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(saved.map((result) => result.revision)).toEqual([preparedRevision + 1]);
      const current = await document(path);
      expect(current.revision).toBe(preparedRevision + 1);
      expect(current.content).toBe(saved[0]!.content);
      expect(current.revisions).toHaveLength(preparedRevision + 1);
      for (const result of [...(initial ? [initial] : []), ...saved]) {
        expect(
          current.revisions.find((revision) => revision.revision === result.revision),
        ).toMatchObject({
          documentId: result.id,
          revision: result.revision,
          content: result.content,
          sourceRunId: `run-${result.content}`,
          sourceThreadId: `thread-${result.content}`,
        });
      }
    },
  );

  it.each([false, true])(
    "rolls back a rejected history insert and permits a caller retry (existing: %s)",
    async (existing) => {
      const path = `rejected-${existing}.md`;
      if (existing) await store.commit(request(path, "initial"), context);
      const before = await prisma.memoryDocument.findMany({
        where: { spaceId: context.spaceId, path },
        include: { revisions: true },
      });
      let inserts = 0;
      const rejectingStore = new MarkdownMemoryStore(
        prisma.$extends({
          query: {
            memoryRevision: {
              async create({ args, query }) {
                inserts += 1;
                // Make PostgreSQL reject the history row after the document write.
                return query({
                  ...args,
                  data: {
                    ...args.data,
                    document: undefined,
                    documentId: "missing-memory-document",
                  },
                });
              },
            },
          },
        }) as PrismaClient,
      );

      await expect(
        rejectingStore.commit(request(path, "rejected", existing ? 1 : 0), context),
      ).rejects.toMatchObject({
        code: "P2003",
      });
      expect(inserts).toBe(1);
      expect(
        await prisma.memoryDocument.findMany({
          where: { spaceId: context.spaceId, path },
          include: { revisions: true },
        }),
      ).toEqual(before);

      const retried = await store.commit(request(path, "rejected", existing ? 1 : 0), context);
      expect(retried.revision).toBe(existing ? 2 : 1);
      const current = await document(path);
      expect(current.revisions).toHaveLength(retried.revision);
      expect(current.revisions.at(-1)).toMatchObject({
        revision: retried.revision,
        content: retried.content,
      });
    },
  );

  it("rechecks the prepared revision after a serialization retry without overwriting the winner", async () => {
    const path = "serialization-conflict.md";
    await store.commit(request(path, "initial"), context);
    let attempts = 0;
    const conflictingStore = new MarkdownMemoryStore(
      prisma.$extends({
        query: {
          memoryDocument: {
            async findFirst({ args, query }) {
              const result = await query(args);
              attempts += 1;
              if (attempts === 1) await store.commit(request(path, "winner", 1), context);
              return result;
            },
          },
        },
      }) as PrismaClient,
    );

    await expect(conflictingStore.commit(request(path, "rejected", 1), context)).rejects.toThrow(
      MEMORY_REVISION_CONFLICT_ERROR,
    );
    expect(attempts).toBe(2);
    const current = await document(path);
    expect(current).toMatchObject({ revision: 2, content: "winner" });
    expect(current.revisions.map(({ revision, content }) => ({ revision, content }))).toEqual([
      { revision: 1, content: "initial" },
      { revision: 2, content: "winner" },
    ]);
  });

  it("preserves current content and history when an import targets a stale revision", async () => {
    const path = "stale-import.md";
    await store.commit(request(path, "initial"), context);
    async function* preparedFiles() {
      yield { path, content: new TextEncoder().encode("stale import"), expectedRevision: 1 };
    }
    await store.commit(request(path, "new preference", 1), context);
    await expect(store.importMarkdown(preparedFiles(), context)).rejects.toThrow(
      MEMORY_REVISION_CONFLICT_ERROR,
    );
    const current = await document(path);
    expect(current).toMatchObject({ content: "new preference", revision: 2 });
    expect(current.revisions).toHaveLength(2);
  });

  it("appends empty-body revocation and retains prior history", async () => {
    const path = "revoked.md";
    await store.commit(request(path, "last preference"), context);
    await store.commit(request(path, "", 1), context);
    const current = await document(path);
    expect(current).toMatchObject({ revision: 2, content: "" });
    expect(current.revisions.map(({ revision, content }) => ({ revision, content }))).toEqual([
      { revision: 1, content: "last preference" },
      { revision: 2, content: "" },
    ]);
  });
  it("keeps group notes inside their own group conversation", async () => {
    const save = (groupId: string | undefined, content: string) =>
      store.commit(
        { scope: "group", groupId, path: "NOTES.md", content, expectedRevision: 0 },
        context,
      );
    await save("memory-group-a", "room a");
    await save("memory-group-b", "room b");
    await expect(save(undefined, "nowhere")).rejects.toThrow("group conversation");

    const roomA = await store.read({ scope: "group", groupId: "memory-group-a" }, context);
    expect(roomA.documents.map((doc) => doc.content)).toEqual(["room a"]);
    expect((await store.read({ scope: "group" }, context)).documents).toEqual([]);
    const shared = await store.read({ scope: "user", path: "NOTES.md" }, context);
    expect(shared.documents).toEqual([]);
    const otherUser = await store.read(
      { scope: "group", groupId: "memory-group-a" },
      { ...context, userId: "someone-else" },
    );
    expect(otherUser.documents).toEqual([]);
  });
});
