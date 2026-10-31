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
        totalTokens: 120,
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
    expect(costs.total).toEqual({ credits: 257.8, pending: true });
    expect(costs.canViewInternalCosts).toBe(false);
    expect(JSON.stringify(costs)).not.toMatch(/costUsd|tokens|services|accounts/);
    const [role] = costs.roles;
    expect(role).toMatchObject({ roleId, title: "Quality manager", credits: 257.8 });
    expect(role!.rounds).toEqual([
      { round: 1, scale: false, credits: 103.4, pending: true },
      { round: 2, scale: false, credits: 153, pending: false },
      { round: null, scale: true, credits: 1.4, pending: false },
    ]);

    // An unverified operator-domain mailbox stays on credits only.
    await prisma.user.update({
      where: { id: userId },
      data: { email: `${userId}@wekruit.com`, emailVerified: false },
    });
    expect((await db.summarizeUsageCosts(prisma, actor)).canViewInternalCosts).toBe(false);
    await prisma.user.update({
      where: { id: userId },
      data: { email: `${userId}@notwekruit.com`, emailVerified: true },
    });
    expect((await db.summarizeUsageCosts(prisma, actor)).canViewInternalCosts).toBe(false);
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

    // Two readings landing at once claim the window between them and the last one only once.
    const researchCredits = () =>
      prisma.usageRecord.aggregate({
        where: { spaceId, unit: "credits", provider: "autumn" },
        _sum: { quantity: true },
      });
    const beforeConcurrent = (await researchCredits())._sum.quantity ?? 0;
    // The first reading's transaction stays open while the second one completes.
    const reading = async () => {
      const effect = await prisma.externalEffect.create({
        data: {
          spaceId,
          runId,
          kind: "connector",
          idempotencyKey: `usage:${suffix}:${seq++}`,
          status: "executing",
          request: [
            "__rakazoCatalogTool",
            "credits_execute_tool",
            {},
            { connectorId: "mcp", resourceId: researchServerId, toolName: "credits" },
          ],
        },
      });
      return (tx: Pick<PrismaClient, "externalEffect">) =>
        tx.externalEffect.update({
          where: { id: effect.id },
          data: {
            status: "completed",
            result: { structuredContent: { credits_used: 1200, credits_remaining: 98_800 } },
          },
        });
    };
    const [first, second] = await Promise.all([reading(), reading()]);
    let firstDone!: () => void;
    const firstWritten = new Promise<void>((resolve) => {
      firstDone = resolve;
    });
    await Promise.all([
      prisma.$transaction(async (tx) => {
        await first(tx);
        firstDone();
        await new Promise((resolve) => setTimeout(resolve, 300));
      }),
      firstWritten.then(() => second(prisma)),
    ]);
    expect(((await researchCredits())._sum.quantity ?? 0) - beforeConcurrent).toBe(50);

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

    const owner = await db.summarizeInternalUsageCosts(prisma, {
      priceTokens: (provider, model, tokens) =>
        provider === "openai-codex" && model === "gpt-test" ? tokens.input * 0.005 : null,
    });
    const account = owner.accounts.find((account) => account.userId === userId)!;
    const expectedUsd = 200 * 0.0085 + 26 * 0.058 + 2 * 0.007 + 0.5;
    expect(account.costUsd).toBeCloseTo(expectedUsd, 6);
    expect(account.credits).toBeCloseTo(expectedUsd * 200, 4);
    expect(account.vendors.find((vendor) => vendor.vendor === "autumn")!.costUsd).toBeCloseTo(
      1.7,
      8,
    );
    expect(account.vendors.find((vendor) => vendor.vendor === "autumn")!.credits).toBe(340);
    const llm = account.vendors.find((vendor) => vendor.vendor === "openai-codex")!.models[0]!;
    expect(llm).toMatchObject({
      model: "gpt-test",
      unit: "tokens",
      tokens: 120,
      costUsd: 0.5,
      credits: 100,
      costSources: ["catalog-estimate"],
    });
    // A changed catalog cannot reprice finalized token history.
    const again = await db.summarizeInternalUsageCosts(prisma, { priceTokens: () => 99 });
    expect(again.accounts.find((value) => value.userId === userId)!.credits).toBe(account.credits);
  });

  it("does not charge a search surcharge for agent runs or status polling", async () => {
    const effect = await connectorCall(searchServerId, "agent_run", new Date(), {
      structuredContent: {
        id: `paid-agent-${suffix}`,
        status: "completed",
        costDollars: { total: 0.21 },
      },
    });
    await connectorCall(searchServerId, "agent_run_status", new Date());
    await prisma.usageRecord.create({
      data: {
        ...actor,
        provider: "people-search",
        model: "agent_run",
        unit: "credits",
        quantity: 0.21,
        costUsd: 0.21,
        costSource: "provider-reported",
        callId: `paid-agent-${suffix}`,
      },
    });
    const call = await prisma.usageRecord.findUnique({ where: { callId: `call:${effect.id}` } });
    expect(call).toMatchObject({ costUsd: 0, creditRate: 200 });
    const summary = await db.summarizeInternalUsageCosts(prisma);
    const account = summary.accounts.find((item) => item.userId === userId)!;
    const models = account.vendors.find((item) => item.vendor === "people-search")!.models;
    expect(
      models.find((item) => item.unit === "credits" && item.model === "agent_run"),
    ).toMatchObject({ costUsd: 0.21, credits: 42 });
    expect(
      models.find((item) => item.unit === "calls" && item.model === "agent_run_status"),
    ).toMatchObject({ costUsd: 0, credits: 0 });
  });

  it("freezes each credit conversion rate across pricing changes and duplicate delivery", async () => {
    const previous = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    try {
      await prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default" },
        update: { usageCreditsPerUsd: 100, usageGrossMargin: 0.5 },
      });
      const event = {
        type: "usage" as const,
        provider: "snapshot-test",
        model: "snapshot-model",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        costUsd: 0.007,
        costSource: "provider-reported",
        callId: `snapshot-old-${suffix}`,
      };
      await db.recordUsage(prisma, event, actor);
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { usageCreditsPerUsd: 200 },
      });
      await db.recordUsage(prisma, event, actor);
      await db.recordUsage(prisma, { ...event, callId: `snapshot-new-${suffix}` }, actor);
      const rows = await prisma.usageRecord.findMany({
        where: { provider: "snapshot-test", userId },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.creditRate).sort()).toEqual([200, 400]);
      const internal = await db.summarizeInternalUsageCosts(prisma);
      const model = internal.accounts
        .find((row) => row.userId === userId)!
        .vendors.find((row) => row.vendor === "snapshot-test")!.models[0]!;
      expect(model).toMatchObject({ costUsd: 0.014, credits: 4.2, tokens: 240 });
      await expect(
        prisma.deploymentSettings.update({
          where: { id: "default" },
          data: { usageGrossMargin: 1 },
        }),
      ).rejects.toThrow();
    } finally {
      if (previous)
        await prisma.deploymentSettings.update({
          where: { id: "default" },
          data: {
            usageCreditsPerUsd: previous.usageCreditsPerUsd,
            usageGrossMargin: previous.usageGrossMargin,
          },
        });
      else await prisma.deploymentSettings.delete({ where: { id: "default" } });
    }
  });
});
