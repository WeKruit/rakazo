import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createRecruitingRole } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { waitForRecruitingAgentRun } from "./recruiting-agent-run-wait.js";
import {
  currentWorkEstimate,
  startWorkEstimate,
  waitWithCountdown,
  wakeForResearchCountdown,
} from "./work-estimate.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const MINUTE = 60_000;

/**
 * A search that outlives its countdown, walked through the real follow-up job against the
 * database: the recruiter hears one progress line each time the countdown runs out, quiet
 * check-ins in between, and the countdown ends when the search does.
 */
describePostgres("big-work countdown follow-up (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `countdown-org-${suffix}`;
  const spaceId = `countdown-space-${suffix}`;
  const userId = `countdown-user-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: "Synthetic recruiter", email: `${userId}@example.test` },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Synthetic countdown",
        slug: organizationId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Synthetic countdown" } },
      },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await close();
    }
  });

  /** A crew conversation where the recruiter just asked for 100 more people. */
  async function conversation() {
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Sourcer", color: "ink" },
    });
    const group = await prisma.chatGroup.create({ data: { spaceId, userId, name: "Crew" } });
    await prisma.chatGroupMember.create({ data: { groupId: group.id, botId: bot.id } });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    const asked = await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        blocks: [{ kind: "text", text: "再找 100 个人" }],
      },
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Find 100 more",
        status: "completed",
      },
    });
    const turn = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "completed",
        trigger: "user",
        sourceMessageId: asked.id,
      },
    });
    return { bot, thread, turn, askedAt: asked.createdAt.getTime() };
  }

  let answers = 0;
  /** One provider answer to an agent_run call, saved the way the executor saves it. */
  async function answer(runId: string, agentRunId: string, status: string) {
    await prisma.externalEffect.create({
      data: {
        spaceId,
        runId,
        kind: "connector_call",
        idempotencyKey: `countdown-answer-${suffix}-${answers++}`,
        status: "completed",
        request: { "3": { toolName: "agent_run" } },
        result: { content: [{ type: "text", text: JSON.stringify({ id: agentRunId, status }) }] },
      },
    });
  }

  /** The agent finishes each wake it was given, as a real turn would. */
  async function finishWakes(threadId: string) {
    await prisma.run.updateMany({
      where: { threadId, status: "queued", trigger: "recruiting_research" },
      data: { status: "completed" },
    });
  }

  async function wakes(threadId: string) {
    return prisma.run.findMany({
      where: { threadId, trigger: "recruiting_research" },
      orderBy: { createdAt: "asc" },
      select: { task: { select: { prompt: true } } },
    });
  }

  it("reports progress each time a search's countdown runs out, then ends with the search", async () => {
    const { bot, thread, turn } = await conversation();
    const agentRunId = `agent_run_${suffix}`;
    const jobs = { enqueue: vi.fn(async () => undefined) };
    const payload = { threadId: thread.id, botId: bot.id, agentRunId };
    await answer(turn.id, agentRunId, "running");
    const started = await startWorkEstimate(prisma, turn, {
      ref: agentRunId,
      kind: "search",
      people: 100,
    });
    expect(started?.estimateMs).toBe(2 * MINUTE);
    const t0 = Date.parse(started!.startedAt);
    const shown = await currentWorkEstimate(prisma, { spaceId, threadId: thread.id }, t0 + MINUTE);
    expect(shown).toMatchObject({ kind: "search", people: 100, estimateMs: 2 * MINUTE });

    // One minute in, the recruiter wrote moments ago: the quiet check-in waits for them.
    await waitForRecruitingAgentRun({ prisma, jobs }, payload, t0 + MINUTE);
    expect(await wakes(thread.id)).toHaveLength(0);

    // The 2-minute countdown runs out, two minutes after the recruiter asked: one progress line.
    await waitForRecruitingAgentRun({ prisma, jobs }, payload, t0 + 2.5 * MINUTE);
    let woken = await wakes(thread.id);
    expect(woken).toHaveLength(1);
    expect(woken[0]?.task?.prompt).toContain("estimated 2 minutes are up");
    await finishWakes(thread.id);
    await answer(turn.id, agentRunId, "running");

    // Still inside the second countdown and the recruiter wrote under five minutes ago: quiet.
    await waitForRecruitingAgentRun({ prisma, jobs }, payload, t0 + 3.5 * MINUTE);
    expect(await wakes(thread.id)).toHaveLength(1);

    // The second countdown runs out: a second progress line.
    await waitForRecruitingAgentRun({ prisma, jobs }, payload, t0 + 4.5 * MINUTE);
    woken = await wakes(thread.id);
    expect(woken).toHaveLength(2);
    expect(woken[1]?.task?.prompt).toContain("estimated 2 minutes are up");
    await finishWakes(thread.id);
    await answer(turn.id, agentRunId, "running");

    // Later, with the recruiter quiet, a check-in inside the third countdown stays quiet.
    await waitForRecruitingAgentRun({ prisma, jobs }, payload, t0 + 5.5 * MINUTE);
    woken = await wakes(thread.id);
    expect(woken).toHaveLength(3);
    expect(woken[2]?.task?.prompt).not.toContain("minutes are up");
    await finishWakes(thread.id);

    // The search finishes: no more wakes from the job, and the countdown is gone.
    await answer(turn.id, agentRunId, "completed");
    await waitForRecruitingAgentRun({ prisma, jobs }, payload, t0 + 6 * MINUTE);
    expect(await wakes(thread.id)).toHaveLength(3);
    expect(
      await currentWorkEstimate(prisma, { spaceId, threadId: thread.id }, t0 + 6 * MINUTE),
    ).toBeNull();
  });

  it("reports progress once per run-out countdown for background research", async () => {
    const { bot, thread, turn } = await conversation();
    const taskId = `research-${suffix}`;
    const jobs = { enqueue: vi.fn(async () => undefined) };
    const started = await startWorkEstimate(prisma, turn, {
      ref: `research:${taskId}`,
      kind: "search",
      people: 300,
    });
    expect(started?.estimateMs).toBe(10 * MINUTE);
    const t0 = Date.parse(started!.startedAt);
    const run = { spaceId, threadId: thread.id, botId: bot.id, userId };
    const tick = (at: number) =>
      wakeForResearchCountdown({ prisma, jobs }, { id: taskId, roleId: "role" }, run, at);

    await tick(t0 + 5 * MINUTE);
    expect(await wakes(thread.id)).toHaveLength(0);
    await tick(t0 + 10.5 * MINUTE);
    await tick(t0 + 11 * MINUTE);
    let woken = await wakes(thread.id);
    expect(woken).toHaveLength(1);
    expect(woken[0]?.task?.prompt).toContain("estimated 10 minutes are up");
    await finishWakes(thread.id);
    await tick(t0 + 20.5 * MINUTE);
    woken = await wakes(thread.id);
    expect(woken).toHaveLength(2);
  });

  it("ends an agent's wait on background work when the countdown runs out", async () => {
    const { bot, thread, turn } = await conversation();
    const agentRunId = `agent_run_wait_${suffix}`;
    const jobs = { enqueue: vi.fn(async () => undefined) };
    await answer(turn.id, agentRunId, "running");
    const started = await startWorkEstimate(prisma, turn, {
      ref: agentRunId,
      kind: "search",
      people: 100,
    });
    const scope = { spaceId, threadId: thread.id };
    const asked: Array<number | undefined> = [];
    // The agent asks for the tool's default 10 minutes; the wait ends with the 2-minute countdown.
    let now = Date.parse(started!.startedAt) + 1_000;
    const result = await waitWithCountdown(
      prisma,
      scope,
      600,
      async (timeoutSeconds) => {
        asked.push(timeoutSeconds);
        now += (timeoutSeconds ?? 0) * 1_000;
        return { timedOut: true };
      },
      () => now,
    );
    expect(asked[0]).toBeGreaterThan(100);
    expect(asked[0]).toBeLessThanOrEqual(122);
    expect(result).toMatchObject({ countdown: expect.stringContaining("about 2 minutes ran out") });

    // The agent reported in its own turn, so the follow-up job adds no second line for it.
    await waitForRecruitingAgentRun(
      { prisma, jobs },
      { threadId: thread.id, botId: bot.id, agentRunId },
      now + 10_000,
    );
    const woken = await wakes(thread.id);
    expect(woken.every((wake) => !wake.task?.prompt.includes("minutes are up"))).toBe(true);

    // A shorter wait than the countdown is left as asked, with no report.
    const short = await waitWithCountdown(
      prisma,
      scope,
      30,
      async (timeoutSeconds) => {
        asked.push(timeoutSeconds);
        return { timedOut: true };
      },
      () => now + 20_000,
    );
    expect(asked[1]).toBe(30);
    expect(short).not.toHaveProperty("countdown");
  });

  it("keeps one countdown across waves of the same search", async () => {
    const { bot, thread, turn } = await conversation();
    const actor: Actor = {
      userId,
      spaceId,
      email: `${userId}@example.test`,
      isDeploymentOwner: false,
    };
    const asked = await prisma.message.findFirstOrThrow({ where: { threadId: thread.id } });
    const { role } = await createRecruitingRole(prisma, actor, {
      sourceThreadId: thread.id,
      expectedRevision: 0,
      title: "Synthetic role",
      sourceRefs: [
        {
          id: "source-jd",
          kind: "original_material",
          anchor: { kind: "message", messageId: asked.id, locator: "text:0" },
          readState: "read",
          readAt: "2026-10-23T00:00:00.000Z",
        },
      ],
      preferences: [],
      definitionQuestions: [],
      criteria: [],
    });
    await prisma.thread.update({
      where: { id: thread.id },
      data: { activeRecruitingRoleId: role.id },
    });
    const save = (count: number, from: number) =>
      prisma.recruitingCandidate.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          roleId: role.id,
          candidateKey: `person-${from + i}`,
        })),
      });
    await save(10, 0);
    const scope = { spaceId, threadId: thread.id };
    const jobs = { enqueue: vi.fn(async () => undefined) };

    // The first wave asks for 200 people: a 5-minute countdown toward 210 in Results.
    const first = await startWorkEstimate(prisma, turn, {
      ref: `agent_run_wave1_${suffix}`,
      kind: "search",
      people: 200,
    });
    expect(first?.estimateMs).toBe(5 * MINUTE);
    const t0 = Date.parse(first!.startedAt);

    // Nine people later the agent starts the next wave for the remaining 191: no new note,
    // and the recruiter's countdown keeps running from where it was.
    await save(9, 10);
    const waveId = `agent_run_wave2_${suffix}`;
    await answer(turn.id, waveId, "running");
    const second = await startWorkEstimate(prisma, turn, {
      ref: waveId,
      kind: "search",
      people: 191,
    });
    expect(second).toBeNull();
    const shown = await currentWorkEstimate(prisma, scope, t0 + 3 * MINUTE);
    expect(shown).toMatchObject({
      people: 200,
      estimateMs: 5 * MINUTE,
      startedAt: first!.startedAt,
    });

    // When the first countdown runs out, the recruiter hears about it once.
    const payload = { threadId: thread.id, botId: bot.id, agentRunId: waveId };
    await waitForRecruitingAgentRun({ prisma, jobs }, payload, t0 + 5.5 * MINUTE);
    const woken = await wakes(thread.id);
    expect(woken).toHaveLength(1);
    expect(woken[0]?.task?.prompt).toContain("estimated 5 minutes are up");

    // The recruiter asks again before that target is met: a new ask with its own countdown.
    await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "再找 100 个人" }],
      },
    });
    const again = await startWorkEstimate(prisma, turn, {
      ref: `agent_run_wave3_${suffix}`,
      kind: "search",
      people: 100,
    });
    expect(again?.estimateMs).toBe(2 * MINUTE);

    // A new ask after the target is met starts its own countdown too.
    await save(191, 19);
    const next = await startWorkEstimate(prisma, turn, {
      ref: `agent_run_wave4_${suffix}`,
      kind: "search",
      people: 100,
    });
    expect(next?.estimateMs).toBe(2 * MINUTE);
  });
});
