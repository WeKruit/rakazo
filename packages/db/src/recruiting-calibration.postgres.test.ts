import type { Actor } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { guardRecruitingTurnEnd } from "../../adapters/src/turn-end-guard.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import * as recruiting from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("calibration rounds (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `calibration-owner-${suffix}`;
  const spaceId = `calibration-space-${suffix}`;
  const actor: Actor = { userId, spaceId, email: "owner@example.test", isDeploymentOwner: false };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let threadId: string;
  let botId: string;
  let runId: string;
  let roleId: string;
  let artifactId: string;
  let pageCount = 0;
  let messageSeq = 0;
  const lease = { leaseOwner: "calibration-worker", leaseFence: 1 };

  async function liveRun(text: string) {
    const message = await prisma.message.create({
      data: {
        threadId,
        seq: ++messageSeq,
        role: "user",
        blocks: [{ kind: "text", text }],
      },
    });
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: "running",
        sourceMessageId: message.id,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        ...lease,
      },
    });
    return message.id;
  }

  /** One saved provider page of people, observed now. */
  async function savePage(keys: string[]) {
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId,
        kind: "recruiting_research",
        idempotencyKey: `page:${suffix}:${pageCount++}`,
        status: "completed",
        request: {},
      },
    });
    const role = await prisma.recruitingRole.findUniqueOrThrow({ where: { id: roleId } });
    await prisma.recruitingCandidatePage.create({
      data: {
        effectId: effect.id,
        roleId,
        roleRevisionId: role.currentRevisionId,
        artifactId,
        artifactHash: "a".repeat(64),
        observedAt: new Date(),
        rowCount: keys.length,
      },
    });
    await prisma.recruitingCandidate.createMany({
      data: keys.map((candidateKey) => ({ roleId, candidateKey })),
      skipDuplicates: true,
    });
    await prisma.recruitingCandidateOccurrence.createMany({
      data: keys.map((candidateKey, rowIndex) => ({
        pageId: effect.id,
        rowIndex,
        roleId,
        candidateKey,
        name: `Person ${candidateKey}`,
        title: "Warehouse operations manager",
        linkedinUrl: `https://www.linkedin.com/in/${candidateKey}`,
        issues: [],
      })),
    });
  }

  async function recordRound(candidateKeys: string[]) {
    await liveRun("继续");
    const request = {
      operation: "calibration_round" as const,
      expectedRoleRevision: 1,
      candidateKeys,
    };
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId,
        kind: "recruiting_research",
        idempotencyKey: `round:${suffix}:${pageCount++}`,
        status: "executing",
        request,
      },
    });
    return recruiting.saveRecruitingCalibrationRound(
      prisma,
      actor,
      { runId, ...lease, effectId: effect.id, effectRequest: request },
      request,
    );
  }

  const keys = (prefix: string) => Array.from({ length: 10 }, (_, index) => `${prefix}-${index}`);

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const organizationId = `calibration-org-${suffix}`;
    await prisma.user.create({
      data: { id: userId, name: "Owner", email: `${userId}@example.test` },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Synthetic", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Space" } });
    botId = (await prisma.bot.create({ data: { spaceId, userId, name: "Sourcer", color: "blue" } }))
      .id;
    threadId = (await prisma.thread.create({ data: { spaceId, userId, botId } })).id;
    const message = await prisma.message.create({
      data: { threadId, seq: 0, role: "user", blocks: [{ kind: "text", text: "Hire a manager" }] },
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
    const role = await recruiting.createRecruitingRole(prisma, actor, {
      sourceThreadId: threadId,
      expectedRevision: 0,
      title: "Warehouse operations manager",
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
    });
    roleId = role.role.id;
    await prisma.thread.update({
      where: { id: threadId },
      data: { activeRecruitingRoleId: roleId },
    });
    artifactId = (
      await prisma.artifact.create({
        data: {
          spaceId,
          userId,
          name: "page.json",
          mimeType: "application/json",
          size: 2,
          hash: "a".repeat(64),
          storageKey: `calibration-${suffix}`,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.space.deleteMany({ where: { id: spaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("records the first round, then accepts only people returned after it", async () => {
    await savePage([...keys("first"), "spare-0", "spare-1"]);
    const first = await recordRound(keys("first"));
    expect(first).toMatchObject({ status: "saved", round: 1 });
    // A key cut short that several saved people continue names them for the retry.
    await expect(recordRound([...keys("first").slice(0, 9), "spare-"])).rejects.toThrow(
      "spare- (saved keys starting with it: spare-0, spare-1)",
    );
    expect(
      (await prisma.recruitingRole.findUniqueOrThrow({ where: { id: roleId } })).playbookStage,
    ).toBe("feedback");

    const sendUserMessage = vi.fn(async () => ({
      messageId: "synthetic",
      seq: 99,
      taskId: "synthetic",
      runId: null,
    }));
    const deps = {
      prisma,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn() },
    } as unknown as Parameters<typeof guardRecruitingTurnEnd>[0];
    const guardInput = {
      run: { id: runId, spaceId, threadId, botId, userId, trigger: "user" },
      roleId,
      blocks: [{ kind: "text" as const, text: "本轮十人已展示在校准面板。" }],
      handedOff: false,
      pendingApproval: false,
      postAssistant: vi.fn(),
    };
    // The actual save transaction produced the feedback panel and completed native effect.
    await expect(guardRecruitingTurnEnd(deps, guardInput)).resolves.toEqual({
      action: "ended",
      classification: "question",
    });
    expect(sendUserMessage).not.toHaveBeenCalled();
    // A later human turn must not stop on an old panel from a different run.
    await expect(
      guardRecruitingTurnEnd(deps, {
        ...guardInput,
        run: { ...guardInput.run, id: `${runId}-later` },
      }),
    ).resolves.toMatchObject({ action: "continued" });

    // Already returned before round 1, even though never shown: refused.
    await expect(
      recordRound([...keys("first").slice(0, 8), "spare-0", "spare-1"]),
    ).rejects.toBeInstanceOf(recruiting.RecruitingCalibrationRoundError);
    await savePage([...keys("second").slice(0, 8)]);
    await expect(
      recordRound([...keys("second").slice(0, 8), "spare-0", "spare-1"]),
    ).rejects.toThrow(/2 of these ten were already returned before round 1/);

    await savePage(keys("second").slice(8));
    const second = await recordRound(keys("second"));
    expect(second).toMatchObject({ status: "saved", round: 2 });

    const view = await recruiting.readRecruitingCalibrationRound(prisma, actor, { threadId });
    expect(view.round).toMatchObject({ round: 2, approvedAt: null });
    expect(view.round?.candidates.map((candidate) => candidate.candidateKey)).toEqual(
      keys("second"),
    );
    expect(view.round?.candidates[0]).toMatchObject({
      name: "Person second-0",
      linkedinUrl: "https://www.linkedin.com/in/second-0",
    });
  });

  it("accepts a round from the recruiter's own words and then refuses more rounds", async () => {
    const quote = "第 2 轮这批人可以，开始扩大搜索。";
    const sourceMessageId = await liveRun(quote);
    const approved = await recruiting.approveRecruitingCalibrationRoundFromMessage(prisma, actor, {
      runId,
      sourceMessageId,
      intent: { basis: "direct", quote },
      roleId,
      expectedRoleRevision: 1,
    });
    expect(approved).toMatchObject({ round: 2, already: false });
    const role = await prisma.recruitingRole.findUniqueOrThrow({ where: { id: roleId } });
    expect(role.playbookStage).toBe("scale");
    const round = await prisma.recruitingCalibrationRound.findFirstOrThrow({
      where: { roleId, round: 2 },
    });
    expect(round.approvedByUserId).toBe(userId);
    expect(round.approvalSource).toEqual({ kind: "message", messageId: sourceMessageId });

    // The panel control on an already accepted round is a no-op.
    await expect(
      recruiting.approveRecruitingCalibrationRound(prisma, actor, { threadId, round: 2 }),
    ).resolves.toMatchObject({ round: 2 });
    await savePage(keys("third"));
    await expect(recordRound(keys("third"))).rejects.toThrow(/already approved/);
  });

  it("refuses a quote the recruiter did not write", async () => {
    const sourceMessageId = await liveRun("第 3 位不太合适");
    await expect(
      recruiting.approveRecruitingCalibrationRoundFromMessage(prisma, actor, {
        runId,
        sourceMessageId,
        intent: { basis: "direct", quote: "可以，开始扩大搜索" },
        roleId,
        expectedRoleRevision: 1,
      }),
    ).rejects.toThrow();
  });
});
