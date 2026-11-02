import { randomUUID } from "node:crypto";
import type { AdapterContext, ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { getRecruitingCrmData } from "./recruiting-reads.js";

const url = process.env.SEQUENCE_TEST_DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname);
(local ? it : it.skip)(
  "joins a saved lead page to actual PostgreSQL contacts only in its owner/source/organization",
  async () => {
    const monitor = createDb(url!, { poolMax: 1 });
    const database = `sequence_people_${randomUUID().replaceAll("-", "")}`;
    await monitor.pool.query(`CREATE DATABASE ${database}`);
    const isolatedUrl = new URL(url!);
    isolatedUrl.pathname = `/${database}`;
    const db = createDb(isolatedUrl.toString(), { poolMax: 1 });
    const actor: Actor = {
      userId: "owner",
      spaceId: "space",
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    const org = "10000000-0000-4000-8000-000000000001";
    const id = "10000000-0000-4000-8000-000000000002";
    const missing = "10000000-0000-4000-8000-000000000003";
    const at = "2030-01-01T00:00:00.000Z";
    const target = { kind: "bot" as const, botId: "bot", threadId: "thread" };
    const server = {
      id: "crm",
      revision: 1,
      userId: "owner",
      spaceId: "space",
      enabled: true,
      endpoint: "https://crm.example.test/mcp",
      transport: "streamable_http",
      secretId: null,
      name: "CRM",
    };
    try {
      await db.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'CREATE TABLE recruiting_crm_contacts("userId" text,"spaceId" text,"mcpServerId" text,"organizationId" text,"crmCandidateId" text,"archivedAt" timestamp,name text,email text,profile jsonb)',
        );
        await tx.$executeRaw`INSERT INTO recruiting_crm_contacts VALUES
        ('owner','space','crm',${org},${id},NULL,'Saved person','saved@example.test','{}'),
        ('other','space','crm',${org},${id},NULL,'Foreign owner',NULL,'{}'),
        ('owner','other','crm',${org},${id},NULL,'Foreign space',NULL,'{}'),
        ('owner','space','other',${org},${id},NULL,'Foreign source',NULL,'{}'),
        ('owner','space','crm','other',${id},NULL,'Foreign org',NULL,'{}'),
        ('owner','space','crm',${org},${missing},now(),'Archived person',NULL,'{}')`;
        await tx.$executeRawUnsafe(
          "ALTER TABLE recruiting_crm_contacts ADD COLUMN id text DEFAULT md5(random()::text)",
        );
        await tx.$executeRawUnsafe(
          'CREATE TABLE recruiting_crm_campaigns(id text DEFAULT md5(random()::text),"userId" text,"spaceId" text,"mcpServerId" text,"organizationId" text,"crmRoleId" text,"crmCampaignId" text,"archivedAt" timestamp,name text,status int,"syncedAt" timestamp)',
        );
        await tx.$executeRaw`INSERT INTO recruiting_crm_campaigns ("userId","spaceId","mcpServerId","organizationId","crmRoleId","crmCampaignId","archivedAt",name,status,"syncedAt") VALUES
          ('owner','space','crm',${org},${id},'campaign',NULL,'Saved campaign',2,${new Date(at)}),
          ('owner','space','other',${org},${id},'campaign',NULL,'Foreign source',1,${new Date(at)}),
          ('other','space','crm',${org},${id},'campaign',NULL,'Foreign owner',1,${new Date(at)}),
          ('owner','space','crm','other',${id},'campaign',NULL,'Foreign org',1,${new Date(at)})`;
        const contactRead = vi.fn(tx.recruitingCrmContact.findMany.bind(tx.recruitingCrmContact));
        const prisma = {
          $queryRaw: vi.fn(async () => [actor]),
          mcpServer: { findFirst: vi.fn(async () => server) },
          botMcpServer: {
            findFirst: vi.fn(async () => ({ allowAllTools: true, allowedTools: [] })),
          },
          recruitingCrmContact: { findMany: contactRead },
          recruitingCrmCampaign: tx.recruitingCrmCampaign,
        } as unknown as PrismaClient;
        const execute = vi.fn(async function* (
          call: ConnectorCall,
          _context: AdapterContext,
        ): AsyncGenerator<ConnectorEvent> {
          const data =
            call.route!.toolName === "list_crm_memberships"
              ? [{ organization_id: org, role: "recruiter", organizations: { name: "Example" } }]
              : {
                  organization_id: org,
                  campaign_id: "campaign",
                  pagination: "offset",
                  offset: 0,
                  next_offset: null,
                  leads: [id, missing].map((candidate_id, index) => ({
                    id: `lead-${index}`,
                    candidate_id,
                    campaign_id: "campaign",
                    status: 1,
                    interest_status: null,
                    email_open_count: 1,
                    email_reply_count: null,
                    timestamp_last_contact: at,
                    timestamp_last_reply: null,
                    synced_at: at,
                  })),
                };
          yield { type: "result", data: { structuredContent: { data } } };
        });
        const result = await getRecruitingCrmData(
          {
            prisma,
            connectors: { execute },
            firstPartyMcpUrl: server.endpoint,
            reauthorize: async () => target,
          },
          actor,
          target,
          {
            operation: "campaignLeads",
            serverId: "crm",
            serverRevision: 1,
            organizationId: org,
            campaignId: "campaign",
            limit: 25,
          },
        );
        expect(result).toMatchObject({
          items: [
            { person: { name: "Saved person", email: "saved@example.test" }, status: 1 },
            { person: null, status: 1 },
          ],
        });
        expect(contactRead).toHaveBeenCalledOnce();
        const deps = {
          prisma,
          connectors: { execute },
          firstPartyMcpUrl: server.endpoint,
          reauthorize: async () => target,
        };
        const exact = {
          operation: "roleCampaigns" as const,
          serverId: "crm",
          serverRevision: 1,
          organizationId: org,
          campaignId: "campaign",
          crmRoleId: id,
        };
        expect(await getRecruitingCrmData(deps, actor, target, exact)).toMatchObject({
          items: [{ id: "campaign", name: "Saved campaign", status: 2 }],
        });
        expect(
          await getRecruitingCrmData(deps, actor, target, { ...exact, crmRoleId: missing }),
        ).toMatchObject({ items: [] });
        expect(
          await getRecruitingCrmData(deps, actor, target, { ...exact, campaignId: "missing" }),
        ).toMatchObject({ items: [] });
        expect(execute.mock.calls.some(([call]) => call.route!.toolName === "get_crm_role")).toBe(
          false,
        );
      });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
      await monitor.pool.query(`DROP DATABASE ${database}`);
      await monitor.prisma.$disconnect();
      await monitor.pool.end();
    }
  },
);
