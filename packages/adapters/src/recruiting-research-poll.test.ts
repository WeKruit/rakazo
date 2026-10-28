import type { ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  pollRecruitingResearch,
  RECRUITING_RESEARCH_POLL_MAX_ATTEMPTS,
  recruitingResearchInFlight,
  recruitingResearchWakeNonce,
  trackDirectRecruitingResearch,
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
  stoppedInTx?: boolean;
  latestReply?: string | null;
  partialWakes?: Array<{ clientNonce: string; status: string }>;
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
    recruitingResearchAction: { count: vi.fn(async () => 1) },
    recruitingResearchTask: { count: vi.fn(async () => (options.stoppedInTx ? 0 : 1)) },
  };
  const prisma = {
    recruitingResearchTask: {
      findFirst: vi.fn(async () => (options.task === null ? null : { ...task, ...options.task })),
    },
    run: {
      findFirst: vi.fn(async () => (options.wokenAlready ? { id: "wake-existing" } : null)),
      findMany: vi.fn(async () => options.partialWakes ?? []),
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
  it("records the credits of research started directly, once per increase", async () => {
    const f = fixture({
      provider: { structuredContent: { ...working.structuredContent, credits_used: 12 } },
    });
    const ledger = {
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { quantity: 5 } })),
      createMany: vi.fn(async () => ({ count: 1 })),
    };
    Object.assign(f.prisma, {
      recruitingResearchAction: { count: ledger.count },
      usageRecord: { aggregate: ledger.aggregate, createMany: ledger.createMany },
      mcpServer: { findFirst: vi.fn(async () => ({ slug: "research-source" })) },
    });
    await pollRecruitingResearch(f.deps, { taskId: "task" });
    expect(ledger.createMany).toHaveBeenCalledExactlyOnceWith({
      data: [
        expect.objectContaining({
          unit: "credits",
          quantity: 7,
          operationId: "task",
          callId: "credits:task:12",
          provider: "research-source",
        }),
      ],
      skipDuplicates: true,
    });
    ledger.count.mockResolvedValueOnce(1);
    ledger.createMany.mockClear();
    await pollRecruitingResearch(f.deps, { taskId: "task" });
    expect(ledger.createMany).not.toHaveBeenCalled();
  });

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

  it("tells the owner once when it stops following a task the provider never finished", async () => {
    const onStalled = vi.fn(async () => undefined);
    const working1 = fixture({ provider: working });
    await pollRecruitingResearch({ ...working1.deps, onStalled }, { taskId: "task", attempt: 3 });
    expect(onStalled).not.toHaveBeenCalled();
    const exhausted = fixture({ provider: working });
    await pollRecruitingResearch(
      { ...exhausted.deps, onStalled },
      { taskId: "task", attempt: RECRUITING_RESEARCH_POLL_MAX_ATTEMPTS - 1 },
    );
    expect(onStalled).toHaveBeenCalledExactlyOnceWith(task.createdByRun);
  });

  it("narrows research in flight to what one bot started in one conversation", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      recruitingResearchTask: { findMany },
      externalEffect: { findFirst: vi.fn() },
      run: { findFirst: vi.fn() },
    };
    await expect(
      recruitingResearchInFlight(prisma as never, "role", Date.now(), {
        botId: "bot",
        threadId: "thread",
      }),
    ).resolves.toBe(false);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          roleId: "role",
          createdByRun: { botId: "bot", threadId: "thread" },
        }),
      }),
    );
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

  it("ignores a research that finishes after the conversation was stopped", async () => {
    // Stopped before the probe: the closed task is never read at the provider again.
    const closed = fixture({ provider: completed, task: { state: "closed" } });
    await pollRecruitingResearch(closed.deps, { taskId: "task" });
    expect(closed.calls).toHaveLength(0);
    expect(closed.runs).toHaveLength(0);
    expect(closed.enqueue).not.toHaveBeenCalled();
    // Stopped while the probe was in flight: the check under the thread lock wins.
    for (const provider of [
      completed,
      { structuredContent: { ...working.structuredContent, progress: { rows: 40 } } },
    ]) {
      const racing = fixture({ provider, stoppedInTx: true });
      await pollRecruitingResearch(racing.deps, { taskId: "task" });
      expect(racing.runs).toHaveLength(0);
      expect(racing.tx.task.create).not.toHaveBeenCalled();
      expect(racing.enqueue).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue" }),
      );
    }
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

describe("streaming a long research into Results", () => {
  const progress = (rows: number) => ({
    structuredContent: {
      task_id: "provider-task",
      state: "working",
      done: false,
      progress: { rows, target: 100 },
    },
  });

  it("wakes the conversation to save people while the research is still working", async () => {
    const f = fixture({ provider: progress(25) });
    await pollRecruitingResearch(f.deps, { taskId: "task" });
    expect(f.runs).toEqual([
      expect.objectContaining({ trigger: "recruiting_research", clientNonce: `${nonce}:rows:25` }),
    ]);
    const prompt = vi.mocked(f.tx.task.create).mock.calls[0]![0 as never] as never as {
      data: { prompt: string };
    };
    expect(prompt.data.prompt).toContain("still working");
    expect(prompt.data.prompt).toContain("save_results");
    // Polling continues toward the final wake.
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "recruiting_research.poll" }),
    );
  });

  it("waits for enough new people and never stacks partial wakes", async () => {
    const few = fixture({
      provider: progress(30),
      partialWakes: [{ clientNonce: `${nonce}:rows:20`, status: "completed" }],
    });
    await pollRecruitingResearch(few.deps, { taskId: "task" });
    expect(few.runs).toHaveLength(0);
    const busy = fixture({
      provider: progress(80),
      partialWakes: [{ clientNonce: `${nonce}:rows:20`, status: "running" }],
    });
    await pollRecruitingResearch(busy.deps, { taskId: "task" });
    expect(busy.runs).toHaveLength(0);
    const enough = fixture({
      provider: progress(45),
      partialWakes: [{ clientNonce: `${nonce}:rows:20`, status: "completed" }],
    });
    await pollRecruitingResearch(enough.deps, { taskId: "task" });
    expect(enough.runs).toEqual([expect.objectContaining({ clientNonce: `${nonce}:rows:45` })]);
  });

  it("tells a research sent straight to the provider how to read its rows", async () => {
    const f = fixture({ provider: completed });
    f.tx.recruitingResearchAction.count.mockResolvedValue(0);
    await pollRecruitingResearch(f.deps, { taskId: "task" });
    const prompt = vi.mocked(f.tx.task.create).mock.calls[0]![0 as never] as never as {
      data: { prompt: string };
    };
    expect(prompt.data.prompt).toContain("get_rows on the same research (task provider-task)");
    expect(prompt.data.prompt).toContain("save_results");
  });
});

describe("trackDirectRecruitingResearch", () => {
  const route = { connectorId: "mcp", resourceId: "autumn", toolName: "research" };
  const accepted = { structuredContent: { task_id: "provider-1", status: "accepted" } };
  function deps(
    options: {
      endpoint?: string;
      roleId?: string | null;
      taskRole?: string;
      stopped?: boolean;
    } = {},
  ) {
    const upsert = vi.fn(async ({ create }: { create: { roleId: string } }) => ({
      id: "local-task",
      roleId: options.taskRole ?? create.roleId,
      state: "active",
    }));
    const enqueue = vi.fn(async () => undefined);
    const prisma = {
      mcpServer: {
        findFirst: vi.fn(async () => ({
          id: "autumn",
          revision: 3,
          transport: "streamable_http",
          endpoint: options.endpoint ?? "https://api.autumn.ai/mcp",
        })),
      },
      run: {
        // The lookup only matches a live run; a stopped run is not found.
        findFirst: vi.fn(async () =>
          options.stopped
            ? null
            : {
                id: "run-1",
                thread: {
                  activeRecruitingRoleId: options.roleId === undefined ? "role" : options.roleId,
                },
              },
        ),
      },
      recruitingRole: { findFirst: vi.fn(async () => ({ id: "role" })) },
      recruitingResearchTask: { upsert, update: vi.fn() },
    };
    return {
      deps: {
        prisma: prisma as unknown as PrismaClient,
        jobs: { enqueue, cancel: vi.fn(async () => undefined), close: vi.fn() },
      },
      upsert,
      enqueue,
    };
  }
  const context = { spaceId: "space", userId: "owner", runId: "run-1" };

  it("records an accepted research on the role and polls it in the background", async () => {
    const f = deps();
    await expect(
      trackDirectRecruitingResearch(f.deps, context, route, { prompt: "find" }, accepted),
    ).resolves.toBe("local-task");
    expect(f.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          mcpServerId: "autumn",
          serverRevision: 3,
          providerTaskId: "provider-1",
          roleId: "role",
          createdByRunId: "run-1",
        },
      }),
    );
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { taskId: "local-task" } }),
    );
  });

  it("leaves other services, role-less chats and other roles' tasks alone", async () => {
    const other = deps({ endpoint: "https://example.test/mcp" });
    await expect(
      trackDirectRecruitingResearch(other.deps, context, route, { prompt: "x" }, accepted),
    ).resolves.toBeNull();
    const noRole = deps({ roleId: null });
    await expect(
      trackDirectRecruitingResearch(noRole.deps, context, route, { prompt: "x" }, accepted),
    ).resolves.toBeNull();
    const elsewhere = deps({ taskRole: "other-role" });
    await expect(
      trackDirectRecruitingResearch(elsewhere.deps, context, route, { prompt: "x" }, accepted),
    ).resolves.toBeNull();
    expect(elsewhere.enqueue).not.toHaveBeenCalled();
    const read = deps();
    await expect(
      trackDirectRecruitingResearch(
        read.deps,
        context,
        { ...route, toolName: "get_task" },
        { task_id: "provider-1" },
        accepted,
      ),
    ).resolves.toBeNull();
    expect(read.upsert).not.toHaveBeenCalled();
  });

  it("never arms a background follow-up from a run that was stopped", async () => {
    const f = deps({ stopped: true });
    await expect(
      trackDirectRecruitingResearch(f.deps, context, route, { prompt: "find" }, accepted),
    ).resolves.toBeNull();
    const findRun = vi.mocked(
      (f.deps.prisma as unknown as { run: { findFirst: () => unknown } }).run.findFirst,
    );
    expect(findRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: expect.not.arrayContaining(["cancelled"]) },
        }),
      }),
    );
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
