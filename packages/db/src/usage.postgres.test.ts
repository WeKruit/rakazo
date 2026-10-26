import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import * as db from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("usage ledger (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `usage-owner-${suffix}`;
  const spaceId = `usage-space-${suffix}`;
  const actor = { userId, spaceId };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let runId: string;
  let botId: string;
  let roleId: string;
  let searchServerId: string;
  let researchServerId: string;
  let enrichServerId: string;
  let seq = 0;

  async function connectorCall(
    serverId: string,
    toolName: string,
    at: Date,
    result?: Record<string, unknown>,
  ) {
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId,
        kind: "connector",
        idempotencyKey: `usage:${suffix}:${seq++}`,
        status: "executing",
        request: [
          "__rakazoCatalogTool",
          `${toolName}_execute_tool`,
          {},
          { connectorId: "mcp", resourceId: serverId, toolName },
        ],
        createdAt: at,
      },
    });
    await prisma.externalEffect.update({
      where: { id: effect.id },
      data: { status: "completed", updatedAt: at, ...(result ? { result: result as never } : {}) },
    });
    return effect;
  }

  async function balance(used: number, at: Date) {
    return connectorCall(researchServerId, "credits", at, {
      structuredContent: { credits_used: used, credits_remaining: 100_000 - used, plan: "pmf" },
    });
  }

  beforeAll(async () => {
    const created = createDb(databaseUrl!);
    prisma = created.prisma;
    close = async () => {
      await prisma.$disconnect();
      await created.pool.end();
    };
    const organizationId = `usage-org-${suffix}`;
    await prisma.user.create({ data: { id: userId, name: "Owner", email: `${userId}@x.test` } });
    await prisma.organization.create({
      data: { id: organizationId, name: "Synthetic", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Space" } });
    botId = (await prisma.bot.create({ data: { spaceId, userId, name: "Sourcer", color: "blue" } }))
      .id;
    const threadId = (await prisma.thread.create({ data: { spaceId, userId, botId } })).id;
    const message = await prisma.message.create({
      data: { threadId, seq: 0, role: "user", blocks: [{ kind: "text", text: "Hire" }] },
    });
    const task = await prisma.task.create({
      data: { spaceId, userId, botId, threadId, prompt: "Synthetic", status: "running" },
    });
    runId = (
      await prisma.run.create({
        data: {
          spaceId,
          userId,
          botId,
          threadId,
          taskId: task.id,
          status: "running",
          trigger: "user",
          sourceMessageId: message.id,
        },
      })
    ).id;
    const role = await db.createRecruitingRole(
      prisma,
      { ...actor, email: "owner@x.test", isDeploymentOwner: false },
      {
        sourceThreadId: threadId,
        expectedRevision: 0,
        title: "Quality manager",
        sourceRefs: [
          {
            id: "source-jd",
            kind: "original_material",
            anchor: { kind: "message", messageId: message.id, locator: "text:0" },
            readState: "read",
            readAt: "2026-10-23T00:00:00.000Z",
          },
        ],
        preferences: [],
        definitionQuestions: [],
        criteria: [],
      },
    );
    roleId = role.role.id;
    const server = (slug: string) =>
      prisma.mcpServer.create({
        data: { spaceId, userId, slug, name: slug, transport: "http", endpoint: "https://x.test" },
      });
    searchServerId = (await server("people-search")).id;
    researchServerId = (await server("autumn")).id;
    enrichServerId = (await server("fullenrich")).id;
  });

  afterAll(async () => {
    await prisma.space.deleteMany({ where: { id: spaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("records model tokens, connector calls and credit increases against the role and round", async () => {
    const before = new Date(Date.now() - 60_000);
    await db.recordUsage(
      prisma,
      {
        type: "usage",
        provider: "openai-codex",
        model: "gpt-test",
        inputTokens: 100,
        outputTokens: 20,
      } as never,
      { spaceId, userId, botId, runId },
    );
    await connectorCall(searchServerId, "web_search_exa", before);
    const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
    // Research spend is only reported as an account-wide running total.
    await balance(1000, ago(55));
    await connectorCall(researchServerId, "research", ago(50));
    await balance(1060, ago(45));
    // A repeated reading of the same running total is not new spend.
    await balance(1060, ago(44));
    const round = await prisma.recruitingCalibrationRound.create({
      data: { roleId, round: 1, candidateKeys: [], effectId: `round-${suffix}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await connectorCall(researchServerId, "get_task", new Date());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await balance(1150, new Date());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await prisma.recruitingCalibrationRound.update({
      where: { id: round.id },
      data: { approvedAt: new Date() },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const effect = await connectorCall(searchServerId, "web_search_exa", new Date());
    // Completing the same effect again does not double count.
    await prisma.externalEffect.update({ where: { id: effect.id }, data: { status: "executing" } });
    await prisma.externalEffect.update({ where: { id: effect.id }, data: { status: "completed" } });

    const rows = await prisma.usageRecord.findMany({
      where: { spaceId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.every((row) => row.roleId === roleId)).toBe(true);
    expect(rows.filter((row) => row.unit === "credits").map((row) => row.quantity)).toEqual([
      60, 90,
    ]);
    expect(rows.filter((row) => row.unit === "calls")).toHaveLength(8);

    const costs = await db.summarizeUsageCosts(prisma, actor);
    expect(costs.total).toEqual({ credits: 150, calls: 8, tokens: 120 });
    expect(costs.month.estimatedUsd).toBeUndefined();
    expect(costs.services).toBeUndefined();
    const [role] = costs.roles;
    expect(role).toMatchObject({ roleId, title: "Quality manager", credits: 150 });
    expect(role!.rounds).toEqual([
      { round: 1, scale: false, credits: 60, calls: 5, tokens: 120 },
      { round: 2, scale: false, credits: 90, calls: 2, tokens: 0 },
      { round: null, scale: true, credits: 0, calls: 1, tokens: 0 },
    ]);

    // An unverified operator-domain mailbox stays on credits only.
    await prisma.user.update({
      where: { id: userId },
      data: { email: `${userId}@wekruit.com`, emailVerified: false },
    });
    expect((await db.summarizeUsageCosts(prisma, actor)).total.estimatedUsd).toBeUndefined();
    await prisma.user.update({
      where: { id: userId },
      data: { email: `${userId}@notwekruit.com`, emailVerified: true },
    });
    expect((await db.summarizeUsageCosts(prisma, actor)).accounts).toBeUndefined();
    await prisma.user.update({
      where: { id: userId },
      data: { email: `${userId}@WeKruit.com`, emailVerified: true },
    });
    // An enrichment job reports its credits once finished; reading it again is not new spend.
    const finished = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: "job-1", status: "FINISHED", cost: { credits: 14 } }),
        },
      ],
    };
    await connectorCall(enrichServerId, "get_enrichment_results", new Date(), finished);
    await connectorCall(enrichServerId, "get_enrichment_results", new Date(), finished);

    // Odd provider bodies never fail the connector write and never count as credits.
    for (const body of [
      {
        content: [{ type: "text", text: JSON.stringify({ id: "job-2", cost: { credits: "12" } }) }],
      },
      {
        content: [
          { type: "text", text: JSON.stringify({ id: "job-3", cost: { credits: { n: 1 } } }) },
        ],
      },
      { content: [{ type: "text", text: "{not json" }] },
      { structuredContent: { id: "job-4", cost: "free" } },
    ]) {
      const odd = await connectorCall(enrichServerId, "get_enrichment_results", new Date(), body);
      expect(
        await prisma.externalEffect.findUniqueOrThrow({ where: { id: odd.id } }),
      ).toMatchObject({ status: "completed" });
    }
    expect(
      await prisma.usageRecord.count({
        where: { spaceId, unit: "credits", provider: "fullenrich" },
      }),
    ).toBe(1);

    // Contact enrichment also reports only a remaining balance; a drop is spend, a top-up is not.
    await connectorCall(enrichServerId, "get_credits", new Date(), {
      content: [{ type: "text", text: JSON.stringify({ credits: 1102 }) }],
    });
    await connectorCall(enrichServerId, "enrich_bulk", new Date());
    await connectorCall(enrichServerId, "get_credits", new Date(), {
      content: [{ type: "text", text: JSON.stringify({ credits: 1090 }) }],
    });
    await connectorCall(enrichServerId, "get_credits", new Date(), {
      content: [{ type: "text", text: JSON.stringify({ credits: 5000 }) }],
    });

    const owner = await db.summarizeUsageCosts(prisma, actor, {
      priceTokens: (provider, model, tokens) =>
        provider === "openai-codex" && model === "gpt-test" && tokens.input === 100 ? 0.5 : null,
    });
    // 150 research credits, 26 enrichment credits, 2 searches and the model call at list price.
    expect(owner.total.credits).toBe(176);
    expect(owner.total.estimatedUsd).toBeCloseTo(150 * 0.0085 + 26 * 0.058 + 2 * 0.007 + 0.5, 2);
    expect(owner.services).toEqual(
      expect.arrayContaining([
        { service: "autumn", unit: "credits", quantity: 150, estimatedUsd: 1.28, priced: true },
        { service: "fullenrich", unit: "credits", quantity: 26, estimatedUsd: 1.51, priced: true },
        { service: "people-search", unit: "calls", quantity: 2, estimatedUsd: 0.01, priced: true },
        {
          service: "openai-codex/gpt-test",
          unit: "tokens",
          quantity: 120,
          estimatedUsd: 0.5,
          priced: true,
        },
      ]),
    );
    expect(owner.accounts?.find((account) => account.userId === userId)).toMatchObject({
      credits: 176,
      estimatedUsd: 3.3,
    });
    // Without a known model price the tokens stay visible as unpriced, never silently free.
    const unpriced = await db.summarizeUsageCosts(prisma, actor);
    expect(unpriced.services).toContainEqual(
      expect.objectContaining({ service: "openai-codex/gpt-test", priced: false }),
    );
  });
});
