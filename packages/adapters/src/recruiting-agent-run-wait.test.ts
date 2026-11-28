import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  agentRunWaitTarget,
  RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX,
  rearmRecruitingAgentRunWaits,
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
  woken?: boolean;
  member?: boolean;
  talking?: boolean;
  /** The recruiter's countdown for this search, started this long before now. */
  countdown?: { startedMsAgo: number; estimateMs: number; reported?: number };
}) {
  // The inputs submitSessionInput wrote, read from the values of its one statement.
  const submitted: Array<{
    sessionId: string;
    kind: string;
    payload: { text: string; wakeKey?: string };
    trigger: string;
  }> = [];
  const tx = {
    thread: { updateMany: vi.fn(async () => ({ count: 1 })) },
    run: { findFirst: vi.fn(async () => null) },
    sessionInput: { findFirst: vi.fn(async () => (options.woken ? { id: "input" } : null)) },
    conversationSession: { createMany: vi.fn(async () => ({ count: 1 })) },
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      submitted.push({
        sessionId: String(values[0]),
        kind: String(values[3]),
        payload: JSON.parse(String(values[5])),
        trigger: String(values[6]),
      });
      return [{ id: "input", seq: submitted.length }];
    }),
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
    externalEffect: {
      findMany: vi.fn(async () => options.answers),
      findFirst: vi.fn(async (args: { where: { status: string } }) =>
        options.countdown && args.where.status === "running"
          ? {
              id: "estimate",
              request: {
                threadId: "thread",
                kind: "search",
                people: 500,
                estimateMs: options.countdown.estimateMs,
              },
              result: options.countdown.reported ? { reported: options.countdown.reported } : null,
              createdAt: new Date(now - options.countdown.startedMsAgo),
            }
          : null,
      ),
      updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
    },
    message: { findFirst: vi.fn(async () => (options.talking ? { id: "message" } : null)) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const events = { wakeSessions: vi.fn(async (_ids: Iterable<string>) => undefined) };
  return {
    prisma: prisma as unknown as PrismaClient,
    jobs,
    events,
    submitted,
    effectUpdate: prisma.externalEffect.updateMany,
  };
}

describe("people-search agent runs that outlive their turn", () => {
  it("recognizes a run that is still working", () => {
    expect(runningAgentRunId(answer("e", "running").result)).toBe("agent_run_1");
    expect(runningAgentRunId(answer("e", "completed").result)).toBeUndefined();
    expect(runningAgentRunId({ id: "task_1", status: "running" })).toBeUndefined();
    expect(
      agentRunWaitTarget(`${RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX}agent_run_1:newest:1`),
    ).toBe("agent_run_1");
    expect(agentRunWaitTarget("recruiting-research-wake:task:x")).toBeUndefined();
  });

  it("wakes the agent that started it with a follow-up in its session", async () => {
    const test = fixture({ answers: [answer("newest", "running"), answer("older", "running")] });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.submitted).toHaveLength(1);
    expect(test.submitted[0]).toMatchObject({
      sessionId: "thread:sourcer",
      // A follow-up waits for a turn in progress, which may collect the run itself.
      kind: "followUp",
      trigger: "recruiting_research",
      payload: { wakeKey: `${RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX}agent_run_1:newest` },
    });
    expect(test.submitted[0]?.payload.text).toContain("agent_run_1");
    expect(test.submitted[0]?.payload.text).toContain("An empty reply posts nothing.");
    expect(test.events.wakeSessions).toHaveBeenCalledWith(["thread:sourcer"]);
    expect(test.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("stops once the newest answer says the run finished", async () => {
    const test = fixture({ answers: [answer("newest", "completed"), answer("older", "running")] });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.submitted).toHaveLength(0);
    expect(test.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("ignores answers about other runs", async () => {
    const test = fixture({ answers: [answer("other", "running", "agent_run_2")] });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.submitted).toHaveLength(0);
  });

  it("waits while the recruiter is writing in the conversation", async () => {
    const test = fixture({ answers: [answer("newest", "running")], talking: true });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.submitted).toHaveLength(0);
    expect(test.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "recruiting_agent_run.wait" }),
    );
  });

  it("wakes once per provider answer", async () => {
    const test = fixture({ answers: [answer("newest", "running")], woken: true });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.submitted).toHaveLength(0);
    expect(test.jobs.enqueue).not.toHaveBeenCalled();
    expect(test.events.wakeSessions).not.toHaveBeenCalled();
  });

  it("leaves the run alone when its agent left the conversation", async () => {
    const test = fixture({ answers: [answer("newest", "running")], member: false });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.submitted).toHaveLength(0);
  });

  it("says once that the recruiter's countdown ran out", async () => {
    const countdown = { startedMsAgo: 11 * 60_000, estimateMs: 10 * 60_000 };
    const test = fixture({ answers: [answer("newest", "running")], countdown });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.submitted[0]?.payload.text).toContain("estimated 10 minutes are up");
    expect(test.effectUpdate).toHaveBeenCalledWith({
      where: { id: "estimate", status: "running" },
      data: { result: { reported: 1 } },
    });

    const reported = fixture({
      answers: [answer("newest", "running")],
      countdown: { ...countdown, reported: 1 },
    });
    await waitForRecruitingAgentRun(reported, payload, now);
    expect(reported.submitted[0]?.payload.text).not.toContain("are up");
  });

  it("says nothing about the countdown while it is still running", async () => {
    const test = fixture({
      answers: [answer("newest", "running")],
      countdown: { startedMsAgo: 3 * 60_000, estimateMs: 10 * 60_000 },
    });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.submitted[0]?.payload.text).not.toContain("are up");
    expect(test.effectUpdate).not.toHaveBeenCalled();
  });
  it("ends the countdown when the run finished", async () => {
    const test = fixture({ answers: [answer("newest", "completed")] });
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.effectUpdate).toHaveBeenCalledWith({
      where: { idempotencyKey: "work_estimate:agent_run_1", spaceId: "space", status: "running" },
      data: { status: "done" },
    });
  });

  it("leaves a search the recruiter stopped alone", async () => {
    const test = fixture({ answers: [answer("newest", "running")] });
    (test.prisma.externalEffect.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { where: { status: string } }) =>
        args.where.status === "cancelled" ? { id: "estimate" } : null,
    );
    await waitForRecruitingAgentRun(test, payload, now);
    expect(test.submitted).toHaveLength(0);
    expect(test.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("re-arms the follow-up of every search still running", async () => {
    const findMany = vi.fn(async (_args: unknown) => [
      {
        idempotencyKey: "work_estimate:agent_run_1",
        run: { threadId: "thread", botId: "sourcer" },
      },
    ]);
    const prisma = { externalEffect: { findMany } } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(async () => undefined) };
    expect(await rearmRecruitingAgentRunWaits({ prisma, jobs }, new Date(now), 50)).toBe(1);
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "recruiting_agent_run.wait",
        payload: { threadId: "thread", botId: "sourcer", agentRunId: "agent_run_1" },
        availableAt: new Date(now),
      }),
    );
  });
});
