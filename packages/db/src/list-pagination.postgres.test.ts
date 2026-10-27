import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { collectListPages } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createRecruitingRole } from "./recruiting.js";
import { createRepos } from "./repos.js";

const url = process.env.DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname);
const suite = process.env.VERIFY_DATABASE && local ? describe.sequential : describe.skip;
suite("bounded lists with 1000 synthetic rows (local PostgreSQL)", () => {
  const suffix = randomUUID();
  const organizationId = `list-org-${suffix}`;
  const actor: Actor = {
    userId: `list-user-${suffix}`,
    spaceId: `list-space-${suffix}`,
    email: `list-${suffix}@example.test`,
    isDeploymentOwner: false,
  };
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  let roleId: string;
  beforeAll(async () => {
    const db = createDb(url!, { poolMax: 2 });
    prisma = db.prisma;
    stop = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({ data: { id: actor.userId, name: "Synthetic", email: actor.email } });
    await prisma.organization.create({
      data: { id: organizationId, name: "Synthetic", slug: organizationId, createdAt: new Date() },
    });
    await prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId,
        userId: actor.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.space.create({ data: { id: actor.spaceId, organizationId, name: "Synthetic" } });
    await prisma.spaceMember.create({
      data: {
        id: randomUUID(),
        organizationId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        createdAt: new Date(),
      },
    });
    const bots = Array.from({ length: 1000 }, (_, index) => ({
      id: `${suffix}-${index}`,
      spaceId: actor.spaceId,
      userId: actor.userId,
      name: `Synthetic ${index}`,
      color: "ink",
      position: index,
    }));
    await prisma.bot.createMany({ data: bots });
    await prisma.thread.createMany({
      data: bots.map((bot) => ({
        id: `thread-${bot.id}`,
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
      })),
    });
    const threadId = `thread-${bots[0]!.id}`;
    const message = await prisma.message.create({
      data: { threadId, seq: 0, role: "user", blocks: [{ kind: "text", text: "Synthetic role" }] },
    });
    const result = await createRecruitingRole(prisma, actor, {
      sourceThreadId: threadId,
      expectedRevision: 0,
      title: "Synthetic",
      sourceRefs: [
        {
          id: "source",
          kind: "original_material",
          anchor: { kind: "message", messageId: message.id, locator: "text:0" },
          readState: "read",
          readAt: new Date().toISOString(),
        },
      ],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
    });
    roleId = result.role.id;
    await prisma.recruitingCandidate.createMany({
      data: Array.from({ length: 1000 }, (_, index) => ({
        roleId,
        candidateKey: `linkedin:/in/synthetic-${index}`,
      })),
    });
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.organization.delete({ where: { id: organizationId } });
      await prisma.user.delete({ where: { id: actor.userId } });
    }
    await stop?.();
  });
  it("returns every bot with 200-row database pages and stable tie-breaking", async () => {
    const repos = createRepos(prisma);
    const sizes: number[] = [];
    const result = await collectListPages(async (offset) => {
      const items = await repos.listBots(actor, { limit: 200, offset });
      sizes.push(items.length);
      return { items, nextOffset: items.length === 200 ? offset + 200 : null };
    });
    expect(result).toHaveLength(1000);
    expect(new Set(result.map((bot) => bot.id)).size).toBe(1000);
    expect(sizes).toEqual([200, 200, 200, 200, 200, 0]);
  });
  it("measures candidate membership lookup without materializing the 1000-row role", async () => {
    const where = { roleId, role: { spaceId: actor.spaceId, userId: actor.userId } };
    const observed = Array.from({ length: 20 }, (_, index) => `linkedin:/in/synthetic-${index}`);
    const before = () =>
      prisma.recruitingCandidate.findMany({ where, select: { candidateKey: true } });
    const after = () =>
      prisma.recruitingCandidate.findMany({
        where: { ...where, candidateKey: { in: observed } },
        select: { candidateKey: true },
        take: 200,
      });
    async function measure(read: typeof before) {
      for (let index = 0; index < 10; index++) await read();
      const durations: number[] = [];
      let rows = 0;
      for (let index = 0; index < 100; index++) {
        const start = performance.now();
        rows = (await read()).length;
        durations.push(performance.now() - start);
      }
      durations.sort((a, b) => a - b);
      return { rows, samples: durations.length, p95Ms: Number(durations[94]!.toFixed(2)) };
    }
    const baseline = await measure(before);
    const result = await measure(after);
    expect(baseline.rows).toBe(1000);
    expect(result.rows).toBe(20);
    expect(result.p95Ms).toBeLessThan(300);
    process.stdout.write(
      JSON.stringify({
        metric: "candidate-membership-query-not-rpc",
        before: baseline,
        after: result,
      }) + "\n",
    );
    expect(
      await prisma.recruitingCandidate.findMany({
        where: {
          ...where,
          role: { spaceId: "other", userId: actor.userId },
          candidateKey: { in: observed },
        },
        select: { candidateKey: true },
        take: 200,
      }),
    ).toEqual([]);
  });
});
