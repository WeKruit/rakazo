import type { ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  pollRecruitingResearch,
  RECRUITING_RESEARCH_POLL_MAX_ATTEMPTS,
  recruitingResearchWakeNonce,
} from "./recruiting-research-poll.js";

const owner = { spaceId: "space", userId: "owner" };
const task = {
  id: "task",
  state: "active",
  roleId: "role",
  providerTaskId: "provider-task",
  mcpServerId: "source",
  serverRevision: 2,
  role: owner,
  createdByRun: { ...owner, botId: "bot", threadId: "thread" },
};
const nonce = recruitingResearchWakeNonce("task", "provider-task");

function fixture(options: {
  task?: Record<string, unknown> | null;
  provider?: unknown;
  providerError?: boolean;
  wokenAlready?: boolean;
  wokenInTx?: boolean;
  latestReply?: string | null;
}) {
  const runs: Array<{ clientNonce: string; trigger: string }> = [];
  const runCreate = vi.fn(async ({ data }: { data: { clientNonce: string; trigger: string } }) => {
    runs.push(data);
    return { id: `wake-${runs.length}` };
  });
  const tx = {
    thread: { updateMany: vi.fn(async () => ({ count: 1 })) },
    bot: { findFirst: vi.fn(async () => ({ id: "bot" })) },
    run: {
      findFirst: vi.fn(async () => (options.wokenInTx ? { id: "wake-existing" } : null)),
      create: runCreate,
    },
    task: { create: vi.fn(async () => ({ id: "wake-task" })) },
  };
  const prisma = {
    recruitingResearchTask: {
      findFirst: vi.fn(async () => (options.task === null ? null : { ...task, ...options.task })),
    },
    run: {
      findFirst: vi.fn(async () => (options.wokenAlready ? { id: "wake-existing" } : null)),
    },
    externalEffect: {
      findFirst: vi.fn(async () => (options.latestReply ? { id: options.latestReply } : null)),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  };
  const calls: ConnectorCall[] = [];
  const connector = {
    describe: vi.fn(),
    discoverTools: vi.fn(),
    async *execute(call: ConnectorCall): AsyncIterable<ConnectorEvent> {
      calls.push(call);
      if (options.providerError) yield { type: "error", message: "offline" };
      else yield { type: "result", data: options.provider };
    },
  };
  const enqueue = vi.fn(async () => undefined);
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    jobs: { enqueue, cancel: vi.fn(async () => undefined), close: vi.fn() },
    connector,
  };
  return { deps, prisma, tx, calls, enqueue, runs };
}

const working = { structuredContent: { task_id: "provider-task", state: "working", done: false } };
const completed = {
  structuredContent: { task_id: "provider-task", state: "completed", done: true },
};

describe("pollRecruitingResearch", () => {
  it("probes with a free status read only and re-polls while the provider is working", async () => {
    const f = fixture({ provider: working });
    await pollRecruitingResearch(f.deps, { taskId: "task" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      route: {
        connectorId: "mcp",
        resourceId: "source",
        resourceRevision: 2,
        toolName: "get_task",
      },
      args: { task_id: "provider-task", wait_seconds: 0 },
    });
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "recruiting_research.poll",
        payload: { taskId: "task", attempt: 1 },
        replaceKey: "recruiting_research.poll:task",
        availableAt: expect.any(Date),
      }),
    );
    expect(f.runs).toHaveLength(0);
  });

  it("re-polls after a transport error without opening a run, and gives up at the cap", async () => {
    const failing = fixture({ providerError: true });
    await pollRecruitingResearch(failing.deps, { taskId: "task", attempt: 3 });
    expect(failing.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payload: { taskId: "task", attempt: 4 } }),
    );
    expect(failing.runs).toHaveLength(0);
    const exhausted = fixture({ provider: working });
    await pollRecruitingResearch(exhausted.deps, {
      taskId: "task",
      attempt: RECRUITING_RESEARCH_POLL_MAX_ATTEMPTS - 1,
    });
    expect(exhausted.enqueue).not.toHaveBeenCalled();
  });

  it("opens exactly one wake run carrying local ids only when the provider finishes", async () => {
    const f = fixture({ provider: completed });
    await pollRecruitingResearch(f.deps, { taskId: "task" });
    expect(f.runs).toEqual([
      expect.objectContaining({
        spaceId: "space",
        userId: "owner",
        botId: "bot",
        threadId: "thread",
        trigger: "recruiting_research",
        clientNonce: nonce,
      }),
    ]);
    const prompt = vi.mocked(f.tx.task.create).mock.calls[0]![0 as never] as never as {
      data: { prompt: string };
    };
    expect(prompt.data.prompt).toContain("Research task task for recruiting role role");
    expect(prompt.data.prompt).not.toContain("provider-task");
    expect(prompt.data.prompt).toContain("save every rows page");
    expect(prompt.data.prompt).toContain("including unassessed people");
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "wake-1" } }),
    );
  });

  it("never opens a second wake run or re-probes once the wake exists", async () => {
    const outside = fixture({ provider: completed, wokenAlready: true });
    await pollRecruitingResearch(outside.deps, { taskId: "task" });
    expect(outside.calls).toHaveLength(0);
    expect(outside.runs).toHaveLength(0);
    expect(outside.enqueue).not.toHaveBeenCalled();
    const raced = fixture({ provider: completed, wokenInTx: true });
    await pollRecruitingResearch(raced.deps, { taskId: "task" });
    expect(raced.runs).toHaveLength(0);
    expect(raced.enqueue).not.toHaveBeenCalled();
  });

  it("does nothing for a task that is finished, unowned or not the run's owner", async () => {
    for (const overrides of [
      { state: "completed" },
      { providerTaskId: null },
      { role: { spaceId: "other-space", userId: "owner" } },
    ]) {
      const f = fixture({ provider: completed, task: overrides });
      await pollRecruitingResearch(f.deps, { taskId: "task" });
      expect(f.calls).toHaveLength(0);
      expect(f.runs).toHaveLength(0);
      expect(f.enqueue).not.toHaveBeenCalled();
    }
    const missing = fixture({ provider: completed, task: null });
    await pollRecruitingResearch(missing.deps, { taskId: "task" });
    expect(missing.calls).toHaveLength(0);
  });

  it("wakes again when feedback continued the same provider task after an earlier wake", async () => {
    // Round 1 woke under the base nonce; a later reply on the same task is a new round.
    const f = fixture({ provider: completed, latestReply: "reply-effect" });
    const roundOneWoke = async ({ where }: { where: { clientNonce: string } }) =>
      where.clientNonce === nonce ? { id: "wake-round-1" } : null;
    f.prisma.run.findFirst.mockImplementation(roundOneWoke as never);
    f.tx.run.findFirst.mockImplementation(roundOneWoke as never);
    await pollRecruitingResearch(f.deps, { taskId: "task" });
    expect(f.runs).toEqual([
      expect.objectContaining({
        clientNonce: recruitingResearchWakeNonce("task", "provider-task", "reply-effect"),
      }),
    ]);
    expect(recruitingResearchWakeNonce("task", "provider-task", "reply-effect")).not.toBe(nonce);
    const where = vi.mocked(f.prisma.externalEffect.findFirst).mock.calls[0]![0 as never] as never;
    expect(JSON.stringify(where)).toContain('"reply"');
    expect(JSON.stringify(where)).toContain('"provider-task"');
    expect(JSON.stringify(where)).toContain('"space"');
  });

  it("ignores a provider answer about a different task", async () => {
    const f = fixture({
      provider: { structuredContent: { task_id: "forged", state: "completed", done: true } },
    });
    await pollRecruitingResearch(f.deps, { taskId: "task" });
    expect(f.runs).toHaveLength(0);
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "recruiting_research.poll" }),
    );
  });
});
