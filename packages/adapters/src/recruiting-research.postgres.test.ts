import { randomUUID } from "node:crypto";
import { createDb } from "@rakazo/db";
import { expect, it } from "vitest";
import { requireFullEnrichJobOwnership } from "./recruiting-research.js";

const url = process.env.DATABASE_URL;
it.skipIf(process.env.VERIFY_DATABASE !== "1" || !url)(
  "finds this person's own lookup receipts through the receipt indexes, across pages",
  async () => {
    const { prisma, pool } = createDb(url!);
    const id = `receipts-${randomUUID()}`;
    const server = {
      id: `${id}-server`,
      revision: 2,
      transport: "streamable_http",
      endpoint: "https://mcp.fullenrich.com/mcp",
    };
    const route = {
      connectorId: "mcp",
      resourceId: server.id,
      resourceRevision: 2,
      toolName: "enrich_bulk",
    };
    const people = { contacts: [{ linkedin_url: "https://www.linkedin.com/in/someone" }] };
    try {
      await prisma.organization.create({
        data: { id: `${id}-org`, name: "Synthetic", slug: `${id}-org`, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id: `${id}-space`, organizationId: `${id}-org`, name: "Space" },
      });
      const runFor = async (userId: string) => {
        await prisma.user.create({ data: { id: userId, name: "Owner", email: `${userId}@x.test` } });
        const bot = await prisma.bot.create({
          data: { spaceId: `${id}-space`, userId, name: "Sourcer", color: "blue" },
        });
        const thread = await prisma.thread.create({
          data: { spaceId: `${id}-space`, userId, botId: bot.id },
        });
        const message = await prisma.message.create({
          data: { threadId: thread.id, seq: 0, role: "user", blocks: [] },
        });
        const task = await prisma.task.create({
          data: {
            spaceId: `${id}-space`,
            userId,
            botId: bot.id,
            threadId: thread.id,
            prompt: "Synthetic",
            status: "running",
          },
        });
        return prisma.run.create({
          data: {
            spaceId: `${id}-space`,
            userId,
            botId: bot.id,
            threadId: thread.id,
            taskId: task.id,
            status: "running",
            trigger: "user",
            sourceMessageId: message.id,
          },
        });
      };
      const mine = await runFor(`${id}-owner`);
      const theirs = await runFor(`${id}-other`);
      const receipt = (runId: string, n: number, catalog = false) =>
        prisma.externalEffect.create({
          data: {
            spaceId: `${id}-space`,
            runId,
            kind: "mcp__fullenrich__enrich_bulk",
            idempotencyKey: `${id}-${runId}-${n}`,
            status: "completed",
            createdAt: new Date(Date.UTC(2026, 10, 1, 0, n)),
            request: catalog
              ? [
                  "__rakazoCatalogTool",
                  "connectors_execute_tool",
                  { id: `${server.id}:enrich_bulk`, arguments: people },
                  route,
                ]
              : ["__rakazoCatalogTool", "direct", { route, args: people }],
            result: {
              content: [{ type: "text", text: JSON.stringify({ enrichment_id: `job-${n}` }) }],
            },
          },
        });
      // The oldest lookup was made through the catalog; 25 newer ones are past the first page.
      await receipt(mine.id, 0, true);
      for (let n = 1; n <= 25; n++) await receipt(mine.id, n);
      await receipt(theirs.id, 30);
      const owner = { userId: `${id}-owner`, spaceId: `${id}-space` };
      const read = (enrichmentId: string, actor = owner) =>
        requireFullEnrichJobOwnership(prisma, actor, server, "get_enrichment_results", {
          enrichment_id: enrichmentId,
        });
      await expect(read("latest")).resolves.toEqual({ enrichment_id: "job-25" });
      await expect(read("job-0")).resolves.toEqual({ enrichment_id: "job-0" });
      await expect(read("job-30")).rejects.toThrow("Your latest lookups, newest first: job-25");
      await expect(read("job-30", { ...owner, userId: `${id}-other` })).resolves.toBeTruthy();

      const indexes = await prisma.$queryRaw<Array<{ name: string; valid: boolean }>>`
        SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname IN ('external_effects_direct_tool_receipts_idx',
          'external_effects_catalog_tool_receipts_idx') ORDER BY 1`;
      expect(indexes).toEqual([
        { name: "external_effects_catalog_tool_receipts_idx", valid: true },
        { name: "external_effects_direct_tool_receipts_idx", valid: true },
      ]);
    } finally {
      await prisma.space.deleteMany({ where: { id: `${id}-space` } });
      await prisma.user.deleteMany({ where: { id: { startsWith: id } } });
      await prisma.organization.deleteMany({ where: { id: `${id}-org` } });
      await prisma.$disconnect();
      await pool.end();
    }
  },
);
