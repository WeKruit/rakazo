import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { acquireComputerExecutionLease, provisionComputer } from "./computer-lifecycle.js";
import { createRunExecutor, saysSomething, withoutPolls } from "./executor.js";
import { RetiredModelCredentialError } from "./pi-oauth.js";
import type * as RecruitingContextModule from "./recruiting-context.js";
import { loadRecruitingRunContext } from "./recruiting-context.js";
import type * as RequestConnectionModule from "./request-connection.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: vi.fn(async () => null),
  provisionComputer: vi.fn(async () => ({ id: "computer-1", kind: "desktop" })),
}));

vi.mock("./recruiting-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RecruitingContextModule>()),
  loadRecruitingRunContext: vi.fn(async () => undefined),
}));

// The card's own effects (lease, pause) are covered elsewhere; this file checks what the chat shows.
vi.mock("./request-connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RequestConnectionModule>()),
  requestConnection: vi.fn(
    async (_prisma: unknown, _scope: unknown, _args: unknown, pause: (block: never) => unknown) => {
      await Promise.resolve(
        pause({
          kind: "ask",
          status: "pending",
          text: "Connect Calendar",
          connection: { name: "Calendar", reason: "book the call" },
        } as never),
      ).catch(() => undefined);
      return { status: "paused" };
    },
  ),
}));

beforeEach(() => {
  vi.mocked(loadRecruitingRunContext).mockClear();
  vi.mocked(acquireComputerExecutionLease).mockClear();
  vi.mocked(provisionComputer).mockClear();
});

const TEXT_ONLY_MODEL = "deepseek/deepseek-v4-flash-0731";
/** The events double of the most recent runWithModel call. */
let lastExecutorEvents:
  | {
      append: ReturnType<typeof vi.fn>;
      publishTransient: ReturnType<typeof vi.fn>;
      finalizeRun: ReturnType<typeof vi.fn>;
    }
  | undefined;
const VISION_MODEL = "openai/gpt-4o";

type HistoryMessage = {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  runId: string;
  blocks: MessageBlock[];
  replyToMessageId: null;
  replyQuote: null;
  replyTo: null;
  clientNonce?: string;
};

/** The recruiter's current message and an earlier one of theirs, when a test sets them. */
const recruiterTexts: { current?: string; earlier?: string } = {};

function historyMessages(extra: HistoryMessage[] = []): HistoryMessage[] {
  return [
    {
      id: "current",
      threadId: "thread-1",
      seq: 2,
      role: "user",
      runId: "run-1",
      blocks: [{ kind: "text", text: recruiterTexts.current ?? "what was in the screenshot?" }],
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
    ...(recruiterTexts.earlier
      ? [
          {
            id: "earlier-text",
            threadId: "thread-1",
            seq: 0,
            role: "user",
            runId: "run-0",
            blocks: [{ kind: "text" as const, text: recruiterTexts.earlier }],
            replyToMessageId: null,
            replyQuote: null,
            replyTo: null,
          },
        ]
      : []),
    ...extra,
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
    loadTask?: () => Promise<void>;
    loadScratchpad?: () => Promise<[]>;
    /** The thread's active recruiting role; enables the run-start recruiting context. */
    recruitingRoleId?: string;
    /** Starts the run from this thread message, which is added to the history. */
    sourceMessage?: HistoryMessage;
    /** When the person's newer message was written; run-0, which a retry continues, began before it. */
    personWroteAt?: Date;
    /** The model's final reply; defaults to "Done". */
    finalText?: string;
    replySuggestions?: boolean;
    /** A compacted thread whose semantic memory recalls this text for the new message. */
    recalledMemory?: string;
    /** The main model call waits for this, as a long step does. */
    holdMain?: Promise<void>;
    /** The recruiter's message, and an earlier one, in place of the default history. */
    currentText?: string;
    earlierText?: string;
    /** A teammate already answered the recruiter's latest message with a line. */
    replyAfterTurn?: boolean;
    /** The thread's newest message is this bot's one-line note, posted by its run that ended. */
    ackFromEndedRun?: boolean;
    /** That line's text. */
    endedRunLine?: string;
    /** The server's hidden continuation prompt came after that line. */
    hiddenContinuation?: boolean;
    /** That run's steps row, which shows the recruiter no words, came after the line. */
    stepsAfterEndedLine?: boolean;
    /** This bot handed the teammate a newer brief after the report this run answers. */
    newerBrief?: boolean;
    /** The coordinator's first line, then its brief handing this bot the request. */
    briefAfterLine?: string;
    /** Tools the run calls, with their arguments. */
    toolCalls?: Array<[string, Record<string, unknown>]>;
  } = {},
) {
  recruiterTexts.current = options.currentText;
  recruiterTexts.earlier = options.earlierText;
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
    sourceMessageId: options.sourceMessage?.id ?? null,
    leaseFence: 0,
    createdAt: new Date(),
  };
  const get = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    if (next.runId === "run-1") await options.holdMain;
    if (switchModel) {
      const onModelChange = (
        next as AgentRunRequest & {
          onModelChange?: (provider: string, modelId: string) => Promise<void>;
        }
      ).onModelChange;
      await onModelChange?.(switchModel.provider, switchModel.modelId);
    }
    for (const event of options.events ?? []) yield event;
    for (const [name, args] of options.toolCalls ?? [])
      await next.executeTool?.(name, args, `${name}-call`);
    yield { type: "done" as const, text: options.finalText ?? "Done" };
  });
  const endedRunAck = {
    id: "ack-0",
    botId: "bot-1",
    runId: "run-0",
    role: "bot",
    blocks: [{ kind: "text", text: options.endedRunLine ?? "I'm checking that now." }],
    createdAt: new Date(),
  };
  const coordinatorRows = options.briefAfterLine
    ? [
        {
          id: "handoff-1",
          botId: "bot-main",
          runId: "run-0",
          role: "bot",
          blocks: [{ kind: "handoff", fromBotId: "bot-main", toBotId: "bot-1", text: "Answer" }],
          createdAt: new Date(),
        },
        {
          id: "line-main",
          botId: "bot-main",
          runId: "run-0",
          role: "bot",
          blocks: [{ kind: "text", text: options.briefAfterLine }],
          createdAt: new Date(),
        },
      ]
    : [];
  const stepsRow = {
    id: "steps-0",
    botId: "bot-1",
    runId: "run-0",
    role: "bot",
    blocks: [{ kind: "steps", steps: [] }],
    createdAt: new Date(),
  };
  const silentRows = options.stepsAfterEndedLine ? [stepsRow] : [];
  const hiddenRow = {
    id: "continue-0",
    runId: "run-0",
    role: "user",
    clientNonce: "autocontinue:run-0:decline",
    blocks: [{ kind: "text", text: "Continue." }],
  };
  const prisma = {
    // Early final replies on file-touching turns persist through one transaction on these rows.
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
    $queryRaw: vi.fn(async () => []),
    event: {
      create: vi.fn(async ({ data }: { data: object }) => ({ ...data, seq: 1 })),
      findFirst: vi.fn(async () => {
        options.onEventFindFirst?.();
        return options.lastToolName ? { payload: { name: options.lastToolName } } : null;
      }),
    },
    run: {
      findUnique: vi.fn(async (args?: { where?: { id?: string } }) =>
        options.ackFromEndedRun && args?.where?.id === "run-0"
          ? { status: "completed" }
          : options.personWroteAt && args?.where?.id === "run-0"
            ? { createdAt: new Date(options.personWroteAt.getTime() - 10_000) }
            : run,
      ),
      // A fresh row each read, as the database returns.
      findUniqueOrThrow: vi.fn(async () => ({ ...run })),
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () =>
        options.priorRoutineRun
          ? [{ id: options.priorRoutineRun.id, completedAt: options.priorRoutineRun.completedAt }]
          : [],
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
    chatGroup: { findMany: vi.fn(async () => []) },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: options.recalledMemory ? "Earlier talk about the role." : null,
        historyCompactedUpToSeq: options.recalledMemory ? 0 : null,
        historyCompactionGeneration: 0,
        nextMessageSeq: 3,
        activeRecruitingRoleId: options.recruitingRoleId ?? null,
        runs: options.previousRun ? [options.previousRun] : [],
      })),
      update: vi.fn(async () => ({ nextMessageSeq: 4, nextEventSeq: 4 })),
    },
    message: {
      // The run's own replies so far: none until the model writes one.
      findMany: vi.fn(
        async (args: {
          where?: { threadId?: string; runId?: string; role?: string; NOT?: object };
          orderBy?: object;
          select?: { runId?: boolean; clientNonce?: boolean };
          take?: number;
        }) =>
          args.take === 6 && args.select?.runId && !args.where?.runId && !args.where?.role
            ? // The thread's newest messages: what came after the first line, then the line.
              [
                ...(
                  await Promise.all(
                    prisma.message.create.mock.results.map((result) => result.value),
                  )
                )
                  .map((message) => ({ runId: "run-1", role: "bot", ...message }))
                  .reverse(),
                ...(options.hiddenContinuation ? [hiddenRow] : []),
                ...silentRows,
                ...(options.ackFromEndedRun ? [endedRunAck] : []),
                ...coordinatorRows,
              ]
            : options.briefAfterLine && args.take === 8
              ? coordinatorRows
              : options.ackFromEndedRun && args.take === 8
                ? [...(options.hiddenContinuation ? [hiddenRow] : []), ...silentRows, endedRunAck]
                : options.replyAfterTurn && args.take === 8 && !args.select?.runId
                  ? [
                      {
                        role: "bot",
                        blocks: [{ kind: "text", text: "I'm writing the template now." }],
                      },
                      { role: "user", blocks: [{ kind: "text", text: "Write a template" }] },
                    ]
                  : args.where?.threadId && !args.where.runId && args.where.role !== "bot"
                    ? historyMessages(options.sourceMessage ? [options.sourceMessage] : [])
                    : [],
      ),
      findUnique: vi.fn(async (args?: { where?: { id?: string } }) =>
        options.newerBrief && args?.where?.id === options.sourceMessage?.id
          ? { seq: options.sourceMessage?.seq }
          : options.briefAfterLine && args?.where?.id === "line-main"
            ? coordinatorRows[1]
            : args?.where?.id === "published-final"
              ? ((await prisma.message.create.mock.results.at(-1)?.value) ?? null)
              : null,
      ),
      count: vi.fn(async () => 0),
      findFirst: vi.fn(
        async (args?: {
          where?: { role?: string; id?: string; seq?: object; createdAt?: { gt?: Date } };
          orderBy?: object;
        }) =>
          options.personWroteAt &&
          args?.where?.role === "user" &&
          (args.where.createdAt?.gt ?? new Date(0)) >= options.personWroteAt
            ? null
            : options.newerBrief && args?.where?.seq
              ? { id: "brief-2" }
              : args?.orderBy && !args.where?.role && !args.where?.id
                ? // The thread's newest message: the last one this run posted.
                  (prisma.message.create.mock.results.at(-1)?.value ??
                  (options.ackFromEndedRun ? endedRunAck : null))
                : args?.where?.role === "user" || args?.where?.id
                  ? (historyMessages(options.sourceMessage ? [options.sourceMessage] : []).find(
                      (message: { role: string; id?: string }) =>
                        message.role === "user" &&
                        (!args.where?.id || message.id === args.where.id),
                    ) ?? null)
                  : options.priorRoutineRun
                    ? { blocks: [{ kind: "text", text: options.priorRoutineRun.replyText }] }
                    : null,
      ),
      create: vi.fn(async ({ data }: { data: object }) => ({ id: "published-final", ...data })),
      delete: vi.fn(async () => ({})),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => ({
        id: where.id,
        ...data,
      })),
    },
    recruitingRole: {
      findUnique: vi.fn(async () => ({
        title: "Engineer",
        currentRevisionId: "revision",
        archivedAt: null,
      })),
    },
    recruitingRoleRevision: { findUnique: vi.fn(async () => ({ brief: null })) },
    recruitingCandidate: { count: vi.fn(async () => 0) },
    recruitingCalibrationRound: { findFirst: vi.fn(async () => null) },
    task: {
      findUniqueOrThrow: vi.fn(async () => {
        await options.loadTask?.();
        return { id: run.taskId, prompt: "Look again" };
      }),
    },
    usageRecord: { create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({ count: 1 })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findFirst: vi.fn(async () => null) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
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
    scratchpadItem: { findMany: vi.fn(async () => options.loadScratchpad?.() ?? []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    steeringMessage: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    artifact: {
      findMany: vi.fn(async () => [
        { id: "art-1", storageKey: "shot.png", size: 4, mimeType: "image/png", name: "shot.png" },
      ]),
    },
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const events = {
    claimSteering: vi.fn(async () => []),
    append: vi.fn(async () => undefined),
    publishTransient: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    pauseRunForInput: vi.fn(async () => true),
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
    memoryProviders: {
      resolve: async () =>
        options.recalledMemory
          ? {
              defaultScope: "isolated",
              provider: {
                describe: () => ({ capabilities: { recall: true, save: true } }),
                recall: async () => ({ ok: true, value: [{ memory: options.recalledMemory }] }),
                save: async () => ({ ok: true, value: undefined }),
              },
            }
          : null,
    },
    artifacts: { get },
    events,
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
    replySuggestions: options.replySuggestions,
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
  return { request, get, prisma, run, finalizeRun, runtimeRun, events };
}

describe("prompt cache order", () => {
  it("keeps per-turn recall after the history so the history stays a cached prefix", async () => {
    const { request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      recalledMemory: "Prefers Mandarin speakers",
    });
    const contents = request.history.map((message) => message.content);
    const summary = contents.findIndex((text) => text.includes("Earlier talk about the role."));
    const earlier = request.history.findIndex((message) => message.id === "earlier");
    const recall = contents.findIndex((text) => text.includes("Prefers Mandarin speakers"));
    const turnContext = contents.findIndex((text) => text.startsWith("Current run context"));
    expect(summary).toBe(0);
    expect(earlier).toBeGreaterThan(summary);
    expect(recall).toBeGreaterThan(earlier);
    if (turnContext >= 0) expect(turnContext).toBeGreaterThan(recall);
  });
});

describe("reply suggestion", () => {
  it("asks the model for the user's next message beside finalize and saves it", async () => {
    const { runtimeRun, events, finalizeRun } = await runWithModel(
      TEXT_ONLY_MODEL,
      undefined,
      false,
      false,
      { finalText: "Here are ten people.", replySuggestions: true },
    );
    await vi.waitFor(() =>
      expect(events.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: "thread.suggestion", runId: "run-1" }),
      ),
    );
    const suggestionCall = runtimeRun.mock.calls.at(-1)![0];
    expect(suggestionCall.runId).toBe("run-1:suggestion");
    expect(suggestionCall.tools).toEqual([]);
    expect(suggestionCall.prompt).toContain("Here are ten people.");
    // It starts once the reply text is final, without waiting for finalize.
    expect(runtimeRun.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      finalizeRun.mock.invocationCallOrder[0]!,
    );
  });

  it("follows an auto-continued reply too, from what the user last wrote", async () => {
    const { runtimeRun, events } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "follow_up",
      finalText: "Here is the next step.",
      replySuggestions: true,
      sourceMessage: {
        id: "auto",
        threadId: "thread-1",
        seq: 3,
        role: "user",
        runId: "run-1",
        blocks: [{ kind: "text", text: "Continue with the next playbook step." }],
        replyToMessageId: null,
        replyQuote: null,
        replyTo: null,
        clientNonce: "autocontinue:run-0",
      },
    });
    await vi.waitFor(() =>
      expect(events.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: "thread.suggestion", runId: "run-1" }),
      ),
    );
    const prompt = runtimeRun.mock.calls.at(-1)![0].prompt;
    expect(prompt).toContain("User:\nwhat was in the screenshot?");
    expect(prompt).toContain("Here is the next step.");
    expect(prompt).not.toContain("Continue with the next playbook step.");
  });

  it("skips runs that a person did not start", async () => {
    const { runtimeRun } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "routine",
      priorRoutineRun: { id: "run-0", completedAt: new Date(), replyText: "x" },
      replySuggestions: true,
    });
    expect(runtimeRun.mock.calls.every(([call]) => !call.runId.endsWith(":suggestion"))).toBe(true);
  });
});

describe("withoutPolls", () => {
  // Staging 11-12: "请只发一张多选问题卡片…" became a poll, which closed and the agent then voted on.
  it("leaves recruiting runs no poll, so a question for the recruiter is a question card", () => {
    const tools = [{ name: "ask_user" }, { name: "create_poll" }];
    expect(withoutPolls(tools, true).map((tool) => tool.name)).toEqual(["ask_user"]);
    expect(withoutPolls(tools, false)).toHaveLength(2);
  });
});

describe("saysSomething", () => {
  it("counts only words or cards as a reply, not a row of the run's steps", () => {
    expect(saysSomething([{ kind: "steps", steps: [] } as never])).toBe(false);
    expect(saysSomething([{ kind: "text", text: "  " }])).toBe(false);
    // A handoff to a teammate is a marker, not a reply.
    expect(
      saysSomething([{ kind: "handoff", fromBotId: "a", toBotId: "b", text: "Find people." }]),
    ).toBe(false);
    expect(saysSomething([{ kind: "text", text: "On it." }])).toBe(true);
    expect(saysSomething([{ kind: "ask", question: "Which city?" } as never])).toBe(true);
  });
});

describe("handed-in stage", () => {
  const handoff = (toBotId: string) => ({
    id: "handoff-1",
    threadId: "thread-1",
    seq: 3,
    role: "bot",
    runId: "run-0",
    blocks: [
      {
        kind: "handoff" as const,
        fromBotId: "bot-main",
        toBotId,
        text: "Find 100 similar people",
        hop: 1,
      },
    ],
    replyToMessageId: null,
    replyQuote: null,
    replyTo: null,
  });

  it("starts at low thinking and names the brief when a teammate hands this bot the stage", async () => {
    const { request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "follow_up",
      sourceMessage: handoff("bot-1"),
    });
    expect(request.model.firstStepThinkingLevel).toBe("low");
    expect(request.prompt).toContain("A teammate handed this stage to you");
  });

  // Gate 264149c9, change-mind-mid-run: the recruiter already had Main's line, and the stage
  // opened with another sentence saying what it was doing before the template.
  it("asks for no opening sentence when the recruiter already has a reply", async () => {
    const { request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "follow_up",
      sourceMessage: handoff("bot-1"),
      replyAfterTurn: true,
    });
    expect(request.prompt).not.toContain("Begin your first step with one short sentence");
  });

  // Gate 95185659, change-mind: the old 60–80万 version came after the recruiter changed the base,
  // and the corrected one followed; the run that took the newer message hands the change on.
  // Gate c8855b72: the same, from the server's retry of the handed-in turn that asked instead.
  it.each([
    ["brief", () => handoff("bot-1")],
    [
      "retry of a brief",
      () => ({
        ...handoff("bot-1"),
        role: "user",
        botId: null,
        clientNonce: "autocontinue:run-0:decline",
        blocks: [{ kind: "text", text: "Not shown: write the email." }],
      }),
    ],
  ] as const)("posts no result for a %s the recruiter has written past", async (_, source) => {
    const { finalizeRun } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "follow_up",
      sourceMessage: source() as never,
      // Gate 36e6d7f0, change-mind: the retry began 0.8 s after the recruiter changed the base.
      ...(_ === "retry of a brief" ? { personWroteAt: new Date(Date.now() - 1000) } : {}),
      recruitingRoleId: "role-1",
      finalText:
        "Subject: Staff Frontend Engineer\n\nHi {{firstName}}, the base is RMB 600,000–800,000.",
    });
    expect(JSON.stringify(finalizeRun.mock.calls)).not.toContain("600,000");
  });

  it("posts nothing when the answer to a teammate's check-in is NO_RESPONSE", async () => {
    const checkIn = handoff("bot-1");
    checkIn.blocks[0] = { ...checkIn.blocks[0], report: "progress" } as never;
    const { finalizeRun } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "follow_up",
      sourceMessage: checkIn,
      finalText: "NO_RESPONSE",
    });
    expect(JSON.stringify(finalizeRun.mock.calls)).not.toContain("NO_RESPONSE");
  });

  // Gate 36e6d7f0, change-mind-mid-run: the revised email went out headed 「NO_RESPONSE」.
  it("drops the silent marker from the start of a reply that has more to say", async () => {
    const { finalizeRun } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "follow_up",
      recruitingRoleId: "role-1",
      finalText:
        "NO_RESPONSE\n\nSubject: Staff Frontend Engineer\n\nThe base is RMB 700,000–900,000.",
    });
    const posted = JSON.stringify(finalizeRun.mock.calls);
    expect(posted).not.toContain("NO_RESPONSE");
    expect(posted).toContain("700,000");
  });

  // Gate 01e9467c, first-timer-no-gmail: the run posted its first line and ended; the
  // continuation the server gave it answered in a message of its own.
  it("puts a continuation's answer in place of the line its run left", async () => {
    const { prisma } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "follow_up",
      ackFromEndedRun: true,
      endedRunLine: "我会说明不连接邮箱时能否直接发邮件。",
      hiddenContinuation: true,
      finalText: "需要连接 Gmail 才能给候选人发邮件。",
    });
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ack-0" } }),
    );
  });

  // Honest-limits 8a002815, cannot-do-that-honestly: the first line, the run's steps rows, then
  // the continuation's 「我无法发送 LinkedIn InMail…」 as a second message 40 s later.
  it("puts a continuation's answer in place of the line under rows that say nothing", async () => {
    const { prisma } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "follow_up",
      ackFromEndedRun: true,
      endedRunLine: "可以改为通过邮件联系 Li Wei。",
      hiddenContinuation: true,
      stepsAfterEndedLine: true,
      finalText: "我无法发送 LinkedIn InMail，这次没有联系任何人。",
    });
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ack-0" } }),
    );
  });

  // Gate 4774895e, first-timer-no-gmail: the coordinator's first line already answered, it handed
  // the question on, and the teammate's answer came as a second reply.
  it("puts a handed-in answer in place of the coordinator's line for the same message", async () => {
    const { prisma, finalizeRun } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "follow_up",
      sourceMessage: handoff("bot-1"),
      briefAfterLine: "不连邮箱也不能直接给候选人发邮件。",
      finalText: "不能。要实际发送，需要先连接发件邮箱。",
    });
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "line-main" },
        data: expect.objectContaining({ botId: "bot-1", runId: "run-1" }),
      }),
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ blocks: [] }));
  });

  // Gate 01e9467c, change-mind-mid-run: the recruiter changed the ask, this bot handed the
  // teammate the new brief, and its answer to the old stage's report was a third template.
  it("posts nothing for a report this bot already handed a newer brief after", async () => {
    const report = handoff("bot-1");
    report.blocks[0] = { ...report.blocks[0], report: "completed" } as never;
    const { finalizeRun } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "follow_up",
      sourceMessage: report,
      newerBrief: true,
      finalText: "Here is the updated template, signed Alex Morgan.",
    });
    expect(JSON.stringify(finalizeRun.mock.calls)).not.toContain("Alex Morgan");
  });

  it("keeps full thinking for a handoff addressed to another bot", async () => {
    const { request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "follow_up",
      sourceMessage: handoff("bot-2"),
    });
    expect(request.model.firstStepThinkingLevel).toBeUndefined();
    expect(request.prompt).not.toContain("Begin your first step with one short sentence");
  });
});

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
    // Every member of the discovery join reports its interval, even when skipped.
    for (const name of [
      "discovery",
      "nativeSources",
      "turnImages",
      "memoryContext",
      "scratchpadContext",
      "ticketContext",
      "recall",
      "stoppedNotice",
      "resumeBrief",
      "routinePriorRun",
    ]) {
      const start = setup[0]![`${name}StartMs`] as number;
      const end = setup[0]![`${name}EndMs`] as number;
      const own = setup[0]![`${name}OwnMs`] as number;
      expect([start, end, own].every((value) => Number.isInteger(value) && value >= 0)).toBe(true);
      expect(end).toBeGreaterThanOrEqual(start);
      // Each value is rounded separately to whole milliseconds.
      expect(Math.abs(end - start - own)).toBeLessThanOrEqual(1);
    }
    expect(Number.isInteger(setup[0]!.modelKeyOwnMs)).toBe(true);
  });

  it("separates the cumulative setup mark from the actual parallel discovery join wait", async () => {
    const previous = getLogger();
    const sink = createTestSink();
    installLogger(createLogger({ service: "setup-timing-check", sinks: [sink] }));
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    try {
      const pending = runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
        // Earlier setup is not time spent waiting at the discovery join.
        loadTask: () => delay(200),
        discoverTools: async () => {
          await delay(30);
          return [];
        },
        loadScratchpad: async () => {
          await delay(60);
          return [];
        },
      });
      await vi.advanceTimersByTimeAsync(260);
      await pending;
      const setup = sink.events.find((event) => event.message === "run.setup.timing");
      expect(setup).toMatchObject({
        contextLoadMs: 200,
        discoveryStartMs: 200,
        discoveryEndMs: 230,
        discoveryOwnMs: 30,
        scratchpadContextStartMs: 200,
        scratchpadContextEndMs: 260,
        scratchpadContextOwnMs: 60,
        discoveryJoinStartMs: 200,
        discoveryJoinWaitMs: 60,
        discoveryJoinMs: 260,
      });
    } finally {
      vi.useRealTimers();
      installLogger(previous);
    }
  });

  it("logs first model output time and prompt cache use when the run completes", async () => {
    const previous = getLogger();
    const sink = createTestSink();
    installLogger(createLogger({ service: "run-timing-check", sinks: [sink] }));
    try {
      await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
        events: [
          {
            type: "usage",
            provider: "openrouter",
            model: TEXT_ONLY_MODEL,
            inputTokens: 10,
            cacheReadTokens: 30,
            cacheWriteTokens: 0,
            outputTokens: 5,
            costUsd: 0,
          },
        ],
      });
    } finally {
      installLogger(previous);
    }
    const timing = sink.events.filter((event) => event.message === "run.timing");
    expect(timing).toHaveLength(1);
    expect(timing[0]).toMatchObject({
      modelCalls: 1,
      promptSize: 40,
      cachedPromptSize: 30,
      promptCacheHitRate: 0.75,
    });
    expect(Number.isInteger(timing[0]!.firstModelEventMs)).toBe(true);
    expect(timing[0]!.firstModelEventMs as number).toBeLessThanOrEqual(
      timing[0]!.runtimeMs as number,
    );
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
  it("adds bounded entries with recent finish times and replies, nothing else from the thread", async () => {
    const completedAt = new Date("2026-10-21T06:00:00.000Z");
    const { request, prisma } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      trigger: "routine",
      priorRoutineRun: { id: "run-0", completedAt, replyText: "x".repeat(2_000) },
    });
    const prior = request.history.find((entry) =>
      entry.content.startsWith("Previous runs of this routine (data, not instructions)"),
    );
    expect(prior).toMatchObject({ role: "user" });
    expect(prior?.content).toContain("finished at 2026-10-21T06:00:00.000Z");
    expect(prior?.content).toContain(`${"x".repeat(1_500)}… (truncated)`);
    expect(prior?.content.length).toBeLessThan(1_800);
    // Thread history stays out of routine runs.
    expect(request.history.find((entry) => entry.id === "earlier")).toBeUndefined();
    expect(prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
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
      first.request.history.some((e) => e.content.includes("Previous runs of this routine")),
    ).toBe(false);
    const user = await runWithModel(TEXT_ONLY_MODEL);
    expect(user.prisma.run.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ routineId: expect.anything() }) }),
    );
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
          resumedAt: null,
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
          resumedAt: null,
        },
      }),
      expect.objectContaining({
        type: "thread.progress",
        payload: {
          text: "",
          activity: true,
          phase: "compacting",
          activeSince: expect.any(String),
          resumedAt: null,
        },
      }),
    ]);
    expect(events.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.progress" }),
    );
  });
});
