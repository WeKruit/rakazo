import type { BackgroundJob } from "@rakazo/adapter-kit";
import type { MessageBlock, PollBlock } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { canvasOf, changeCanvas, createDb, pollOf, votePoll } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePollAndWake } from "./poll-close.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("poll votes and close (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `poll-org-${suffix}`;
  const spaceId = `poll-space-${suffix}`;
  const userId = `poll-user-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const enqueued: BackgroundJob[] = [];
  const events = { notify: async () => undefined } as unknown as ThreadEvents;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: "Poll tester", email: `${userId}@example.test` },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Poll Org", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
    await close();
  });

  async function fixture(includeTeam: boolean) {
    const [main, sourcer] = await Promise.all(
      ["Main", "Sourcer"].map((name) =>
        prisma.bot.create({ data: { spaceId, userId, name, color: "blue" } }),
      ),
    );
    const group = await prisma.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: "Role",
        members: { create: [{ botId: main!.id }, { botId: sourcer!.id }] },
      },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    const poll: PollBlock = {
      kind: "poll",
      pollId: `poll-${thread.id}`,
      question: "Which title first?",
      options: [
        { id: "1", label: "Staff engineer" },
        { id: "2", label: "Tech lead" },
      ],
      multiple: false,
      includeTeam,
      closesAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      status: "open",
      votes: [],
    };
    const message = await prisma.message.create({
      data: { threadId: thread.id, seq: 0, role: "bot", botId: main!.id, blocks: [poll] },
    });
    return { main: main!, sourcer: sourcer!, thread, poll, message };
  }

  it("counts the person's vote, waits for the team, then closes once and wakes the asker", async () => {
    const f = await fixture(true);
    const mine = await votePoll(prisma, {
      threadId: f.thread.id,
      pollId: f.poll.pollId,
      vote: { voter: "user", voterId: userId, name: "Poll tester", optionIds: ["2"] },
    });
    expect(mine.ok && mine.complete).toBe(false);
    const asker = await votePoll(prisma, {
      threadId: f.thread.id,
      pollId: f.poll.pollId,
      vote: { voter: "bot", voterId: f.main.id, name: "Main", optionIds: ["1"] },
    });
    expect(asker.ok).toBe(false);
    const team = await votePoll(prisma, {
      threadId: f.thread.id,
      pollId: f.poll.pollId,
      vote: { voter: "bot", voterId: f.sourcer.id, name: "Sourcer", optionIds: ["2"] },
    });
    expect(team.ok && team.complete).toBe(true);

    const deps = {
      prisma,
      events,
      jobs: { enqueue: async (job: BackgroundJob) => void enqueued.push(job) },
    };
    const payload = { messageId: f.message.id, pollId: f.poll.pollId };
    await closePollAndWake(deps, payload);
    await closePollAndWake(deps, payload);
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: f.message.id } });
    expect(pollOf(stored.blocks as MessageBlock[], f.poll.pollId)?.status).toBe("closed");
    const runs = await prisma.run.findMany({
      where: { threadId: f.thread.id, trigger: "poll" },
      include: { task: true },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.botId).toBe(f.main.id);
    expect(runs[0]!.task.prompt).toContain("- Tech lead: 2 (Poll tester, Sourcer)");
    const late = await votePoll(prisma, {
      threadId: f.thread.id,
      pollId: f.poll.pollId,
      vote: { voter: "user", voterId: userId, name: "Poll tester", optionIds: ["1"] },
    });
    expect(late.ok).toBe(false);
  });

  it("refuses a poll from another conversation", async () => {
    const a = await fixture(false);
    const b = await fixture(false);
    const result = await votePoll(prisma, {
      threadId: b.thread.id,
      pollId: a.poll.pollId,
      vote: { voter: "user", voterId: userId, name: "Poll tester", optionIds: ["1"] },
    });
    expect(result.ok).toBe(false);
  });

  it("rewrites a canvas in place and keeps its app's data across revisions", async () => {
    const f = await fixture(false);
    const canvas = {
      kind: "canvas" as const,
      canvasId: `canvas-${f.thread.id}`,
      title: "Tracker",
      html: "<p>v1</p>",
      revision: 1,
    };
    await prisma.message.update({ where: { id: f.message.id }, data: { blocks: [canvas] } });
    const saved = await changeCanvas(prisma, {
      threadId: f.thread.id,
      canvasId: canvas.canvasId,
      change: { state: { done: ["a"] } },
    });
    expect(saved.ok).toBe(true);
    const rewritten = await changeCanvas(prisma, {
      threadId: f.thread.id,
      canvasId: canvas.canvasId,
      change: { html: "<p>v2</p>", title: "Tracker" },
    });
    expect(rewritten.ok && rewritten.block.revision).toBe(2);
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: f.message.id } });
    expect(canvasOf(stored.blocks as MessageBlock[], canvas.canvasId)).toMatchObject({
      html: "<p>v2</p>",
      state: { done: ["a"] },
    });
    const tooBig = await changeCanvas(prisma, {
      threadId: f.thread.id,
      canvasId: canvas.canvasId,
      change: { state: "x".repeat(70_000) },
    });
    expect(tooBig.ok).toBe(false);
  });
});
