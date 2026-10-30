import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  agentRunWaitTarget,
  RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX,
  runningAgentRunId,
  waitForRecruitingAgentRun,
} from "./recruiting-agent-run-wait.js";

const now = Date.parse("2026-10-30T20:00:00Z");
const payload = { threadId: "thread", botId: "sourcer", agentRunId: "agent_run_1" };
const answer = (id: string, status: string, runId = "agent_run_1") => ({
  id,
  result: { content: [{ type: "text", text: JSON.stringify({ id: runId, status }) }] },
});

function fixture(options: {
  answers: Array<ReturnType<typeof answer>>;
  busy?: boolean;
  woken?: boolean | "yielded";
  member?: boolean;
  talking?: boolean;
}) {
  const runCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: "wake" }));
  const taskCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: "task" }));
  const tx = {
    thread: { updateMany: vi.fn(async () => ({ count: 1 })) },
    run: {
      findFirst: vi.fn(async () => (options.busy ? { id: "busy" } : null)),
      findMany: vi.fn(async () =>
        options.woken ? [{ status: options.woken === "yielded" ? "cancelled" : "completed" }] : [],
      ),
      create: runCreate,
    },
    task: { create: taskCreate },
  };
  const prisma = {
    thread: {
      findUnique: vi.fn(async () => ({
        id: "thread",
        spaceId: "space",
        userId: "user",
        botId: null,
        groupId: "group",
      })),
    },
    chatGroupMember: {
      findFirst: vi.fn(async () => (options.member === false ? null : { botId: "sourcer" })),
    },
    externalEffect: { findMany: vi.fn(async () => options.answers) },
    message: { findFirst: vi.fn(async () => (options.talking ? { id: "message" } : null)) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  return { prisma: prisma as unknown as PrismaClient, jobs, runCreate, taskCreate };
}

describe("people-search agent runs that outlive their turn", () => {
  it("recognizes a run that is still working", () => {
    expect(runningAgentRunId(answer("e", "running").result)).toBe("agent_run_1");
    expect(runningAgentRunId(answer("e", "completed").result)).toBeUndefined();
    expect(runningAgentRunId({ id: "task_1", status: "running" })).toBeUndefined();
  });

  it("wakes the agent that started it to collect the run", async () => {
    const test = fixture({ answers: [answer("newest", "running"), answer("older", "running")] });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        botId: "sourcer",
        trigger: "recruiting_research",
        clientNonce: `${RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX}agent_run_1:newest`,
      }),
    });
    expect(test.taskCreate.mock.calls[0]?.[0].data.prompt).toContain(
      'Call agent_run with runId "agent_run_1" once',
    );
    // A run still going ends the wake quietly instead of holding the conversation.
    expect(test.taskCreate.mock.calls[0]?.[0].data.prompt).toContain(
      "end the turn with an empty reply",
    );
    expect(test.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue" }),
    );
  });

  it("stops once the newest answer says the run finished", async () => {
    const test = fixture({ answers: [answer("newest", "completed"), answer("older", "running")] });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.runCreate).not.toHaveBeenCalled();
    expect(test.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("ignores answers about other runs", async () => {
    const test = fixture({ answers: [answer("other", "running", "agent_run_2")] });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.runCreate).not.toHaveBeenCalled();
  });

  it("looks again later while the conversation is busy", async () => {
    const test = fixture({ answers: [answer("newest", "running")], busy: true });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.runCreate).not.toHaveBeenCalled();
    expect(test.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "recruiting_agent_run.wait",
        replaceKey: "recruiting_agent_run.wait:agent_run_1",
        availableAt: new Date(now + 60_000),
      }),
    );
  });

  it("waits while the recruiter is writing in the conversation", async () => {
    const test = fixture({ answers: [answer("newest", "running")], talking: true });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.runCreate).not.toHaveBeenCalled();
    expect(test.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "recruiting_agent_run.wait" }),
    );
  });

  it("wakes once per provider answer", async () => {
    const test = fixture({ answers: [answer("newest", "running")], woken: true });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.runCreate).not.toHaveBeenCalled();
    expect(test.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("wakes again after a wake gave way to the recruiter", async () => {
    const test = fixture({ answers: [answer("newest", "running")], woken: "yielded" });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientNonce: `${RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX}agent_run_1:newest:1`,
      }),
    });
    expect(
      agentRunWaitTarget(`${RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX}agent_run_1:newest:1`),
    ).toBe("agent_run_1");
    expect(agentRunWaitTarget("recruiting-research-wake:task:x")).toBeUndefined();
  });

  it("leaves the run alone when its agent left the conversation", async () => {
    const test = fixture({ answers: [answer("newest", "running")], member: false });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.runCreate).not.toHaveBeenCalled();
  });
});
