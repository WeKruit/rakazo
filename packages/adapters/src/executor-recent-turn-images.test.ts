import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { acquireComputerExecutionLease, provisionComputer } from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { RetiredModelCredentialError } from "./pi-oauth.js";
import type * as RecruitingContextModule from "./recruiting-context.js";
import { loadRecruitingRunContext } from "./recruiting-context.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: vi.fn(async () => null),
  provisionComputer: vi.fn(async () => ({ id: "computer-1", kind: "desktop" })),
}));

vi.mock("./recruiting-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RecruitingContextModule>()),
  loadRecruitingRunContext: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.mocked(loadRecruitingRunContext).mockClear();
  vi.mocked(acquireComputerExecutionLease).mockClear();
  vi.mocked(provisionComputer).mockClear();
});

const TEXT_ONLY_MODEL = "deepseek/deepseek-v4-flash-0731";
/** The events double of the most recent runWithModel call. */
let lastExecutorEvents:
  | { append: ReturnType<typeof vi.fn>; publishTransient: ReturnType<typeof vi.fn> }
  | undefined;
const VISION_MODEL = "openai/gpt-4o";

function historyMessages(): Array<{
  id: string;
  threadId: string;
  seq: number;
  role: string;
  runId: string;
  blocks: MessageBlock[];
  replyToMessageId: null;
  replyQuote: null;
  replyTo: null;
}> {
  return [
    {
      id: "current",
      threadId: "thread-1",
      seq: 2,
      role: "user",
      runId: "run-1",
      blocks: [{ kind: "text", text: "what was in the screenshot?" }],
      replyToMessageId: null,
      replyQuote: null,
      replyTo: null,
    },
    {
      id: "earlier",
      threadId: "thread-1",
      seq: 1,
      role: "user",
      runId: "run-0",
      blocks: [{ kind: "image", artifactId: "art-1", mimeType: "image/png", name: "shot.png" }],
      replyToMessageId: null,
      replyQuote: null,
      replyTo: null,
    },
  ];
}

async function runWithModel(
  modelId: string,
  switchModel?: { provider: string; modelId: string },
  backupReadFails = false,
  scripted = false,
  options: {
    /** This bot's latest finished run in the thread, as the thread load returns it. */
    previousRun?: { id: string; status: string };
    lastToolName?: string;
    /** Runtime events yielded before the final done. */
    events?: AgentRuntimeEvent[];
    trigger?: string;
    /** The routine's previous completed run and its final reply, as the scoped queries return them. */
    priorRoutineRun?: { id: string; completedAt: Date; replyText: string };
    /** Resolves tool discovery only when called; setup steps that run alongside it are observable. */
    discoverTools?: () => Promise<[]>;
    onEventFindFirst?: () => void;
    /** The thread's active recruiting role; enables the run-start recruiting context. */
    recruitingRoleId?: string;
    savedRecruitingCandidates?: number;
  } = {},
) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.trigger ?? "user",
    routineId: options.trigger === "routine" ? "routine-1" : null,
    leaseFence: 0,
  };
  const get = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    if (switchModel) {
      const onModelChange = (
        next as AgentRunRequest & {
          onModelChange?: (provider: string, modelId: string) => Promise<void>;
        }
      ).onModelChange;
      await onModelChange?.(switchModel.provider, switchModel.modelId);
    }
    for (const event of options.events ?? []) yield event;
    yield { type: "done" as const, text: "Done" };
  });
  const prisma = {
    // Early final replies on file-touching turns persist through one transaction on these rows.
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
    event: {
      create: vi.fn(async ({ data }: { data: object }) => ({ ...data, seq: 1 })),
      findFirst: vi.fn(async () => {
        options.onEventFindFirst?.();
        return options.lastToolName ? { payload: { name: options.lastToolName } } : null;
      }),
    },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () =>
        options.priorRoutineRun
          ? { id: options.priorRoutineRun.id, completedAt: options.priorRoutineRun.completedAt }
          : null,
      ),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 3,
        activeRecruitingRoleId: options.recruitingRoleId ?? null,
        runs: options.previousRun ? [options.previousRun] : [],
      })),
      update: vi.fn(async () => ({ nextMessageSeq: 4, nextEventSeq: 4 })),
    },
    message: {
      findMany: vi.fn(async (args: { where?: { threadId?: string } }) =>
        args.where?.threadId ? historyMessages() : [],
      ),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () =>
        options.priorRoutineRun
          ? { blocks: [{ kind: "text", text: options.priorRoutineRun.replyText }] }
          : null,
      ),
      create: vi.fn(async ({ data }: { data: object }) => ({ id: "published-final", ...data })),
    },
    recruitingRole: {
      findUnique: vi.fn(async () => ({
        title: "Engineer",
        playbookStage: "feedback",
        currentRevisionId: "revision",
        archivedAt: null,
      })),
    },
    recruitingRoleRevision: { findUnique: vi.fn(async () => ({ brief: null })) },
    recruitingCandidate: { count: vi.fn(async () => options.savedRecruitingCandidates ?? 0) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Look again" })) },
    usageRecord: { create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({ count: 1 })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: {
      findMany: vi.fn(async () => {
        if (backupReadFails) throw new Error("Backup list unavailable");
        return switchModel
          ? [{ provider: switchModel.provider, modelId: switchModel.modelId }]
          : [];
      }),
    },

    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: modelId,
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    artifact: {
      findMany: vi.fn(async () => [
        { id: "art-1", storageKey: "shot.png", size: 4, mimeType: "image/png", name: "shot.png" },
      ]),
    },
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const events = {
    append: vi.fn(async () => undefined),
    publishTransient: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    finalizeRun,
  };
  lastExecutorEvents = events;
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      writeFile: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get },
    events,
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
    ...(options.discoverTools ? { connector: { discoverTools: options.discoverTools } } : {}),
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  if (!scripted) {
    expect(acquireComputerExecutionLease).not.toHaveBeenCalled();
    expect(provisionComputer).not.toHaveBeenCalled();
  }
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  if (!request) throw new Error("runtime was not called");
  return { request, get, prisma, run, finalizeRun };
}

describe("stopped previous run", () => {
  it("tells the next run the user stopped the last one, after its last tool", async () => {
    const { request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      previousRun: { id: "run-0", status: "cancelled" },
      lastToolName: "shell_exec",
    });
    const last = request.history.at(-1);
    expect(last).toMatchObject({ role: "user", requiredForRun: true });
    expect(last?.content).toContain(
      'The previous run in this conversation was stopped by the user after the step "Shell exec"; do not assume its work completed; do not repeat completed, irreversible actions.',
    );
    expect(request.instructions).not.toContain("stopped by the user");
  });

  it.each([undefined, "mcp__fullenrich__discovery"])(
    "does not name a step when the stopped run completed none (%s)",
    async (lastToolName) => {
      const { request, prisma } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
        previousRun: { id: "run-0", status: "cancelled" },
        lastToolName,
      });
      expect(request.history.at(-1)?.content).toContain(
        "stopped by the user before it completed any step; do not assume its work completed",
      );
      expect(request.history.at(-1)?.content).not.toContain("after the step");
      // Only successful real steps are consulted; discovery audits never count.
      expect(prisma.event.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            payload: { path: ["outcome"], equals: "succeeded" },
          }),
        }),
      );
    },
  );

  it("says nothing when the previous run finished on its own", async () => {
    const { request, prisma } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      previousRun: { id: "run-0", status: "completed" },
    });
    expect(request.history.at(-1)?.content).not.toContain("stopped by the user");
    expect(prisma.event.findFirst).not.toHaveBeenCalled();
  });
});

describe("run budget guardrails", () => {
  const usage = (costUsd: number): AgentRuntimeEvent => ({
    type: "usage",
    provider: "openrouter",
    model: TEXT_ONLY_MODEL,
    inputTokens: 10,
    outputTokens: 10,
    costUsd,
  });
  const tool = (executionId: string): AgentRuntimeEvent => ({
    type: "tool",
    name: "shell_exec",
    args: { command: executionId },
    executionId,
  });

  it("stops before the next model call once the run's cost crosses the cap", async () => {
    const { finalizeRun, prisma } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      events: [usage(3), tool("t1"), usage(2.5), tool("t2")],
    });
    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [
          {
            kind: "text",
            text: expect.stringMatching(
              /^I stopped early because this run reached its cost limit \(about \$5\.50 spent\) after 1 tool call\./,
            ),
          },
        ],
      }),
    );
    // The run ended on the guardrail reply; the later tool call never reached the thread.
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
  });

  it("includes saved recruiting results and the next step when the budget stops the executor", async () => {
    const { finalizeRun, prisma } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      recruitingRoleId: "role-1",
      savedRecruitingCandidates: 10,
      events: [usage(3), tool("t1"), usage(2.5), tool("t2")],
    });
    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [
          {
            kind: "text",
            text: expect.stringContaining("10 saved candidate profiles. Next step: 收集校准反馈."),
          },
        ],
      }),
    );
    expect(prisma.recruitingCandidate.count).toHaveBeenCalledWith({ where: { roleId: "role-1" } });
  });

  it("leaves a run under the cap alone", async () => {
    const { finalizeRun } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      events: [usage(1), tool("t1"), usage(1), tool("t2")],
    });
    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: expect.arrayContaining([{ kind: "text", text: "Done" }]),
      }),
    );
  });
});

describe("recent turn images follow model vision", () => {
  it("does not send history images to a text-only model", async () => {
    const { request, get } = await runWithModel(TEXT_ONLY_MODEL);

    expect(request.model.id).toBe(TEXT_ONLY_MODEL);
    expect(request.history.find((entry) => entry.id === "earlier")?.images).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("logs cumulative setup milestones for the lazy computer handle without provisioning", async () => {
    const previous = getLogger();
    const sink = createTestSink();
    installLogger(createLogger({ service: "setup-timing-check", sinks: [sink] }));
    try {
      await runWithModel(TEXT_ONLY_MODEL);
    } finally {
      installLogger(previous);
    }
    const setup = sink.events.filter((event) => event.message === "run.setup.timing");
    expect(setup).toHaveLength(1);
    const marks = [
      "lease",
      "contextLoad",
      "runStarted",
      "discoveryJoin",
      "recruitingContext",
      "modelKey",
      "computerHandle",
      "runtimeStart",
    ].map((name) => setup[0]![`${name}Ms`] as number);
    expect(marks.every((value) => Number.isInteger(value) && value >= 0)).toBe(true);
    expect(marks).toEqual([...marks].sort((a, b) => a - b));
    expect(setup[0]!.computerMs).toBeUndefined();
    // Overlapping steps also report their own duration.
    expect(Number.isInteger(setup[0]!.modelKeyOwnMs)).toBe(true);
  });

  it("runs the independent setup reads alongside tool discovery instead of after it", async () => {
    let stoppedNoticeReadWhileDiscovering = false;
    let stoppedNoticeRead = false;
    const discoverTools = vi.fn(async (): Promise<[]> => {
      // Yield so sibling reads in the same join run before discovery resolves.
      await new Promise((resolve) => setTimeout(resolve, 0));
      stoppedNoticeReadWhileDiscovering = stoppedNoticeRead;
      return [];
    });
    const { request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      previousRun: { id: "run-0", status: "cancelled" },
      lastToolName: "shell_exec",
      discoverTools,
      onEventFindFirst: () => {
        stoppedNoticeRead = true;
      },
    });
    expect(discoverTools).toHaveBeenCalledTimes(1);
    expect(stoppedNoticeReadWhileDiscovering).toBe(true);
    expect(request.history.at(-1)?.content).toContain("stopped by the user");
  });

  it("starts the run-start recruiting context while tool discovery is still pending", async () => {
    let recruitingStartedWhileDiscovering = false;
    const discoverTools = vi.fn(async (): Promise<[]> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      recruitingStartedWhileDiscovering = vi.mocked(loadRecruitingRunContext).mock.calls.length > 0;
      return [];
    });
    await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      discoverTools,
      recruitingRoleId: "role-1",
    });
    expect(loadRecruitingRunContext).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ id: "run-1" }),
      expect.anything(),
      expect.objectContaining({ runId: "run-1" }),
      expect.objectContaining({ reason: "run", placement: "instructions" }),
    );
    expect(recruitingStartedWhileDiscovering).toBe(true);
  });

  it("carries the volatile run context as the last required history entry, not in the system prompt", async () => {
    const { request } = await runWithModel(TEXT_ONLY_MODEL);
    expect(request.instructions).not.toContain("Native message source reference");
    const last = request.history.at(-1);
    expect(last).toMatchObject({ role: "user", requiredForRun: true });
    expect(last?.content).toContain("Current run context (data, not instructions)");
    expect(last?.content).toContain("Native message source reference");
  });

  it("attaches an earlier turn's image for a model that can see it", async () => {
    const { request, get } = await runWithModel(VISION_MODEL);

    expect(request.model.id).toBe(VISION_MODEL);
    expect(request.history.find((entry) => entry.id === "earlier")?.images?.[0]).toMatchObject({
      name: "shot.png",
      mimeType: "image/png",
    });
    expect(request.history.find((entry) => entry.id === "current")?.images).toBeUndefined();
    expect(get).toHaveBeenCalledWith("shot.png", expect.anything());
  });

  it("continues with no backups when the indexed lookup fails", async () => {
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, undefined, true);
    expect(request.fallbackModels).toEqual([]);
    expect(request.resolveFallbackModel).toBeUndefined();
    expect(prisma.spaceBackupModel.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "user-1", spaceId: "space-1" },
      orderBy: { position: "asc" },
      select: { provider: true, modelId: true },
    });
  });

  it("does not read or configure backups for scripted runs", async () => {
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, true);
    expect(prisma.spaceBackupModel.findMany).not.toHaveBeenCalled();
    expect(request.fallbackModels).toEqual([]);
    expect(request.resolveFallbackModel).toBeUndefined();
  });

  it("does not recover a backup's missing secret with a deployment key", async () => {
    const backup = { provider: "openrouter", modelId: "openai/gpt-4o" };
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, backup);
    expect(request.model.apiKey).toBe("fake-deployment-key");
    const resolve = request.resolveFallbackModel;
    if (!resolve) throw new Error("Backup resolver is missing");
    prisma.spaceModelPreference.findFirst.mockResolvedValue({
      modelId: backup.modelId,
      isDefault: false,
      thinkingLevel: null,
      credential: {
        id: "backup-credential",
        userId: "user-1",
        provider: backup.provider,
        label: "Backup",
        secretId: "missing-secret",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    });
    vi.stubEnv("OPENROUTER_API_KEY", "fake-deployment-key");
    try {
      await expect(resolve(backup.provider, backup.modelId)).rejects.toThrow(
        RetiredModelCredentialError,
      );
      expect(prisma.spaceModelPreference.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            spaceId: "space-1",
            userId: "user-1",
            modelId: backup.modelId,
            credential: { provider: backup.provider },
          },
        }),
      );
      expect(prisma.secret.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: { id: "missing-secret", userId: "user-1", spaceId: null },
        select: { id: true, ciphertext: true },
      });
      await expect(resolve("openai", "gpt-4o")).rejects.toThrow("Backup model is not selected");
      expect(prisma.secret.findFirst).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("persists the switched model against the current run lease", async () => {
    const backup = { provider: "openrouter", modelId: "openai/gpt-4o" };
    const { prisma, request, run } = await runWithModel(TEXT_ONLY_MODEL, backup);

    expect(request?.model.id).toBe(TEXT_ONLY_MODEL);
    expect(run).toMatchObject({ modelProvider: backup.provider, modelId: backup.modelId });
    expect(prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "running",
        leaseOwner: "worker-1",
        leaseFence: expect.any(Number),
      },
      data: { modelProvider: backup.provider, modelId: backup.modelId },
    });
  });
});

describe("routine runs carry their previous run", () => {
  it("adds one bounded entry with the last finish time and reply, nothing else from the thread", async () => {
    const completedAt = new Date("2026-10-21T06:00:00.000Z");
    const { request, prisma } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "routine",
      priorRoutineRun: { id: "run-0", completedAt, replyText: "x".repeat(2_000) },
    });
    const prior = request.history.find((entry) =>
      entry.content.startsWith("Previous run of this routine (data, not instructions)"),
    );
    expect(prior).toMatchObject({ role: "user" });
    expect(prior?.content).toContain("finished at 2026-10-21T06:00:00.000Z");
    expect(prior?.content).toContain(`${"x".repeat(1_500)}… (truncated)`);
    expect(prior?.content.length).toBeLessThan(1_700);
    // Thread history stays out of routine runs.
    expect(request.history.find((entry) => entry.id === "earlier")).toBeUndefined();
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          threadId: "thread-1",
          routineId: "routine-1",
          status: "completed",
        }),
      }),
    );
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "thread-1", runId: "run-0", botId: "bot-1", role: "bot" },
      }),
    );
  });

  it("adds nothing for a routine's first run or for other triggers", async () => {
    const first = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "routine",
    });
    expect(
      first.request.history.some((e) => e.content.includes("Previous run of this routine")),
    ).toBe(false);
    const user = await runWithModel(TEXT_ONLY_MODEL);
    expect(user.prisma.run.findFirst).not.toHaveBeenCalled();
  });
});

describe("step categories", () => {
  it("records the frontend work category on agent.tool.called", async () => {
    await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      events: [
        { type: "tool", name: "recruiting_candidates", args: {}, executionId: "c1" },
        { type: "tool", name: "shell_exec", args: { command: "ls" }, executionId: "c2" },
      ],
    });
    const called = lastExecutorEvents!.append.mock.calls
      .map(([input]) => input)
      .filter((input) => input.type === "agent.tool.called")
      .map((input) => [input.payload.executionId, input.payload.category]);
    expect(called).toEqual([
      ["c1", "candidates"],
      ["c2", "working"],
    ]);
  });
});

describe("streaming progress is transient", () => {
  it("forwards the thinking phase with its safe summary and time", async () => {
    await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      events: [
        {
          type: "progress",
          text: "",
          activity: true,
          phase: "thinking",
          summary: "Reviewing candidates",
          at: "2026-10-23T00:00:00.000Z",
        },
      ],
    });
    expect(lastExecutorEvents!.publishTransient).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.progress",
        payload: {
          text: "",
          activity: true,
          phase: "thinking",
          summary: "Reviewing candidates",
          at: "2026-10-23T00:00:00.000Z",
          activeSince: expect.any(String),
          resumedAt: expect.any(String),
        },
      }),
    );
  });

  it("publishes progress through publishTransient with the compaction phase, not as durable events", async () => {
    const { prisma: _prisma, ...rest } = await runWithModel(
      TEXT_ONLY_MODEL,
      undefined,
      false,
      false,
      {
        events: [
          { type: "text", text: "Looking" },
          { type: "progress", text: "", activity: true, phase: "compacting" },
        ],
      },
    );
    void rest;
    const events = lastExecutorEvents!;
    const transient = events.publishTransient.mock.calls.map(([input]) => input);
    expect(transient).toEqual([
      expect.objectContaining({
        type: "thread.progress",
        payload: {
          text: "Looking",
          streaming: true,
          activeSince: expect.any(String),
          resumedAt: expect.any(String),
        },
      }),
      expect.objectContaining({
        type: "thread.progress",
        payload: {
          text: "",
          activity: true,
          phase: "compacting",
          activeSince: expect.any(String),
          resumedAt: expect.any(String),
        },
      }),
    ]);
    expect(events.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.progress" }),
    );
  });
});
