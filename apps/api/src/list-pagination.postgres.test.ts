import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor, RecruitingCorrespondence } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createRecruitingRole } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const url = process.env.DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname);
const suite = process.env.VERIFY_DATABASE && local ? describe.sequential : describe.skip;
suite("contacts HTTP RPC with 1000 synthetic candidates (local PostgreSQL)", () => {
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
  let botId: string;
  let server: Server;
  let origin: string;
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
    const bots = Array.from({ length: 1 }, (_, index) => ({
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
    botId = bots[0]!.id;
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
    const service = await prisma.mcpServer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        slug: "synthetic-enrichment",
        name: "FullEnrich",
        transport: "streamable_http",
        endpoint: "https://mcp.fullenrich.com/mcp",
      },
    });
    await prisma.botMcpServer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        serverId: service.id,
        allowAllTools: false,
        allowedTools: ["get_enrichment_results"],
      },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        prompt: "Synthetic saved result",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        taskId: task.id,
        status: "completed",
        trigger: "message",
      },
    });
    await prisma.externalEffect.create({
      data: {
        spaceId: actor.spaceId,
        runId: run.id,
        kind: "connector",
        idempotencyKey: `synthetic-${suffix}`,
        status: "completed",
        request: [
          "__rakazoCatalogTool",
          "direct",
          {
            route: {
              connectorId: "mcp",
              resourceId: service.id,
              resourceRevision: 1,
              toolName: "get_enrichment_results",
            },
            args: { enrichment_id: "synthetic-saved-result" },
          },
        ],
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "FINISHED",
                results: Array.from({ length: 1000 }, (_, index) => ({
                  input: { professional_network_url: `https://linkedin.com/in/synthetic-${index}` },
                  profile: {
                    social_profiles: {
                      professional_network: { url: `https://linkedin.com/in/synthetic-${index}` },
                    },
                  },
                  contact_info: {
                    most_probable_work_email: {
                      email: `synthetic-${index}@example.test`,
                      status: "HIGH_PROBABILITY",
                    },
                    work_emails: [],
                    most_probable_phone: null,
                  },
                })),
              }),
            },
          ],
        },
      },
    });
    const handler = new RPCHandler(
      createRouter({ prisma, env: { deploymentModelConfigured: false } } as RouterDeps),
    );
    server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        // Fixed synthetic actor replaces session middleware only; router authorization and all DB reads are real.
        const result = await handler.handle(request, { prefix: "/rpc", context: { actor } });
        return result.response ?? new Response("Not found", { status: 404 });
      },
    }) as Server;
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback HTTP server");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prisma) {
      await prisma.organization.delete({ where: { id: organizationId } });
      await prisma.user.delete({ where: { id: actor.userId } });
    }
    await stop?.();
  });
  async function read(cursor = "0") {
    const response = await fetch(`${origin}/rpc/recruiting/correspondence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId, view: "contacts", cursor } }),
    });
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    return payload.json as RecruitingCorrespondence;
  }
  it("measures actual HTTP RPC p95 and retains all 1000 candidates across bounded pages", async () => {
    const all = new Set<string>();
    let cursor: string | null = "0";
    let requests = 0;
    while (cursor !== null) {
      const page = await read(cursor);
      expect(
        page.contacts,
        JSON.stringify({ status: page.status, roleId: page.roleId, connections: page.connections }),
      ).toHaveLength(200);
      for (const contact of page.contacts) all.add(contact.candidateKey);
      cursor = page.nextCursor;
      requests++;
    }
    expect(all.size).toBe(1000);
    expect(requests).toBe(5);
    for (let i = 0; i < 10; i++) await read();
    const durations: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const page = await read();
      durations.push(performance.now() - start);
      expect(
        page.contacts,
        JSON.stringify({ status: page.status, roleId: page.roleId, connections: page.connections }),
      ).toHaveLength(200);
    }
    durations.sort((a, b) => a - b);
    process.stdout.write(
      `${JSON.stringify({
        benchmark: "A3-local-http-contacts",
        candidates: 1000,
        samples: durations.length,
        warmups: 10,
        contactsPerResponse: 200,
        fullViewRequests: requests,
        p50Ms: Number(durations[49]!.toFixed(2)),
        p95Ms: Number(durations[94]!.toFixed(2)),
        maxMs: Number(durations[99]!.toFixed(2)),
        poolMax: 2,
        sessionMiddleware: "synthetic-fixed-actor",
      })}\n`,
    );
  }, 60000);
});
