import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createDb } from "./client.js";
import { listRecruitingContacts } from "./recruiting-contacts.js";

const url = process.env.RECRUITING_SEARCH_TEST_DATABASE_URL;
const local = url && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(url).hostname);
it.skipIf(!local)(
  "selective contact search stays bounded across 30000 owned saved contacts",
  async () => {
    const db = createDb(url!);
    const id = `search-perf-${randomUUID()}`;
    try {
      await db.prisma
        .$transaction(
          async (tx) => {
            await tx.user.create({ data: { id, name: "Synthetic", email: `${id}@example.test` } });
            await tx.organization.create({
              data: { id, name: "Synthetic", slug: id, createdAt: new Date() },
            });
            await tx.space.create({ data: { id, name: "Synthetic", organizationId: id } });
            await tx.mcpServer.create({
              data: {
                id,
                userId: id,
                spaceId: id,
                name: "Synthetic",
                slug: id,
                transport: "streamable_http",
              },
            });
            await tx.$executeRaw`INSERT INTO recruiting_crm_contacts
        (id,"spaceId","userId","mcpServerId","organizationId","crmCandidateId",name,title,company,email,"contactStatus","outreachStatus","clientLabel","roleLabel","syncedAt")
        SELECT ${id}||'-'||n,${id},${id},${id},'synthetic-org',n::text,
          CASE WHEN n=29999 THEN 'Synthetic-Person Example' ELSE 'Synthetic contact '||n END,
          'Engineer','Example company','person'||n||'@example.test','saved','not_contacted','Synthetic','Synthetic',now()
        FROM generate_series(1,30000) n`;
            const samples: number[] = [];
            for (let i = 0; i < 3; i++) {
              const start = performance.now();
              const result = await listRecruitingContacts(
                tx,
                {
                  userId: id,
                  spaceId: id,
                  email: "synthetic@example.test",
                  isDeploymentOwner: false,
                },
                { filters: { query: "Synthetic-Person" }, sort: "name", limit: 8 },
              );
              samples.push(performance.now() - start);
              expect(result.items.map((person) => person.name)).toEqual([
                "Synthetic-Person Example",
              ]);
              expect(result.total).toBe(1);
            }
            process.stdout.write(
              `Synthetic contact search milliseconds: ${samples.map((value) => Math.round(value)).join(", ")}\n`,
            );
            expect(Math.max(...samples)).toBeLessThan(1000);
            // Deliberately roll back every synthetic row; this benchmark leaves no records behind.
            throw new Error("rollback-synthetic-search");
          },
          { timeout: 60000 },
        )
        .catch((error) => {
          if (!(error instanceof Error) || error.message !== "rollback-synthetic-search")
            throw error;
        });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
  70000,
);
