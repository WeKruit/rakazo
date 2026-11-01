import type { Actor } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { queryRecruitingSearchTargets } from "./search.js";

const url = process.env.RECRUITING_SEARCH_TEST_DATABASE_URL;
const local = url && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(url).hostname);
const suite = local ? describe : describe.skip;
suite("saved recruiting search SQL on isolated PostgreSQL", () => {
  it("finds full stored roles and native/mirror campaigns while fencing owner, space and source changes", async () => {
    const db = createDb(url!, { poolMax: 1 });
    const actor: Actor = { userId: "search-owner", spaceId: "search-space" };
    try {
      await db.prisma.$transaction(async (tx) => {
        // Transaction-local tables shadow the real tables; no stored product record is touched.
        for (const statement of [
          'CREATE TEMP TABLE recruiting_roles (id text, title text, "sourceThreadId" text, "userId" text, "spaceId" text, "archivedAt" timestamp) ON COMMIT DROP',
          'CREATE TEMP TABLE threads (id text, "groupId" text, "botId" text, "activeRecruitingRoleId" text, "userId" text, "spaceId" text) ON COMMIT DROP',
          'CREATE TEMP TABLE chat_groups (id text, "userId" text, "spaceId" text, "archivedAt" timestamp) ON COMMIT DROP',
          'CREATE TEMP TABLE bots (id text, "userId" text, "spaceId" text, "archivedAt" timestamp) ON COMMIT DROP',
          'CREATE TEMP TABLE runs (id text, "userId" text, "spaceId" text) ON COMMIT DROP',
          'CREATE TEMP TABLE mcp_servers (id text, "userId" text, "spaceId" text, revision int, enabled boolean) ON COMMIT DROP',
          'CREATE TEMP TABLE external_effects ("runId" text, "spaceId" text, request jsonb, result jsonb, kind text, status text, "updatedAt" timestamp) ON COMMIT DROP',
          'CREATE TEMP TABLE recruiting_crm_workspace_attachments ("roleId" text, "userId" text, "spaceId" text, "mcpServerId" text, "serverRevision" int, "organizationId" text, "crmRoleId" text) ON COMMIT DROP',
          'CREATE TEMP TABLE recruiting_crm_campaigns ("crmCampaignId" text, name text, "userId" text, "spaceId" text, "mcpServerId" text, "organizationId" text, "crmRoleId" text, "archivedAt" timestamp) ON COMMIT DROP',
        ])
          await tx.$executeRawUnsafe(statement);
        await tx.$executeRaw`INSERT INTO recruiting_roles VALUES
          ('role-1','Shared role','thread-1','search-owner','search-space',NULL),
          ('role-other','Shared foreign','thread-other','other-owner','search-space',NULL)`;
        await tx.$executeRaw`INSERT INTO threads VALUES ('thread-1','group-1',NULL,'role-1','search-owner','search-space'), ('thread-other','group-other',NULL,'role-other','other-owner','search-space')`;
        await tx.$executeRaw`INSERT INTO chat_groups VALUES ('group-1','search-owner','search-space',NULL), ('group-other','other-owner','search-space',NULL)`;
        await tx.$executeRaw`INSERT INTO runs VALUES ('run-1','search-owner','search-space'),('run-other','other-owner','search-space')`;
        await tx.$executeRaw`INSERT INTO mcp_servers VALUES ('native','search-owner','search-space',1,true),('crm','search-owner','search-space',2,true)`;
        await tx.$executeRaw`INSERT INTO external_effects VALUES
          ('run-1','search-space','{"roleId":"role-1","serverId":"native"}','{"campaignId":"native-1","campaignName":"Shared native"}','instantly_role_campaign','completed','2026-01-01'),
          ('run-other','search-space','{"roleId":"role-1","serverId":"native"}','{"campaignId":"foreign","campaignName":"Shared leak"}','instantly_role_campaign','completed','2026-01-01'),
          ('run-1','search-space','{"roleId":"role-1","serverId":"native"}','{"campaignId":"renamed","campaignName":"Shared old name"}','instantly_role_campaign','completed','2026-01-01'),
          ('run-1','search-space','{"roleId":"role-1","serverId":"native"}','{"campaignId":"renamed","campaignName":"Renamed"}','instantly_role_campaign','completed','2026-01-02')`;
        await tx.$executeRaw`INSERT INTO recruiting_crm_workspace_attachments VALUES ('role-1','search-owner','search-space','crm',2,'org-1','crm-role-1')`;
        await tx.$executeRaw`INSERT INTO recruiting_crm_campaigns VALUES
          ('mirror-1','Shared mirror','search-owner','search-space','crm','org-1','crm-role-1',NULL),
          ('mirror-wrong-org','Shared wrong org','search-owner','search-space','crm','org-other','crm-role-1',NULL),
          ('mirror-other-owner','Shared other owner','other-owner','search-space','crm','org-1','crm-role-1',NULL)`;
        const results = await queryRecruitingSearchTargets(tx, actor, "Shared");
        expect(results.map((row) => row.title).sort()).toEqual([
          "Shared mirror",
          "Shared native",
          "Shared role",
        ]);
        expect(results.find((row) => row.title === "Shared mirror")?.serverId).toBeNull();
        expect(results.find((row) => row.title === "Shared native")?.serverId).toBe("native");
        await tx.$executeRaw`UPDATE mcp_servers SET revision=3 WHERE id='crm'`;
        expect(
          (await queryRecruitingSearchTargets(tx, actor, "Shared")).map((row) => row.title).sort(),
        ).toEqual(["Shared native", "Shared role"]);
        expect(await queryRecruitingSearchTargets(tx, actor, "Shared%")).toEqual([]);
        await tx.$executeRaw`UPDATE mcp_servers SET enabled=false WHERE id='native'`;
        expect(
          (await queryRecruitingSearchTargets(tx, actor, "Shared")).map((row) => row.title),
        ).toEqual(["Shared role"]);
        await tx.$executeRaw`UPDATE recruiting_roles SET "archivedAt"=now() WHERE id='role-1'`;
        expect(await queryRecruitingSearchTargets(tx, actor, "Shared")).toEqual([]);
      });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});
