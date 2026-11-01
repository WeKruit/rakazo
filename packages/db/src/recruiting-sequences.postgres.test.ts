import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "./client.js";
import {
  readSavedRecruitingSequences,
  rememberRecruitingSequenceObservation,
} from "./recruiting-sequences.js";

const url = process.env.SEQUENCE_TEST_DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname);
(local ? describe : describe.skip)("saved campaign pages on isolated PostgreSQL", () => {
  it("pages campaigns before returning, preserves saved observations, and fences exact owner/source/role", async () => {
    const db = createDb(url!, { poolMax: 1 });
    const actor: Actor = {
      userId: "owner",
      spaceId: "space",
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    try {
      await db.prisma.$transaction(
        async (tx) => {
          for (const sql of [
            'CREATE TEMP TABLE space_members("userId" text,"spaceId" text,"organizationId" text)',
            'CREATE TEMP TABLE spaces(id text,"organizationId" text)',
            'CREATE TEMP TABLE member("userId" text,"organizationId" text)',
            'CREATE TEMP TABLE bot_mcp_servers("botId" text,"serverId" text,"userId" text,"spaceId" text)',
            'CREATE TEMP TABLE recruiting_roles(id text,title text,"sourceThreadId" text,"playbookStage" text,"crmBindingEffectId" text,"currentRevisionId" text,"userId" text,"spaceId" text,"archivedAt" timestamp)',
            "CREATE TEMP TABLE recruiting_role_revisions(id text,brief jsonb)",
            'CREATE TEMP TABLE threads(id text,"groupId" text,"botId" text,"activeRecruitingRoleId" text,"userId" text,"spaceId" text)',
            'CREATE TEMP TABLE chat_groups(id text,"userId" text,"spaceId" text,"archivedAt" timestamp)',
            'CREATE TEMP TABLE bots(id text,"userId" text,"spaceId" text,"archivedAt" timestamp)',
            'CREATE TEMP TABLE runs(id text,"threadId" text,"botId" text,"userId" text,"spaceId" text)',
            'CREATE TEMP TABLE mcp_servers(id text,"userId" text,"spaceId" text,revision int,enabled boolean)',
            'CREATE TEMP TABLE external_effects(id text,"runId" text,"spaceId" text,kind text,status text,request jsonb,result jsonb,"updatedAt" timestamp)',
            'CREATE TEMP TABLE recruiting_crm_workspace_attachments("roleId" text,"userId" text,"spaceId" text,"mcpServerId" text,"serverRevision" int,"organizationId" text,"crmRoleId" text)',
            'CREATE TEMP TABLE recruiting_crm_campaigns("userId" text,"spaceId" text,"mcpServerId" text,"organizationId" text,"crmRoleId" text,"crmCampaignId" text,name text,status int,"campaignCreatedAt" timestamp,"archivedAt" timestamp)',
            'CREATE TEMP TABLE recruiting_crm_leads("userId" text,"spaceId" text,"mcpServerId" text,"organizationId" text,"crmCampaignId" text,"crmCandidateId" text,"lastContactAt" timestamp,status int,"interestStatus" int,"openCount" int,"replyCount" int,"archivedAt" timestamp)',
            'CREATE TEMP TABLE recruiting_crm_contacts("userId" text,"spaceId" text,"mcpServerId" text,"organizationId" text,"crmCandidateId" text,name text,email text,"archivedAt" timestamp)',
            'CREATE TEMP TABLE recruiting_candidates("roleId" text,"candidateKey" text)',
            'CREATE TEMP TABLE recruiting_candidate_occurrences("roleId" text,"candidateKey" text,name text)',
          ])
            await tx.$executeRawUnsafe(sql);
          await tx.$executeRaw`INSERT INTO space_members VALUES ('owner','space','organization')`;
          await tx.$executeRaw`INSERT INTO spaces VALUES ('space','organization')`;
          await tx.$executeRaw`INSERT INTO member VALUES ('owner','organization')`;
          await tx.$executeRaw`INSERT INTO bot_mcp_servers VALUES ('bot','native','owner','space')`;
          await tx.$executeRaw`INSERT INTO recruiting_role_revisions VALUES ('brief','{}')`;
          await tx.$executeRaw`INSERT INTO bots VALUES ('bot','owner','space',NULL)`;
          await tx.$executeRaw`INSERT INTO mcp_servers VALUES ('native','owner','space',2,true),('crm','owner','space',3,true),('foreign','other','space',2,true)`;
          await tx.$executeRaw`INSERT INTO recruiting_roles SELECT 'role-'||n,'Role '||lpad(n::text,3,'0'),'thread-'||n,'outreach',NULL,'brief','owner','space',NULL FROM generate_series(1,60) n`;
          await tx.$executeRaw`INSERT INTO threads SELECT 'thread-'||n,NULL,'bot','role-'||n,'owner','space' FROM generate_series(1,60) n`;
          await tx.$executeRaw`INSERT INTO runs SELECT 'run-'||n,'thread-'||n,'bot','owner','space' FROM generate_series(1,60) n`;
          await tx.$executeRaw`INSERT INTO runs VALUES ('foreign-run','thread-1','bot','other','space'),('wrong-role-run','thread-2','bot','owner','space')`;
          await tx.$executeRaw`INSERT INTO external_effects SELECT 'binding-'||n,'run-'||n,'space','instantly_role_campaign','completed',jsonb_build_object('roleId','role-'||n,'serverId','native'),jsonb_build_object('campaignId','campaign-'||n,'campaignName','Sequence '||lpad(n::text,3,'0'),'leads',jsonb_build_object('person',jsonb_build_object('leadId','lead-'||n,'email','person'||n||'@example.test'))),'2026-01-01'::timestamp FROM generate_series(1,60) n`;
          await tx.$executeRaw`INSERT INTO external_effects VALUES
          ('old-name','run-1','space','instantly_role_campaign','completed','{"roleId":"role-1","serverId":"native"}','{"campaignId":"campaign-1","campaignName":"Old name"}','2025-01-01'),
          ('foreign-binding','foreign-run','space','instantly_role_campaign','completed','{"roleId":"role-1","serverId":"native"}','{"campaignId":"foreign-campaign","campaignName":"Leak"}','2026-02-01'),
          ('wrong-role-binding','wrong-role-run','space','instantly_role_campaign','completed','{"roleId":"role-1","serverId":"native"}','{"campaignId":"wrong-role","campaignName":"Leak"}','2026-02-01'),
          ('foreign-server','run-1','space','instantly_role_campaign','completed','{"roleId":"role-1","serverId":"foreign"}','{"campaignId":"foreign-source","campaignName":"Leak"}','2026-02-01'),
          ('campaign-read','run-1','space','native_instantly_get_campaign','completed','["__rakazoCatalogTool","direct",{"route":{"connectorId":"mcp","resourceId":"native","resourceRevision":2,"toolName":"native_instantly_get_campaign"},"args":{"campaign_id":"campaign-1"}}]','{"structuredContent":{"result":{"id":"campaign-1","status":1}}}','2026-02-01'),
          ('analytics-old','run-1','space','native_instantly_get_campaign_analytics','completed','["__rakazoCatalogTool","direct",{"route":{"connectorId":"mcp","resourceId":"native","resourceRevision":2,"toolName":"native_instantly_get_campaign_analytics"},"args":{"campaign_id":"campaign-1"}}]','{"structuredContent":{"result":{"emails_sent_count":100,"open_count_unique":99,"reply_count_unique":98}}}','2026-01-01'),
          ('analytics','run-1','space','native_instantly_get_campaign_analytics','completed','["__rakazoCatalogTool","direct",{"route":{"connectorId":"mcp","resourceId":"native","resourceRevision":2,"toolName":"native_instantly_get_campaign_analytics"},"args":{"campaign_id":"campaign-1"}}]','{"structuredContent":{"result":{"emails_sent_count":4,"open_count_unique":3,"reply_count_unique":1}}}','2026-02-01'),
          ('analytics-foreign','foreign-run','space','native_instantly_get_campaign_analytics','completed','["__rakazoCatalogTool","direct",{"route":{"connectorId":"mcp","resourceId":"native","resourceRevision":2,"toolName":"native_instantly_get_campaign_analytics"},"args":{"campaign_id":"campaign-1"}}]','{"emails_sent_count":999}','2026-03-01'),
          ('analytics-stale-source','run-1','space','native_instantly_get_campaign_analytics','completed','["__rakazoCatalogTool","direct",{"route":{"connectorId":"mcp","resourceId":"native","resourceRevision":1,"toolName":"native_instantly_get_campaign_analytics"},"args":{"campaign_id":"campaign-1"}}]','{"emails_sent_count":999}','2026-03-01')`;
          await tx.$executeRaw`INSERT INTO recruiting_crm_workspace_attachments VALUES ('role-1','owner','space','crm',3,'org','crm-role')`;
          await tx.$executeRaw`INSERT INTO recruiting_crm_campaigns VALUES
          ('owner','space','crm','org','crm-role','crm-campaign','CRM sequence',2,'2025-01-01',NULL),
          ('owner','space','crm','other-org','crm-role','wrong-org','Leak',1,NULL,NULL),
          ('other','space','crm','org','crm-role','wrong-owner','Leak',1,NULL,NULL)`;
          await tx.$executeRaw`INSERT INTO recruiting_crm_leads VALUES ('owner','space','crm','org','crm-campaign','crm-person','2026-01-01',1,1,2,1,NULL)`;
          await tx.$executeRaw`INSERT INTO recruiting_crm_contacts VALUES ('owner','space','crm','org','crm-person','Stored Person','stored@example.test',NULL)`;
          await tx.$executeRaw`INSERT INTO external_effects VALUES
          ('saved-draft','run-2','space','native_instantly_get_role_draft','completed','["__rakazoCatalogTool","direct",{"route":{"connectorId":"mcp","resourceId":"native","resourceRevision":2,"toolName":"native_instantly_get_role_draft"},"args":{"role_id":"role-2"}}]','{"structuredContent":{"result":{"roleId":"role-2","campaign":{"id":"campaign-2","name":"Sequence 002","status":2}}}}','2026-02-01')`;
          await tx.$executeRaw`ALTER TABLE recruiting_crm_campaigns ADD COLUMN "syncedAt" timestamp DEFAULT '2026-01-01'`;
          await tx.$executeRaw`ALTER TABLE recruiting_crm_leads ADD COLUMN "syncedAt" timestamp DEFAULT '2026-01-01'`;
          const input = {
            view: "sequence" as const,
            sequenceSummary: true,
            briefedOnly: true,
            limit: 25,
          };
          const first = await readSavedRecruitingSequences(tx, actor, input);
          expect(first.total).toBe(61);
          expect(first.items).toHaveLength(25);
          expect(first.nextCursor).toBe("25");
          expect(first.sequenceSummary).toMatchObject({
            sent: 4,
            opened: 4,
            replied: 2,
            partial: true,
          });
          expect(
            first.items
              .flatMap((item) => item.campaigns ?? [])
              .find((campaign) => campaign.campaign?.id === "campaign-1"),
          ).toMatchObject({
            campaign: { status: 1 },
            stats: { sent: 4, opened: 3, replied: 1 },
            observations: { total: 1, active: null },
          });
          const second = await readSavedRecruitingSequences(tx, actor, {
            ...input,
            cursor: first.nextCursor!,
          });
          const third = await readSavedRecruitingSequences(tx, actor, {
            ...input,
            cursor: second.nextCursor!,
          });
          expect([...first.items, ...second.items, ...third.items]).toHaveLength(61);
          expect(third.nextCursor).toBeNull();
          expect(
            await readSavedRecruitingSequences(tx, { ...actor, userId: "other" }, input),
          ).toMatchObject({ items: [], total: 0 });
          expect(
            await readSavedRecruitingSequences(tx, { ...actor, spaceId: "other" }, input),
          ).toMatchObject({ items: [], total: 0 });
          expect(
            await readSavedRecruitingSequences(tx, actor, { ...input, roleId: "role-2" }),
          ).toMatchObject({
            sequenceSummary: { sent: null, opened: null, replied: null, active: null },
            items: [{ campaigns: [{ campaign: { status: 2 } }] }],
          });
          const selected = await readSavedRecruitingSequences(tx, actor, {
            ...input,
            roleId: "role-1",
            sequenceStatus: 1,
          });
          expect(selected.total).toBe(1);
          expect(selected.items[0]?.campaigns?.[0]?.stats).toEqual({
            sent: 4,
            opened: 3,
            replied: 1,
          });
          expect(
            (
              await readSavedRecruitingSequences(tx, actor, {
                ...input,
                sequenceContactQuery: "STORED",
              })
            ).total,
          ).toBe(1);
          expect(
            (
              await readSavedRecruitingSequences(tx, actor, {
                ...input,
                sequenceContactQuery: "person60",
              })
            ).items[0]?.roleId,
          ).toBe("role-60");
          expect(
            (await readSavedRecruitingSequences(tx, actor, { ...input, sequenceQuery: "%" })).total,
          ).toBe(0);
          expect(
            (await readSavedRecruitingSequences(tx, actor, { ...input, sequenceSort: "opened" }))
              .items[0]?.campaigns?.[0]?.campaign?.id,
          ).toBe("campaign-1");
          await tx.$executeRaw`UPDATE external_effects SET result=jsonb_set(result,'{leads}','{}') WHERE id='binding-60'`;
          expect(
            (
              await readSavedRecruitingSequences(tx, actor, {
                ...input,
                sequenceContactQuery: "person60",
              })
            ).total,
          ).toBe(0);
          await tx.$executeRaw`INSERT INTO external_effects VALUES
          ('shared-binding','run-2','space','instantly_role_campaign','completed','{"roleId":"role-2","serverId":"native"}','{"campaignId":"campaign-1","campaignName":"Shared sequence"}','2026-03-01'),
          ('shared-older-stats','run-2','space','native_instantly_get_campaign_analytics','completed','["__rakazoCatalogTool","direct",{"route":{"connectorId":"mcp","resourceId":"native","resourceRevision":2,"toolName":"native_instantly_get_campaign_analytics"},"args":{"campaign_id":"campaign-1"}}]','{"emails_sent_count":100,"open_count_unique":99,"reply_count_unique":98}','2025-01-01')`;
          const shared = await readSavedRecruitingSequences(tx, actor, input);
          expect(shared.total).toBe(62);
          expect(shared.sequenceSummary).toMatchObject({ sent: 4, opened: 4, replied: 2 });
          await tx.$executeRaw`UPDATE external_effects SET result='{"emails_sent_count":3,"open_count_unique":2,"reply_count_unique":1}',"updatedAt"='2027-01-01' WHERE id='shared-older-stats'`;
          expect(
            (await readSavedRecruitingSequences(tx, actor, input)).sequenceSummary,
          ).toMatchObject({ sent: 3, opened: 3, replied: 2 });
          await tx.$executeRaw`UPDATE external_effects SET result='{"structuredContent":{"result":{"emails_sent_count":0,"open_count_unique":0,"reply_count_unique":0}}}',"updatedAt"='2026-04-01' WHERE id='analytics'`;
          expect(
            (
              await readSavedRecruitingSequences(tx, actor, {
                ...input,
                roleId: "role-1",
                sequenceStatus: 1,
              })
            ).items[0]?.campaigns?.[0]?.stats,
          ).toEqual({ sent: 0, opened: 0, replied: 0 });
          await tx.$executeRaw`INSERT INTO external_effects VALUES ('catalog-analytics','run-3','space','mcp_execute_tool','completed','["__rakazoCatalogTool","mcp_execute_tool",{"id":"native:native_instantly_get_campaign_analytics","arguments":{"campaign_id":"campaign-3"}},{"connectorId":"mcp","resourceId":"native","resourceRevision":2,"toolName":"native_instantly_get_campaign_analytics"}]','{"data":{"emails_sent_count":2,"open_count_unique":1,"reply_count_unique":0}}','2026-02-01')`;
          expect(
            (await readSavedRecruitingSequences(tx, actor, { ...input, roleId: "role-3" })).items[0]
              ?.campaigns?.[0]?.stats,
          ).toEqual({ sent: 2, opened: 1, replied: 0 });
          await tx.$executeRaw`UPDATE threads SET "activeRecruitingRoleId"='other' WHERE id='thread-1'`;
          expect((await readSavedRecruitingSequences(tx, actor, input)).total).toBe(60);
          await tx.$executeRaw`UPDATE threads SET "activeRecruitingRoleId"='role-1' WHERE id='thread-1'`;
          const observed = {
            botId: "bot",
            roleId: "role-1",
            threadId: "thread-1",
            serverId: "native",
            sourceRevision: 2,
            observedAt: "2030-01-01T00:00:00.000Z",
            campaign: {
              id: "campaign-1",
              name: "Verified current name",
              status: 1,
              eaccount: null,
              stopOnReply: true,
            },
            stats: { sent: 4, opened: 3, replied: 1 },
          };
          const pendingMarker = {
            roleId: observed.roleId,
            serverId: observed.serverId,
            campaignId: observed.campaign.id,
            sourceRevision: observed.sourceRevision,
            observedAt: "2031-01-01T00:00:00.000Z",
          };
          expect(
            await readSavedRecruitingSequences(tx, actor, {
              ...input,
              sequenceQuery: "Verified paused name",
              sequenceObservations: [pendingMarker],
            }),
          ).toMatchObject({ total: 0, items: [], sequencePendingObservations: [pendingMarker] });
          expect(await rememberRecruitingSequenceObservation(tx, actor, observed)).toBe(3);
          const paused = {
            ...observed,
            observedAt: "2031-01-01T00:00:00.000Z",
            campaign: { ...observed.campaign, name: "Verified paused name", status: 2 },
            stats: undefined,
          };
          expect(await rememberRecruitingSequenceObservation(tx, actor, paused)).toBe(3);
          expect(
            await rememberRecruitingSequenceObservation(tx, actor, {
              ...observed,
              observedAt: "2029-01-01T00:00:00.000Z",
            }),
          ).toBe(0);
          const saved = (
            await readSavedRecruitingSequences(tx, actor, {
              ...input,
              roleId: "role-1",
              sequenceStatus: 2,
            })
          ).items
            .flatMap((item) => item.campaigns ?? [])
            .find((campaign) => campaign.campaign?.id === "campaign-1");
          expect(
            (
              await readSavedRecruitingSequences(tx, actor, {
                ...input,
                sequenceQuery: "Verified paused name",
                sequenceObservations: [pendingMarker],
              })
            ).sequencePendingObservations,
          ).toEqual([]);
          expect(
            (
              await tx.$queryRaw<
                { name: string }[]
              >`SELECT result->>'campaignName' name FROM external_effects WHERE kind='instantly_role_campaign' AND result->>'campaignId'='campaign-1' AND "runId" IN ('run-1','run-2')`
            ).map((row) => row.name),
          ).toEqual(["Verified paused name", "Verified paused name", "Verified paused name"]);
          expect(saved).toMatchObject({
            campaign: { name: "Verified paused name", status: 2 },
            stats: { sent: 4, opened: 3, replied: 1 },
            sourceRevision: 2,
          });
          await tx.$executeRaw`DELETE FROM member WHERE "userId"='owner'`;
          expect(
            await rememberRecruitingSequenceObservation(tx, actor, {
              ...observed,
              observedAt: "2032-01-01T00:00:00.000Z",
            }),
          ).toBe(0);
          await tx.$executeRaw`INSERT INTO member VALUES ('owner','organization')`;
          await tx.$executeRaw`DELETE FROM bot_mcp_servers WHERE "serverId"='native'`;
          expect(
            await rememberRecruitingSequenceObservation(tx, actor, {
              ...observed,
              observedAt: "2032-01-01T00:00:00.000Z",
            }),
          ).toBe(0);
          await tx.$executeRaw`INSERT INTO bot_mcp_servers VALUES ('bot','native','owner','space')`;
          expect(
            await rememberRecruitingSequenceObservation(
              tx,
              { ...actor, userId: "foreign" },
              observed,
            ),
          ).toBe(0);
          await tx.$executeRaw`UPDATE mcp_servers SET revision=3 WHERE id='native'`;
          expect(
            await rememberRecruitingSequenceObservation(tx, actor, {
              ...observed,
              observedAt: "2032-01-01T00:00:00.000Z",
            }),
          ).toBe(0);
          await tx.$executeRaw`UPDATE mcp_servers SET revision=2 WHERE id='native'`;
          await tx.$executeRaw`INSERT INTO external_effects VALUES ('saved-native-write','run-1','space','instantly_sequence_draft','completed','{"input":{"role_id":"role-1"}}','{"campaignId":"campaign-1","__rakazoSequenceObservation":{"version":1,"serverId":"native","sourceRevision":2,"observedAt":"2033-01-01T00:00:00.000Z","campaign":{"id":"campaign-1","name":"Verified saved draft","status":0}}}','2033-01-01')`;
          expect(
            (
              await readSavedRecruitingSequences(tx, actor, {
                ...input,
                roleId: "role-1",
                sequenceStatus: 0,
              })
            ).items.flatMap((item) => item.campaigns ?? []),
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                campaign: expect.objectContaining({ name: "Verified saved draft", status: 0 }),
              }),
            ]),
          );
          await tx.$executeRaw`UPDATE mcp_servers SET enabled=false WHERE id='native'`;
          expect((await readSavedRecruitingSequences(tx, actor, input)).total).toBe(1);
          await tx.$executeRaw`UPDATE mcp_servers SET revision=4 WHERE id='crm'`;
          expect((await readSavedRecruitingSequences(tx, actor, input)).total).toBe(0);
        },
        { timeout: 20_000 },
      );
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  it("does not overwrite a newer source epoch after waiting for a concurrent cache writer", async () => {
    const monitor = createDb(url!, { poolMax: 1 });
    const newer = createDb(url!, { poolMax: 1 });
    const older = createDb(url!, { poolMax: 1 });
    const schema = `sequence_race_${randomUUID().replaceAll("-", "")}`;
    const actor: Actor = {
      userId: "owner",
      spaceId: "space",
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    const snapshot = {
      botId: "bot",
      roleId: "role",
      threadId: "thread",
      serverId: "server",
      sourceRevision: 2,
      observedAt: "2030-01-01T00:00:00.002Z",
      campaign: {
        id: "campaign",
        name: "Old source",
        status: 1,
        eaccount: null,
        stopOnReply: true,
      },
    };
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let newest: Promise<unknown> | undefined, stale: Promise<unknown> | undefined;
    try {
      await monitor.prisma.$executeRawUnsafe(`CREATE SCHEMA ${schema}`);
      await monitor.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${schema},public`);
        for (const ddl of [
          'CREATE TABLE external_effects(id text,"runId" text,"spaceId" text,kind text,status text,request jsonb,result jsonb,"updatedAt" timestamp)',
          'CREATE TABLE runs(id text,"userId" text,"spaceId" text,"threadId" text,"botId" text)',
          'CREATE TABLE recruiting_roles(id text,"userId" text,"spaceId" text,"sourceThreadId" text,"archivedAt" timestamp)',
          'CREATE TABLE threads(id text,"userId" text,"spaceId" text,"activeRecruitingRoleId" text,"groupId" text,"botId" text)',
          'CREATE TABLE mcp_servers(id text,"userId" text,"spaceId" text,revision int,enabled boolean)',
          'CREATE TABLE bot_mcp_servers("userId" text,"spaceId" text,"botId" text,"serverId" text)',
          'CREATE TABLE bots(id text,"userId" text,"spaceId" text,"archivedAt" timestamp)',
          'CREATE TABLE chat_groups(id text,"userId" text,"spaceId" text,"archivedAt" timestamp)',
          'CREATE TABLE space_members("userId" text,"spaceId" text,"organizationId" text)',
          'CREATE TABLE spaces(id text,"organizationId" text)',
          'CREATE TABLE member("userId" text,"organizationId" text)',
        ])
          await tx.$executeRawUnsafe(ddl);
        await tx.$executeRaw`INSERT INTO external_effects VALUES ('binding','run','space','instantly_role_campaign','completed','{"roleId":"role","serverId":"server"}','{"campaignId":"campaign"}',now())`;
        await tx.$executeRaw`INSERT INTO runs VALUES ('run','owner','space','thread','bot')`;
        await tx.$executeRaw`INSERT INTO recruiting_roles VALUES ('role','owner','space','thread',NULL)`;
        await tx.$executeRaw`INSERT INTO threads VALUES ('thread','owner','space','role',NULL,'bot')`;
        await tx.$executeRaw`INSERT INTO mcp_servers VALUES ('server','owner','space',2,true)`;
        await tx.$executeRaw`INSERT INTO bot_mcp_servers VALUES ('owner','space','bot','server')`;
        await tx.$executeRaw`INSERT INTO bots VALUES ('bot','owner','space',NULL)`;
        await tx.$executeRaw`INSERT INTO space_members VALUES ('owner','space','organization')`;
        await tx.$executeRaw`INSERT INTO spaces VALUES ('space','organization')`;
        await tx.$executeRaw`INSERT INTO member VALUES ('owner','organization')`;
      });
      newest = newer.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${schema},public`);
          await tx.$executeRaw`UPDATE mcp_servers SET revision=3 WHERE id='server'`;
          expect(
            await rememberRecruitingSequenceObservation(tx, actor, {
              ...snapshot,
              sourceRevision: 3,
              observedAt: "2030-01-01T00:00:00.001Z",
              campaign: { ...snapshot.campaign, name: "New source", status: 2 },
            }),
          ).toBe(1);
          locked();
          await gate;
        },
        { timeout: 10_000 },
      );
      await ready;
      let oldPid!: number;
      stale = older.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${schema},public`);
          oldPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() pid`)[0]!.pid;
          return rememberRecruitingSequenceObservation(tx, actor, snapshot);
        },
        { timeout: 10_000 },
      );
      await vi.waitFor(async () => {
        expect(oldPid).toBeDefined();
        expect(
          (
            await monitor.prisma.$queryRaw<
              { wait_event_type: string }[]
            >`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${oldPid}`
          )[0]?.wait_event_type,
        ).toBe("Lock");
      });
      release();
      await newest;
      expect(await stale).toBe(0);
      await monitor.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${schema},public`);
        expect(
          (
            await tx.$queryRaw<
              { result: unknown }[]
            >`SELECT result FROM external_effects WHERE id='binding'`
          )[0]?.result,
        ).toMatchObject({
          __rakazoSequenceObservation: {
            sourceRevision: 3,
            campaign: { name: "New source", status: 2 },
          },
        });
      });
    } finally {
      release?.();
      await Promise.allSettled([newest, stale].filter((value) => value !== undefined));
      await monitor.prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      for (const db of [monitor, newer, older]) {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  });
});
