import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  contactLookupCountdownNote,
  currentWorkEstimate,
  withWorkNote,
  workEstimateAfterAgentRun,
} from "./work-estimate.js";

const now = Date.parse("2026-10-30T20:00:00Z");
const run = { id: "run", spaceId: "space", threadId: "thread" };
const mcp = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });

function store(rows: Array<Record<string, unknown>> = []) {
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
