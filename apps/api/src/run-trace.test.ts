import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { readRunTrace } from "./run-trace.js";

const actor: Actor = {
  userId: "user",
  spaceId: "space",
  email: "staff@wekruit.com",
  isDeploymentOwner: true,
};
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
function setup() {
  const run = {
    id: "run",
    status: "completed",
    startedAt: at(0),
    createdAt: at(0),
    completedAt: at(10),
    threadId: "thread",
  };
  const event = (id: string, type: string, seconds: number, payload: object) => ({
    id,
    type,
    createdAt: at(seconds),
    payload,
  });
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ email: "staff@wekruit.com", emailVerified: true }),
    },
    run: { findFirst: vi.fn().mockResolvedValue(run) },
    event: {
      findMany: vi.fn().mockResolvedValue([
        event("start", "agent.tool.called", 1, {
          executionId: "call",
          name: "web_search",
          argsSummary: "private",
        }),
        event("end", "agent.tool.completed", 4, {
          executionId: "call",
          name: "web_search",
          durationMs: 3000,
          outcome: "error",
          error: "unavailable",
        }),
        event("handoff", "group.handoff", 5, {
          fromBotId: "main",
          toBotId: "sourcing",
          text: "private",
        }),
        event("retry", "run.requeued", 6, {}),
      ]),
    },
    usageRecord: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "usage",
          callId: "existing-call",
          provider: "fake",
          model: "fake-model",
          createdAt: at(8),
          totalTokens: 40,
          costUsd: 0.01,
        },
      ]),
    },
  };
  return { prisma, db: prisma as unknown as PrismaClient };
}
it("denies callers without both explicit diagnostics and deployment ownership", async () => {
  const { db, prisma } = setup();
  await expect(
    readRunTrace(db, actor, { runId: "run", includeDiagnostics: false }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    readRunTrace(
      db,
      { ...actor, isDeploymentOwner: false },
      { runId: "run", includeDiagnostics: true },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(prisma.run.findFirst).not.toHaveBeenCalled();
});
it("scopes the run, events and usage and returns measured durations without private payloads", async () => {
  const { db, prisma } = setup();
  const trace = await readRunTrace(db, actor, { runId: "run", includeDiagnostics: true });
  expect(prisma.run.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "run", spaceId: "space", userId: "user" } }),
  );
  expect(prisma.event.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ spaceId: "space", threadId: "thread", runId: "run" }),
    }),
  );
  expect(prisma.usageRecord.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { spaceId: "space", userId: "user", runId: "run", unit: "tokens" },
    }),
  );
  expect(trace.rows).toEqual([
    expect.objectContaining({
      kind: "tool",
      label: "web_search",
      durationMs: 3000,
      status: "failed",
    }),
    expect.objectContaining({ kind: "handoff", label: "main → sourcing", durationMs: null }),
    expect.objectContaining({ kind: "retry", label: "Retry", durationMs: null }),
    expect.objectContaining({
      kind: "model",
      label: "fake / fake-model",
      durationMs: null,
      tokens: 40,
      costUsd: 0.01,
    }),
  ]);
  expect(JSON.stringify(trace)).not.toContain("private");
});
it("does not read any trace data for a run outside the caller's account", async () => {
  const { db, prisma } = setup();
  prisma.run.findFirst.mockResolvedValue(null);
  await expect(
    readRunTrace(db, actor, { runId: "run", includeDiagnostics: true }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(prisma.event.findMany).not.toHaveBeenCalled();
  expect(prisma.usageRecord.findMany).not.toHaveBeenCalled();
});

it("keeps calls with missing correlation ids and native retry progress visible", async () => {
  const { db, prisma } = setup();
  prisma.event.findMany.mockResolvedValue([
    {
      id: "uncorrelated",
      type: "agent.tool.called",
      createdAt: at(1),
      payload: { name: "read_file" },
    },
    {
      id: "retrying",
      type: "thread.progress",
      createdAt: at(2),
      payload: { phase: "retrying", text: "private" },
    },
    {
      id: "child",
      type: "thread.subagent",
      createdAt: at(3),
      payload: { agentId: "child", name: "Research", status: "running", task: "private" },
    },
  ]);
  const trace = await readRunTrace(db, actor, { runId: "run", includeDiagnostics: true });
  expect(trace.rows.slice(0, 3)).toEqual([
    expect.objectContaining({ kind: "tool", label: "read_file", durationMs: null }),
    expect.objectContaining({ kind: "retry", label: "Retry" }),
    expect.objectContaining({ kind: "handoff", label: "Research" }),
  ]);
  expect(JSON.stringify(trace)).not.toContain("private");
});

it("keeps the recorded model retry count after live progress is pruned", async () => {
  const { db, prisma } = setup();
  prisma.event.findMany.mockResolvedValue([
    { id: "done", type: "run.completed", createdAt: at(10), payload: { modelRetries: 2 } },
  ]);
  const trace = await readRunTrace(db, actor, { runId: "run", includeDiagnostics: true });
  expect(trace.rows.at(-1)).toMatchObject({
    kind: "retry",
    label: "2 model retries",
    durationMs: null,
    status: "completed",
  });
});

it("includes native peer-message handoffs without exposing exchanged task text", async () => {
  const { db, prisma } = setup();
  prisma.event.findMany.mockResolvedValue([
    {
      id: "sent",
      botId: "coordinator",
      type: "thread.message.created",
      createdAt: at(4),
      payload: {
        blocks: [
          { kind: "text", text: "private" },
          {
            kind: "bot_message_sent",
            toBotId: "research",
            toBotName: "Research",
            intent: "request",
            text: "private",
          },
        ],
      },
    },
  ]);
  const trace = await readRunTrace(db, actor, { runId: "run", includeDiagnostics: true });
  expect(trace.rows[0]).toMatchObject({
    kind: "handoff",
    label: "coordinator → research",
    durationMs: null,
  });
  expect(JSON.stringify(trace)).not.toContain("private");
});

it("joins measured model timing only by exact call id, retaining legacy unknown durations", async () => {
  const { db, prisma } = setup();
  prisma.event.findMany.mockResolvedValue([
    {
      id: "timing",
      type: "usage.recorded",
      createdAt: at(4),
      payload: {
        callId: "call-1",
        startedAt: at(1).toISOString(),
        durationMs: 3000,
        outcome: "failed",
      },
    },
  ]);
  prisma.usageRecord.findMany.mockResolvedValue([
    {
      id: "usage",
      callId: "call-1",
      provider: "fake",
      model: "fake-model",
      createdAt: at(8),
      totalTokens: null,
      costUsd: null,
    },
    {
      id: "legacy",
      callId: "old-call",
      provider: "fake",
      model: "fake-model",
      createdAt: at(9),
      totalTokens: 4,
      costUsd: 0.01,
    },
  ]);
  const trace = await readRunTrace(db, actor, { runId: "run", includeDiagnostics: true });
  expect(trace.rows).toEqual([
    expect.objectContaining({
      id: "usage",
      kind: "model",
      startedAt: at(1).toISOString(),
      durationMs: 3000,
      status: "failed",
      tokens: null,
      costUsd: null,
    }),
    expect.objectContaining({ id: "legacy", durationMs: null, status: "unknown" }),
  ]);
});
it("rejects malformed timing instead of inventing a model duration", async () => {
  const { db, prisma } = setup();
  prisma.event.findMany.mockResolvedValue([
    {
      id: "timing",
      type: "usage.recorded",
      createdAt: at(4),
      payload: { callId: "call-1", startedAt: "bad-date", durationMs: -1, outcome: "completed" },
    },
  ]);
  prisma.usageRecord.findMany.mockResolvedValue([
    {
      id: "usage",
      callId: "call-1",
      provider: "fake",
      model: "fake-model",
      createdAt: at(8),
      totalTokens: 40,
      costUsd: 0.01,
    },
  ]);
  expect(
    (await readRunTrace(db, actor, { runId: "run", includeDiagnostics: true })).rows[0],
  ).toMatchObject({ durationMs: null, startedAt: at(8).toISOString() });
});

it.each([
  { email: "external@example.test", emailVerified: true },
  { email: "staff@wekruit.com", emailVerified: false },
  { email: "staff@wekruit.com.evil.test", emailVerified: true },
])(
  "denies token traces even to a deployment owner without verified operator membership (%j)",
  async (user) => {
    const { db, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue(user);
    await expect(
      readRunTrace(db, actor, { runId: "run", includeDiagnostics: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prisma.run.findFirst).not.toHaveBeenCalled();
    expect(prisma.usageRecord.findMany).not.toHaveBeenCalled();
  },
);
