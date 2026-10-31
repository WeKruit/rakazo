import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  contactLookupCountdownNote,
  currentWorkEstimate,
  wakeForResearchCountdown,
  withWorkNote,
  workEstimateAfterAgentRun,
} from "./work-estimate.js";

const now = Date.parse("2026-10-30T20:00:00Z");
const run = { id: "run", spaceId: "space", threadId: "thread" };
const mcp = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });

function store(rows: Array<Record<string, unknown>> = [], saved = 0) {
  const create = vi.fn(async (_args: { data: Record<string, unknown> }) => ({
    createdAt: new Date(now),
  }));
  const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const prisma = {
    externalEffect: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => rows[0] ?? null),
      findMany: vi.fn(async () => rows),
      create,
      updateMany,
    },
    thread: { findUnique: vi.fn(async () => ({ activeRecruitingRoleId: "role" })) },
    recruitingCandidate: { count: vi.fn(async () => saved) },
  };
  return { prisma: prisma as unknown as PrismaClient, create, updateMany };
}

describe("countdowns for big work", () => {
  it("starts a countdown for a big search still running and tells the agent once", async () => {
    const test = store();
    const note = await workEstimateAfterAgentRun(
      test.prisma,
      run,
      mcp({ id: "agent_run_1", status: "running" }),
      { query: "Find 500 more USC alumni" },
    );
    expect(note).toContain("about 17 minutes");
    expect(note).toContain("email_when_done");
    expect(test.create.mock.calls[0]?.[0].data).toMatchObject({
      kind: "work_estimate",
      idempotencyKey: "work_estimate:agent_run_1",
      request: { kind: "search", people: 500, estimateMs: 17 * 60_000 },
    });
  });

  it("ends a search countdown once Results hold the people asked for", async () => {
    const row = {
      id: "e1",
      idempotencyKey: "work_estimate:agent_run_1",
      request: { kind: "search", people: 100, estimateMs: 5 * 60_000, roleId: "role", saved: 518 },
      result: null,
      createdAt: new Date(now),
      run: { status: "completed" },
    };
    const short = store([row], 600);
    expect(await currentWorkEstimate(short.prisma, run, now)).toMatchObject({ people: 100 });
    const reached = store([row], 630);
    expect(await currentWorkEstimate(reached.prisma, run, now)).toBeNull();
    expect(reached.updateMany).toHaveBeenCalledWith({
      where: { id: "e1", status: "running" },
      data: { status: "done" },
    });
  });

  it("records the role's saved count when a search starts", async () => {
    const test = store([], 518);
    await workEstimateAfterAgentRun(
      test.prisma,
      run,
      mcp({ id: "agent_run_1", status: "running" }),
      { query: "Find 100 more" },
    );
    expect(test.create.mock.calls[0]?.[0].data).toMatchObject({
      request: { people: 100, roleId: "role", saved: 518 },
    });
  });

  it("counts up for a small search without a note", async () => {
    const test = store();
    const note = await workEstimateAfterAgentRun(
      test.prisma,
      run,
      mcp({ id: "agent_run_1", status: "running" }),
      { query: "Find 30 nurses" },
    );
    expect(note).toBeNull();
    expect(test.create.mock.calls[0]?.[0].data).toMatchObject({
      request: { people: 30, estimateMs: null },
    });
  });

  it("ends the countdown once the run is collected", async () => {
    const test = store();
    await workEstimateAfterAgentRun(
      test.prisma,
      run,
      mcp({ id: "agent_run_1", status: "completed" }),
      {},
    );
    expect(test.create).not.toHaveBeenCalled();
    expect(test.updateMany).toHaveBeenCalledWith({
      where: { idempotencyKey: "work_estimate:agent_run_1", spaceId: "space", status: "running" },
      data: { status: "done" },
    });
  });

  it("shows a contact lookup only while its turn runs", async () => {
    const row = (status: string) => ({
      id: "e",
      idempotencyKey: "work_estimate:emails:run",
      request: { threadId: "thread", kind: "emails", people: 400, estimateMs: 20 * 60_000 },
      result: null,
      createdAt: new Date(now - 60_000),
      run: { status },
    });
    expect(
      await currentWorkEstimate(
        store([row("completed")]).prisma,
        { spaceId: "space", threadId: "thread" },
        now,
      ),
    ).toBeNull();
    expect(
      await currentWorkEstimate(
        store([row("running")]).prisma,
        { spaceId: "space", threadId: "thread" },
        now,
      ),
    ).toEqual({
      kind: "emails",
      people: 400,
      estimateMs: 20 * 60_000,
      startedAt: new Date(now - 60_000).toISOString(),
    });
  });

  it("asks for a progress line when a lookup's countdown runs out", async () => {
    const test = store([
      {
        id: "e",
        request: { threadId: "thread", kind: "emails", people: 400, estimateMs: 20 * 60_000 },
        result: null,
        createdAt: new Date(now - 21 * 60_000),
      },
    ]);
    expect(await contactLookupCountdownNote(test.prisma, run, now)).toContain(
      "how many emails were found so far",
    );
    expect(withWorkNote({ summary: {} }, "note")).toEqual({ summary: {}, countdown: "note" });
  });
});

describe("countdowns for background research", () => {
  const thread = { spaceId: "space", threadId: "thread", botId: "sourcer", userId: "user" };
  function research(startedMsAgo: number, options: { busy?: boolean; reported?: number } = {}) {
    const runCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: "wake" }));
    const taskCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: "t" }));
    const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
    const tx = {
      thread: { updateMany: vi.fn(async () => ({ count: 1 })) },
      run: {
        findFirst: vi.fn(async (args: { where: { clientNonce?: string } }) =>
          args.where.clientNonce ? null : options.busy ? { id: "busy" } : null,
        ),
        create: runCreate,
      },
      task: { create: taskCreate },
    };
    const prisma = {
      externalEffect: {
        findFirst: vi.fn(async () => ({
          id: "estimate",
          request: { threadId: "thread", kind: "search", people: 300, estimateMs: 10 * 60_000 },
          result: options.reported ? { reported: options.reported } : null,
          createdAt: new Date(now - startedMsAgo),
        })),
        updateMany,
      },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(async () => undefined) };
    return { prisma, jobs, runCreate, taskCreate, updateMany };
  }

  it("wakes the agent once to report when the countdown runs out", async () => {
    const test = research(11 * 60_000);
    await wakeForResearchCountdown(test, { id: "task", roleId: "role" }, thread, now);
    expect(test.runCreate.mock.calls[0]?.[0].data).toMatchObject({
      trigger: "recruiting_research",
      clientNonce: "work_estimate:research:task:1",
    });
    expect(String(test.taskCreate.mock.calls[0]?.[0].data.prompt)).toContain(
      "estimated 10 minutes are up",
    );
    expect(test.updateMany).toHaveBeenCalledWith({
      where: { id: "estimate", status: "running" },
      data: { result: { reported: 1 } },
    });
  });

  it("does nothing before the countdown ends, after it was reported, or while busy", async () => {
    for (const test of [
      research(4 * 60_000),
      research(11 * 60_000, { reported: 1 }),
      research(11 * 60_000, { busy: true }),
    ]) {
      await wakeForResearchCountdown(test, { id: "task", roleId: "role" }, thread, now);
      expect(test.runCreate).not.toHaveBeenCalled();
      expect(test.updateMany).not.toHaveBeenCalled();
    }
  });
});
