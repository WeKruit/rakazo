import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actorPreferenceRlsTables, actorRlsTables, createActorDb, withDatabaseActor } from "./actor-db.js";
import { createDb } from "./client.js";

const url = process.env.RLS_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
suite("first-batch RLS with a real restricted role", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const role = `rls_test_${suffix}`;
  const actors = ["a", "b"].map((name) => ({
    userId: `rls-${name}-${suffix}`,
    spaceId: `rls-space-${name}-${suffix}`,
  }));
  let admin: ReturnType<typeof createDb>;
  let restricted: ReturnType<typeof createActorDb>;
  let sql: Pool;
  const run = async <T>(index: number, action: () => Promise<T>) =>
    (await withDatabaseActor(actors[index]!, async () => ({ output: await action() }))).output;
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
      !target.pathname.startsWith("/rakazo_a2_rls")
    )
      throw new Error("RLS tests require a dedicated local synthetic database");
    sql = new Pool({ connectionString: url, max: 1 });
    await sql.query(
      await readFile(new URL("../prisma/rls/first-batch.sql", import.meta.url), "utf8"),
    );
    await sql.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS`);
    await sql.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await sql.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );
    admin = createDb(url!, { poolMax: 1 });
    for (const actor of actors) {
      const { userId, spaceId } = actor;
      await admin.prisma.user.create({
        data: { id: userId, name: "Synthetic RLS", email: `${userId}@example.test` },
      });
      await admin.prisma.organization.create({
        data: { id: spaceId, name: "Synthetic RLS", slug: spaceId, createdAt: new Date() },
      });
      await admin.prisma.space.create({
        data: { id: spaceId, organizationId: spaceId, name: "Synthetic RLS", isDefault: true },
      });
      await admin.prisma.member.create({
        data: {
          id: userId,
          organizationId: spaceId,
          userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await admin.prisma.bot.create({
        data: { id: userId, userId, spaceId, name: "Synthetic", color: "blue" },
      });
      await admin.prisma.thread.create({ data: { id: userId, userId, spaceId, botId: userId } });
      await admin.prisma.message.create({
        data: { id: userId, threadId: userId, seq: 1, role: "user", blocks: [] },
      });
      await admin.prisma.artifact.create({
        data: {
          id: userId,
          userId,
          spaceId,
          name: "Synthetic",
          mimeType: "text/plain",
          size: 1,
          hash: "a".repeat(64),
          storageKey: userId,
        },
      });
      await admin.prisma.$transaction(async (tx) => {
        await tx.recruitingRole.create({
          data: {
            id: userId,
            spaceId,
            userId,
            sourceThreadId: userId,
            title: "Synthetic role",
            revision: 1,
            currentRevisionId: userId,
          },
        });
        await tx.recruitingRoleRevision.create({
          data: {
            id: userId,
            roleId: userId,
            revision: 1,
            criteria: [],
            sourceRefs: [],
            preferences: [],
            definitionQuestions: [],
          },
        });
      });
    }
    for (const actor of actors) {
      await admin.prisma.recruitingCandidate.create({
        data: { roleId: actor.userId, candidateKey: "synthetic" },
      });
      await admin.prisma.recruitingCalibrationRound.create({
        data: {
          id: actor.userId,
          roleId: actor.userId,
          round: 1,
          candidateKeys: ["synthetic"],
          effectId: actor.userId,
        },
      });
    }
    target.username = role;
    target.password = "";
    restricted = createActorDb(target.href, { poolMax: 1 });
    await restricted.prisma.$connect();
    for (const [index, { userId: id, spaceId }] of actors.entries()) {
      await run(index, async () => {
        const now = new Date();
        const db = restricted.prisma;
        const owner = { userId: id, spaceId };
        await db.task.create({
          data: { id, ...owner, botId: id, threadId: id, prompt: "Synthetic", status: "completed" },
        });
        await db.run.create({
          data: {
            id,
            ...owner,
            botId: id,
            threadId: id,
            taskId: id,
            status: "completed",
            trigger: "user",
          },
        });
        for (const kind of ["page", "import", "reply", "binding", "read"]) {
          await db.externalEffect.create({
            data: {
              id: `${id}-${kind}`,
              spaceId,
              runId: id,
              kind: "test",
              idempotencyKey: `${id}-${kind}`,
              status: "completed",
              request: {},
              result: { synthetic: true },
            },
          });
        }
        await db.event.create({
          data: { id, spaceId, threadId: id, botId: id, seq: 1, type: "synthetic", payload: {} },
        });
        await db.mcpServer.create({
          data: {
            id,
            ...owner,
            slug: "synthetic",
            name: "Synthetic",
            transport: "http",
            endpoint: "https://example.test",
          },
        });
        await db.recruitingResearchTask.create({
          data: { id, roleId: id, mcpServerId: id, serverRevision: 1, createdByRunId: id },
        });
        await db.recruitingResearchAction.create({
          data: {
            id,
            taskId: id,
            roleRevisionId: id,
            runId: id,
            sourceMessageId: id,
            clientNonce: id,
            kind: "create",
            requestArtifactId: id,
            requestArtifactHash: "a".repeat(64),
            contextArtifactId: id,
            contextArtifactHash: "a".repeat(64),
          },
        });
        await db.recruitingAssessment.create({
          data: {
            roleId: id,
            candidateKey: "synthetic",
            version: 1,
            roleRevisionId: id,
            facts: [],
            judgments: [],
            questions: [],
            sourceRefs: [],
            createdByRunId: id,
          },
        });
        await db.recruitingCandidatePage.create({
          data: {
            effectId: `${id}-page`,
            roleId: id,
            taskId: id,
            actionId: id,
            roleRevisionId: id,
            artifactId: id,
            artifactHash: "synthetic",
            observedAt: now,
            rowCount: 1,
          },
        });
        await db.recruitingCandidateOccurrence.create({
          data: {
            pageId: `${id}-page`,
            rowIndex: 0,
            roleId: id,
            candidateKey: "synthetic",
            name: "Synthetic",
            issues: [],
          },
        });
        await db.recruitingCrmImport.create({
          data: {
            effectId: `${id}-import`,
            bindingEffectId: `${id}-binding`,
            pageId: `${id}-page`,
            rowIndex: 0,
          },
        });
        await db.recruitingReply.create({
          data: {
            effectId: `${id}-reply`,
            roleRevisionId: id,
            crmImportEffectId: `${id}-import`,
            emailReadEffectId: `${id}-read`,
            crmContextReadEffectId: `${id}-read`,
          },
        });
        const mirror = {
          id,
          ...owner,
          mcpServerId: id,
          organizationId: "synthetic-external-organization",
          syncedAt: now,
        };
        await db.recruitingCrmRole.create({
          data: {
            ...mirror,
            crmRoleId: id,
            clientId: "synthetic",
            clientLabel: "Synthetic",
            roleLabel: "Synthetic",
          },
        });
        await db.recruitingCrmContact.create({
          data: {
            ...mirror,
            crmCandidateId: id,
            name: "Synthetic",
            contactStatus: "synthetic",
            outreachStatus: "none",
            clientLabel: "Synthetic",
            roleLabel: "Synthetic",
          },
        });
        await db.recruitingCrmRoleContact.create({
          data: { roleId: id, contactId: id, syncedAt: now },
        });
        await db.recruitingCrmMessage.create({
          data: { ...mirror, crmMessageId: id, crmCandidateId: id, crmRoleId: id, recipients: [] },
        });
        await db.recruitingCrmCampaign.create({
          data: { ...mirror, crmCampaignId: id, name: "Synthetic", mirrorSyncedAt: now },
        });
        await db.recruitingCrmLead.create({
          data: { ...mirror, crmLeadId: id, mirrorSyncedAt: now },
        });
        await db.recruitingCrmSyncProgress.create({
          data: { ...owner, targetKey: id, token: id, progress: {} },
        });
        await db.recruitingCrmWorkspaceAttachment.create({
          data: {
            roleId: id,
            ...owner,
            mcpServerId: id,
            serverRevision: 1,
            organizationId: "synthetic-external-organization",
            crmRoleId: id,
            sourceMaterial: "synthetic",
            target: {},
            observedAt: now,
          },
        });
        await db.recruitingReminder.create({
          data: { id, spaceId, ownerUserId: id, roleId: id, title: "Synthetic", dueAt: now },
        });
        await db.recruitingCandidateNote.create({
          data: {
            id,
            spaceId,
            ownerUserId: id,
            roleId: id,
            candidateKey: "synthetic",
            body: "Synthetic",
          },
        });
        await db.recruitingSavedProfile.create({
          data: {
            id,
            spaceId,
            ownerUserId: id,
            personKey: "synthetic",
            provider: "synthetic",
            sourceEffectId: `${id}-read`,
            profile: {},
            fetchedAt: now,
          },
        });
      });
    }
  });
  afterAll(async () => {
    await restricted?.prisma.$disconnect();
    await restricted?.pool.end();
    if (admin) {
      for (const actor of actors) {
        await admin.prisma.organization.deleteMany({ where: { id: actor.spaceId } });
        await admin.prisma.user.deleteMany({ where: { id: actor.userId } });
      }
      await admin.prisma.$disconnect();
      await admin.pool.end();
    }
    if (sql) {
      await sql.query(`DROP OWNED BY ${role}`);
      await sql.query(`DROP ROLE ${role}`);
      await sql.end();
    }
  });
  it("rejects privileged role configuration and actor-less access", async () => {
    const unsafe = createActorDb(url!, { poolMax: 1 });
    try {
      await expect(unsafe.prisma.$connect()).rejects.toThrow("must not own");
    } finally {
      await unsafe.prisma.$disconnect();
      await unsafe.pool.end();
    }
    await expect(restricted.prisma.artifact.findMany()).rejects.toThrow("requires an actor");
  });
  it("returns zero foreign rows when every application owner filter is omitted", async () => {
    for (let index = 0; index < 2; index++) {
      const own = actors[index]!.userId;
      const result = await run(index, async () =>
        Promise.all([
          restricted.prisma.artifact.findMany({ select: { id: true } }),
          restricted.prisma.message.findMany({ select: { id: true } }),
          restricted.prisma.recruitingRole.findMany({ select: { id: true } }),
          restricted.prisma.recruitingRoleRevision.findMany({ select: { id: true } }),
          restricted.prisma.recruitingCalibrationRound.findMany({ select: { id: true } }),
        ]),
      );
      for (const rows of result) expect(rows).toEqual([{ id: own }]);
    }
  });
  it("protects candidate selections and rejects foreign parent links", async () => {
    const own = actors[0]!.userId;
    const foreign = actors[1]!.userId;
    expect(
      await run(0, () =>
        restricted.prisma.recruitingCandidate.findMany({ select: { roleId: true } }),
      ),
    ).toEqual([{ roleId: own }]);
    await expect(
      run(0, () =>
        restricted.prisma.recruitingRoleRevision.create({
          data: {
            id: `foreign-revision-${suffix}`,
            roleId: foreign,
            revision: 2,
            criteria: [],
            preferences: [],
            sourceRefs: [],
            definitionQuestions: [],
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      run(0, () =>
        restricted.prisma.recruitingCandidate.updateMany({
          where: { roleId: own },
          data: { shortlistMessageId: foreign },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      run(0, () =>
        restricted.prisma.recruitingCalibrationRound.updateMany({
          where: { roleId: own },
          data: { approvedByUserId: foreign },
        }),
      ),
    ).rejects.toThrow();
    expect(
      await run(0, () =>
        restricted.prisma.recruitingCandidate.deleteMany({ where: { roleId: foreign } }),
      ),
    ).toEqual({ count: 0 });
    // Own writes remain usable with the role/revision cycle's deferred foreign key.
    await run(0, () =>
      restricted.prisma.$transaction(async (tx) => {
        await tx.recruitingRoleRevision.create({
          data: {
            id: `own-revision-${suffix}`,
            roleId: own,
            revision: 2,
            criteria: [],
            preferences: [],
            sourceRefs: [],
            definitionQuestions: [],
          },
        });
        await tx.recruitingRole.update({
          where: { id: own },
          data: { currentRevisionId: `own-revision-${suffix}`, revision: 2 },
        });
        await tx.recruitingCandidate.updateMany({
          where: { roleId: own },
          data: { shortlistMessageId: own },
        });
      }),
    );
  });
  it("requires both owner and active Space even when the actor belongs to both Spaces", async () => {
    const id = `cross-membership-${suffix}`;
    await admin.prisma.member.create({
      data: {
        id,
        userId: actors[0]!.userId,
        organizationId: actors[1]!.spaceId,
        role: "member",
        createdAt: new Date(),
      },
    });
    try {
      expect(
        await admin.prisma.spaceMember.count({
          where: { userId: actors[0]!.userId, spaceId: actors[1]!.spaceId },
        }),
      ).toBe(1);
      for (const table of actorRlsTables.filter((name) => !actorPreferenceRlsTables.some((preference) => preference === name))) {
        const result = await withDatabaseActor(
          { userId: actors[0]!.userId, spaceId: actors[1]!.spaceId },
          async () => ({
            output: await restricted.prisma.$queryRawUnsafe(`SELECT * FROM "${table}"`),
          }),
        );
        expect(result.output, table).toEqual([]);
      }
    } finally {
      await admin.prisma.member.delete({ where: { id } });
    }
  });
  it("revokes all first-batch access when organization membership is removed", async () => {
    const membership = await admin.prisma.member.findUniqueOrThrow({
      where: { id: actors[0]!.userId },
    });
    await admin.prisma.member.delete({ where: { id: membership.id } });
    try {
      expect(await admin.prisma.spaceMember.count({ where: { userId: membership.userId } })).toBe(
        0,
      );
      for (const table of actorRlsTables.filter((name) => !actorPreferenceRlsTables.some((preference) => preference === name))) {
        expect(
          await run(0, () => restricted.prisma.$queryRawUnsafe(`SELECT * FROM "${table}"`)),
          table,
        ).toEqual([]);
      }
    } finally {
      await admin.prisma.member.create({ data: membership });
    }
  });
  it("covers every first-batch table with nonempty own reads, zero foreign rows and allowed own writes", async () => {
    for (const table of actorRlsTables.filter((name) => !actorPreferenceRlsTables.some((preference) => preference === name))) {
      for (const index of [0, 1]) {
        const rows = await run(index, () =>
          restricted.prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${table}"`),
        );
        expect(rows.length, table).toBeGreaterThan(0);
        for (const row of rows) {
          const ownerKey = row.userId ?? row.ownerUserId ?? row.roleId ?? row.id ?? row.effectId;
          expect(String(ownerKey), table).toContain(actors[index]!.userId);
        }
        // Exercise each WITH CHECK predicate without mutating the fixture values.
        if (table === "recruiting_role_revisions" || table === "recruiting_assessments") continue;
        const column = Object.keys(rows[0]!)[0]!;
        const updated = await run(index, () =>
          restricted.prisma.$executeRawUnsafe(`UPDATE "${table}" SET "${column}"="${column}"`),
        );
        expect(updated, table).toBe(rows.length);
      }
    }
  });
  it("rejects cross-account receipt and CRM parent relinking", async () => {
    const own = actors[0]!.userId;
    const foreign = actors[1]!.userId;
    const mutations: Array<() => Promise<unknown>> = [
      () => restricted.prisma.task.update({ where: { id: own }, data: { threadId: foreign } }),
      () => restricted.prisma.run.update({ where: { id: own }, data: { taskId: foreign } }),
      () =>
        restricted.prisma.recruitingRole.update({
          where: { id: own },
          data: { sourceThreadId: foreign },
        }),
      () =>
        restricted.prisma.externalEffect.update({
          where: { id: `${own}-read` },
          data: { runId: foreign },
        }),
      () => restricted.prisma.event.update({ where: { id: own }, data: { threadId: foreign } }),
      () =>
        restricted.prisma.recruitingResearchTask.update({
          where: { id: own },
          data: { createdByRunId: foreign },
        }),
      () =>
        restricted.prisma.recruitingResearchAction.update({
          where: { id: own },
          data: { contextArtifactId: foreign },
        }),
      () =>
        restricted.prisma.recruitingCandidatePage.update({
          where: { effectId: `${own}-page` },
          data: { artifactId: foreign },
        }),
      () =>
        restricted.prisma.recruitingCandidateOccurrence.updateMany({
          where: { roleId: own },
          data: { pageId: `${foreign}-page` },
        }),
      () =>
        restricted.prisma.recruitingCrmImport.update({
          where: { effectId: `${own}-import` },
          data: { bindingEffectId: `${foreign}-binding` },
        }),
      () =>
        restricted.prisma.recruitingReply.update({
          where: { effectId: `${own}-reply` },
          data: { crmImportEffectId: `${foreign}-import` },
        }),
      () =>
        restricted.prisma.recruitingCrmRoleContact.updateMany({
          where: { roleId: own },
          data: { contactId: foreign },
        }),
      () =>
        restricted.prisma.recruitingSavedProfile.update({
          where: { id: own },
          data: { sourceEffectId: `${foreign}-read` },
        }),
      () =>
        restricted.prisma.recruitingCandidateNote.update({
          where: { id: own },
          data: { roleId: foreign },
        }),
      () =>
        restricted.prisma.recruitingCrmRole.update({
          where: { id: own },
          data: { mcpServerId: foreign },
        }),
    ];
    for (const mutation of mutations)
      await expect(run(0, mutation)).rejects.toThrow(/row-level security/);
  });
  it("preserves native batch and callback transactions without identity leakage", async () => {
    await run(0, async () => {
      const rows = await restricted.prisma.$transaction([
        restricted.prisma.artifact.findMany({ select: { id: true } }),
        restricted.prisma.message.findMany({ select: { id: true } }),
      ]);
      expect(rows.map((r) => r[0]?.id)).toEqual([actors[0]!.userId, actors[0]!.userId]);
      await expect(
        restricted.prisma.$transaction(async (tx) => {
          await tx.artifact.update({
            where: { id: actors[0]!.userId },
            data: { name: "rollback" },
          });
          throw new Error("test rollback");
        }),
      ).rejects.toThrow("test rollback");
    });
    expect(
      (await admin.prisma.artifact.findUniqueOrThrow({ where: { id: actors[0]!.userId } })).name,
    ).toBe("Synthetic");
    const state = await restricted.pool.query(
      "SELECT nullif(current_setting('app.user_id', true), '') AS actor",
    );
    expect(state.rows[0].actor).toBeNull();
    expect(
      (await run(1, () => restricted.prisma.artifact.findMany({ select: { id: true } })))[0]?.id,
    ).toBe(actors[1]!.userId);
  });
  it("blocks foreign writes and missing membership", async () => {
    const result = await run(0, () =>
      restricted.prisma.artifact.updateMany({
        where: { id: actors[1]!.userId },
        data: { name: "forbidden" },
      }),
    );
    expect(result.count).toBe(0);
    await expect(
      run(0, () =>
        restricted.prisma.artifact.create({
          data: {
            id: `foreign-${suffix}`,
            userId: actors[1]!.userId,
            spaceId: actors[1]!.spaceId,
            name: "forbidden",
            mimeType: "text/plain",
            size: 0,
            hash: "",
            storageKey: "",
          },
        }),
      ),
    ).rejects.toThrow();
    const membership = await admin.prisma.spaceMember.findFirstOrThrow({
      where: { userId: actors[0]!.userId, spaceId: actors[0]!.spaceId },
    });
    await admin.prisma.spaceMember.delete({ where: { id: membership.id } });
    try {
      expect(await run(0, () => restricted.prisma.artifact.findMany())).toEqual([]);
    } finally {
      await admin.prisma.spaceMember.create({ data: membership });
    }
    const otherSpace = { ...actors[0]!, spaceId: actors[1]!.spaceId };
    expect(
      (
        await withDatabaseActor(otherSpace, async () => ({
          output: await restricted.prisma.artifact.findMany(),
        }))
      ).output,
    ).toEqual([]);
  });
  it("enqueues bound SET before business SQL on the public checked-out client", async () => {
    const client = await restricted.pool.connect();
    const query = vi.spyOn(client, "query");
    client.release();
    try {
      const rows = await run(
        0,
        () => restricted.prisma.$queryRaw<Array<{ probe: string; actor: string }>>`
        SELECT ${"pipelined-probe"}::text AS probe, current_setting('app.user_id') AS actor
      `,
      );
      expect(rows).toEqual([{ probe: "pipelined-probe", actor: actors[0]!.userId }]);
      const commands = query.mock.calls.map(([config]) => {
        if (typeof config === "string") return { text: config, values: undefined };
        if (config && typeof config === "object" && "text" in config) return config;
        throw new Error("Expected a public pg query config");
      });
      expect(commands).toHaveLength(4);
      expect(commands[0]!.text).toBe("BEGIN");
      expect(commands[1]!.text).toContain("SELECT set_config('app.user_id', $1, true)");
      expect(commands[1]!.values).toEqual([actors[0]!.userId, actors[0]!.spaceId]);
      expect(commands[2]!.text).toContain("SELECT $1::text AS probe");
      expect(commands[2]!.values).toEqual(["pipelined-probe"]);
      expect(commands[3]!.text).toBe("COMMIT");
    } finally {
      query.mockRestore();
    }
  });
  it("rolls back a successful SQL write when result decoding fails before COMMIT", async () => {
    const original = await admin.prisma.artifact.findUniqueOrThrow({
      where: { id: actors[0]!.userId },
    });
    await expect(
      run(
        0,
        () => restricted.prisma.$queryRaw`
      UPDATE artifacts SET name=${"decode-must-rollback"} WHERE id=${original.id}
      RETURNING point(1, 2) AS unsupported_result
    `,
      ),
    ).rejects.toThrow();
    expect(
      (await admin.prisma.artifact.findUniqueOrThrow({ where: { id: original.id } })).name,
    ).toBe(original.name);
  });
  it("drains a failed pipelined identity bind before reusing the connection", async () => {
    const original = await admin.prisma.artifact.findUniqueOrThrow({
      where: { id: actors[0]!.userId },
    });
    await expect(
      withDatabaseActor({ ...actors[0]!, userId: "invalid\0actor" }, async () => ({
        output: await restricted.prisma.artifact.updateMany({ data: { name: "must-not-commit" } }),
      })),
    ).rejects.toThrow();
    expect(
      (await admin.prisma.artifact.findUniqueOrThrow({ where: { id: original.id } })).name,
    ).toBe(original.name);
    expect(
      await run(1, () => restricted.prisma.artifact.findMany({ select: { id: true } })),
    ).toEqual([{ id: actors[1]!.userId }]);
    const cleared = await restricted.pool.query(
      "SELECT nullif(current_setting('app.user_id', true), '') AS actor",
    );
    expect(cleared.rows[0].actor).toBeNull();
  });
  it("keeps bound parameters ordered on one pipelined backend across actors", async () => {
    const client = await restricted.pool.connect();
    expect(client.pipeline).toBe(true);
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    client.release();
    for (let round = 0; round < 4; round++) {
      const results = await Promise.all(
        actors.map((actor, index) =>
          run(
            index,
            () =>
              restricted.prisma.$queryRaw<
                Array<{ actor: string; space: string; supplied: string; pid: number }>
              >`
          SELECT current_setting('app.user_id') AS actor, current_setting('app.space_id') AS space,
                 ${`quoted-'value-${round}-${index}`}::text AS supplied, pg_backend_pid() AS pid
        `,
          ),
        ),
      );
      for (const [index, rows] of results.entries())
        expect(rows).toEqual([
          {
            actor: actors[index]!.userId,
            space: actors[index]!.spaceId,
            supplied: `quoted-'value-${round}-${index}`,
            pid,
          },
        ]);
    }
  });
  for (const stop of ["cancel", "terminate"] as const) {
    it(`drains pipelined work after backend ${stop} before another actor checks out`, async () => {
      const connection = await restricted.pool.connect();
      const pid = (await connection.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      connection.release();
      // Attach rejection handling immediately, so no rejected queued query can be unhandled.
      const original = await admin.prisma.artifact.findUniqueOrThrow({
        where: { id: actors[0]!.userId },
      });
      const pending = run(
        0,
        () => restricted.prisma.$queryRaw`
        UPDATE artifacts SET name=${"cancel-must-rollback"} WHERE id=${original.id}
        RETURNING pg_sleep(10)
      `,
      ).then(
        () => ({ rejected: false }),
        () => ({ rejected: true }),
      );
      let active = false;
      for (let poll = 0; poll < 100; poll++) {
        const state = await sql.query(
          "SELECT state='active' AND query LIKE '%pg_sleep%' AS active FROM pg_stat_activity WHERE pid=$1",
          [pid],
        );
        if (state.rows[0]?.active) {
          active = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The backend id comes only from this suite's own dedicated one-client pool.
      await sql.query(
        stop === "cancel" ? "SELECT pg_cancel_backend($1)" : "SELECT pg_terminate_backend($1)",
        [pid],
      );
      expect((await pending).rejected).toBe(true);
      expect(active).toBe(true);
      expect(
        (await admin.prisma.artifact.findUniqueOrThrow({ where: { id: original.id } })).name,
      ).toBe(original.name);
      expect(
        await run(1, () => restricted.prisma.artifact.findMany({ select: { id: true } })),
      ).toEqual([{ id: actors[1]!.userId }]);
      const cleared = await restricted.pool.query(
        "SELECT nullif(current_setting('app.user_id', true), '') AS actor",
      );
      expect(cleared.rows[0].actor).toBeNull();
    });
  }
  it("rejects a membership function changed to SECURITY DEFINER or IMMUTABLE", async () => {
    const target = new URL(url!);
    target.username = role;
    target.password = "";
    for (const unsafeAttribute of ["SECURITY DEFINER", "IMMUTABLE"]) {
      await sql.query(`ALTER FUNCTION public.rakazo_actor_member() ${unsafeAttribute}`);
      const unsafe = createActorDb(target.href, { poolMax: 1 });
      try {
        await expect(unsafe.prisma.$connect()).rejects.toThrow("first-batch RLS policies");
      } finally {
        await unsafe.prisma.$disconnect();
        await unsafe.pool.end();
        await sql.query("ALTER FUNCTION public.rakazo_actor_member() SECURITY INVOKER STABLE");
      }
    }
  });
  it("rejects an additional permissive policy at startup", async () => {
    await sql.query("CREATE POLICY unwanted_allow ON artifacts USING (true)");
    const target = new URL(url!);
    target.username = role;
    target.password = "";
    const unsafe = createActorDb(target.href);
    try {
      await expect(unsafe.prisma.$connect()).rejects.toThrow("first-batch RLS policies");
    } finally {
      await unsafe.prisma.$disconnect();
      await unsafe.pool.end();
      await sql.query("DROP POLICY unwanted_allow ON artifacts");
    }
  });
  it("keeps parallel actors and deferred stream pulls isolated on one pooled connection", async () => {
    async function* stream() {
      yield await restricted.prisma.artifact.findMany({ select: { id: true } });
      yield await restricted.prisma.message.findMany({ select: { id: true } });
    }
    const streams = await Promise.all(
      actors.map((actor) => withDatabaseActor(actor, async () => ({ output: stream() }))),
    );
    for (let pull = 0; pull < 2; pull++) {
      const result = await Promise.all(streams.map(({ output }) => output.next()));
      expect(result[0]!.value).toEqual([{ id: actors[0]!.userId }]);
      expect(result[1]!.value).toEqual([{ id: actors[1]!.userId }]);
    }
    expect(restricted.pool.totalCount).toBe(1);
    expect(restricted.pool.idleCount).toBe(1);
    await Promise.all(streams.map(({ output }) => output.return(undefined)));
  });
  it.each(actorPreferenceRlsTables)(
    "isolates nonempty %s preferences and preserves system access",
    async (table) => {
      const insert = async (
        db: typeof admin.prisma,
        userId: string,
        spaceId: string,
      ) => {
        if (table === "ai_data_consents")
          return db.aiDataConsent.create({
            data: { userId, spaceId, recipientKey: "synthetic", version: "1" },
          });
        if (table === "space_backup_models")
          return db.spaceBackupModel.create({
            data: {
              userId,
              spaceId,
              provider: "synthetic",
              modelId: "synthetic",
              position: 0,
            },
          });
        if (table === "action_auto_review_preferences")
          return db.actionAutoReviewPreference.create({
            data: { userId, spaceId },
          });
        return db.notificationPreference.create({ data: { userId, spaceId } });
      };
      const read = () =>
        restricted.prisma.$queryRawUnsafe<
          Array<{ userId: string; spaceId: string }>
        >(`SELECT * FROM "${table}"`);
      // Seed both owners before any isolated read: foreign data must really exist.
      for (const actor of actors) await insert(admin.prisma, actor.userId, actor.spaceId);
      for (const [index, actor] of actors.entries()) {
        const rows = await run(index, read);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject(actor);
        expect(
          await run(index, () =>
            restricted.prisma.$executeRawUnsafe(
              `UPDATE "${table}" SET "userId"="userId"`,
            ),
          ),
        ).toBe(1);
        expect(
          await run(index, () =>
            restricted.prisma.$executeRawUnsafe(
              `DELETE FROM "${table}" WHERE "userId"=$1`,
              actors[1 - index]!.userId,
            ),
          ),
        ).toBe(0);
        await expect(
          run(index, () =>
            insert(restricted.prisma, actors[1 - index]!.userId, actor.spaceId),
          ),
        ).rejects.toThrow(/row-level security/);
        await expect(
          run(index, () =>
            restricted.prisma.$executeRawUnsafe(
              `UPDATE "${table}" SET "userId"=$1`,
              actors[1 - index]!.userId,
            ),
          ),
        ).rejects.toThrow(/row-level security/);
      }
      const crossId = `preference-cross-${table}-${suffix}`;
      await admin.prisma.member.create({
        data: {
          id: crossId,
          userId: actors[0]!.userId,
          organizationId: actors[1]!.spaceId,
          role: "member",
          createdAt: new Date(),
        },
      });
      try {
        await insert(admin.prisma, actors[0]!.userId, actors[1]!.spaceId);
        expect(await run(0, read)).toHaveLength(1);
        const cross = await withDatabaseActor(
          { userId: actors[0]!.userId, spaceId: actors[1]!.spaceId },
          async () => ({ output: await read() }),
        );
        expect(cross.output).toHaveLength(1);
        expect(cross.output[0]).toMatchObject({
          userId: actors[0]!.userId,
          spaceId: actors[1]!.spaceId,
        });
      } finally {
        await admin.prisma.member.delete({ where: { id: crossId } });
      }
      const membership = await admin.prisma.member.findUniqueOrThrow({
        where: { id: actors[0]!.userId },
      });
      await admin.prisma.member.delete({ where: { id: membership.id } });
      try {
        expect(await run(0, read)).toEqual([]);
        expect(await run(0, () => restricted.prisma.$executeRawUnsafe(`UPDATE "${table}" SET "userId"="userId"`))).toBe(0);
        expect(await run(0, () => restricted.prisma.$executeRawUnsafe(`DELETE FROM "${table}"`))).toBe(0);
        await expect(
          run(0, () =>
            insert(restricted.prisma, actors[0]!.userId, actors[0]!.spaceId),
          ),
        ).rejects.toThrow(/row-level security/);
        // These two lack a composite membership FK: rows remain, but RLS revokes access.
        if (
          table === "notification_preferences" ||
          table === "action_auto_review_preferences"
        ) {
          const rows = await admin.prisma.$queryRawUnsafe<unknown[]>(
            `SELECT * FROM "${table}" WHERE "userId"=$1`,
            actors[0]!.userId,
          );
          expect(rows.length).toBeGreaterThan(0);
        }
      } finally {
        await admin.prisma.member.create({ data: membership });
      }
      // Legal actor insertion after system-created default deletion still succeeds.
      await admin.prisma.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "userId"=$1 AND "spaceId"=$2`,
        actors[0]!.userId,
        actors[0]!.spaceId,
      );
      await run(0, () =>
        insert(restricted.prisma, actors[0]!.userId, actors[0]!.spaceId),
      );
      expect(await run(0, read)).toHaveLength(1);
    },
  );
});
