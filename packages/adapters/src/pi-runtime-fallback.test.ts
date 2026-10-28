import type * as AgentCore from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentOptions } from "@earendil-works/pi-agent-core";
import { convertToLlm, createCompactionSummaryMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  CredentialStore,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent, ModelCallObserver } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  credentialStores: [] as unknown[],
  stream: vi.fn(),
  agentOptions: undefined as AgentOptions | undefined,
  agent: undefined as AgentCore.Agent | undefined,
  delay: vi.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>(),
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  abortableDelay: providerState.delay,
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentCore>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: AgentOptions) {
        super(options);
        providerState.agentOptions = options;
        providerState.agent = this;
      }
    },
  };
});

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: (options?: { credentials?: unknown }) => {
    if (options?.credentials) providerState.credentialStores.push(options.credentials);
    return {
      getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
      streamSimple: (...args: unknown[]) => providerState.stream(...args),
    };
  },
}));

vi.mock("./pi-current-models.js", () => ({ supplementPiModels: (models: unknown) => models }));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import {
  estimateContextTokens,
  providerContextPrefix,
  selectContext,
} from "./context-selection.js";
import { toolCompletionAuditPayload } from "./executor.js";
import { estimateModelContextTokens } from "./model-context.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS } from "./model-vision.js";
import {
  CODEX_STREAM_IDLE_TIMEOUT_MESSAGE,
  isProviderRateLimited,
  isRetryableProviderUnavailable,
  keepInterruptedAssistantMessage,
  PiAgentRuntime,
  providerRetryAfterMs,
  thinkingSummary,
} from "./pi-runtime.js";
import {
  MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS,
  MODEL_STREAM_IDLE_TIMEOUT_MS,
} from "./pi-runtime-limits.js";
import { PiJsonlSessionRecorder } from "./pi-session.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";

const primary = model("provider-a", "primary", 32_768);
const backupA = model("provider-b", "backup-a", 8_192);
const backupB = model("provider-c", "backup-b", 16_384);

function model(provider: string, id: string, contextWindow: number): Model<"openai-completions"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(4_096, contextWindow),
  };
}

function message(
  target: Model<"openai-completions">,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: target.api,
    provider: target.provider,
    model: target.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function stream(_target: Model<"openai-completions">, response: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    result.push({
      type: "error",
      reason: response.stopReason,
      error: response,
    });
  } else if (response.content.some((part) => part.type === "toolCall")) {
    const call = response.content.find((part) => part.type === "toolCall");
    if (call?.type === "toolCall") {
      result.push({
        type: "toolcall_start",
        contentIndex: 0,
        partial: { ...response, content: [] },
      });
      result.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: call,
        partial: response,
      });
    }
    result.push({ type: "done", reason: "toolUse", message: response });
  } else {
    result.push({ type: "done", reason: "stop", message: response });
  }
  result.end(response);
  return result;
}

function countContextImages(context: { messages?: unknown[] }): number {
  let count = 0;
  for (const message of context.messages ?? []) {
    if (!message || typeof message !== "object" || !("content" in message)) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    count += content.filter(
      (part) =>
        part !== null && typeof part === "object" && (part as { type?: unknown }).type === "image",
    ).length;
  }
  return count;
}

function request(fallbackModels: AgentRunRequest["model"][] = []): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Write the requested result",
    instructions: "Use tools when useful.",
    history: [],
    tools: [
      {
        name: "write_effect",
        description: "Write one external effect.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        readOnly: false,
      },
    ],
    model: { provider: primary.provider, id: primary.id, apiKey: "fake-primary-key" },
    fallbackModels,
    executeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as AgentRunRequest;
}

async function run(
  input: AgentRunRequest,
  events: AgentRuntimeEvent[] = [],
  runtime = new PiAgentRuntime(),
) {
  for await (const event of runtime.run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  providerState.models.clear();
  providerState.credentialStores.length = 0;
  for (const candidate of [primary, backupA, backupB]) {
    providerState.models.set(
      `${candidate.provider}/${candidate.id}`,
      candidate as unknown as Record<string, unknown>,
    );
  }
  providerState.stream.mockReset();
  providerState.agentOptions = undefined;
  providerState.agent = undefined;
  vi.restoreAllMocks();
  providerState.delay.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

it.each(["context-abort", "provider-abort", "provider-error-then-shutdown"] as const)(
  "preserves only the trusted context abort reason for %s",
  async (failure) => {
    const controller = new AbortController();
    const reason = new DOMException("Worker is stopping", "AbortError");
    const input = request();
    if (failure === "provider-error-then-shutdown")
      input.onUsage = async () => controller.abort(reason);
    providerState.stream.mockImplementation(() => {
      if (failure === "context-abort") controller.abort(reason);
      return stream(
        primary,
        message(
          primary,
          [],
          failure === "provider-error-then-shutdown" ? "error" : "aborted",
          failure === "provider-error-then-shutdown" ? "Original provider failure" : "Aborted",
        ),
      );
    });
    const consume = async () => {
      for await (const _event of new PiAgentRuntime().run(input, { signal: controller.signal })) {
      }
    };
    const caught = await consume().catch((error: unknown) => error);
    if (failure === "context-abort") expect(caught).toBe(reason);
    else {
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBe(reason);
      if (failure === "provider-error-then-shutdown")
        expect((caught as Error).message).toContain("Original provider failure");
    }
    expect(providerState.stream).toHaveBeenCalledOnce();
  },
);

function compactionRequest(withHistory = true) {
  const target = model("provider-a", "large", 128_000);
  providerState.models.set(
    `${target.provider}/${target.id}`,
    target as unknown as Record<string, unknown>,
  );
  const input = request();
  input.model = { provider: target.provider, id: target.id, apiKey: "fake-primary-key" };
  input.contextStrategy = "current";
  input.history = withHistory
    ? Array.from({ length: 18 }, (_, index) => [
        {
          id: `old-user-${index}`,
          role: "user" as const,
          content: `Earlier request ${index}: ${"u".repeat(1_000)}`,
        },
        {
          id: `old-answer-${index}`,
          role: "assistant" as const,
          content: `Earlier result ${index}: ${"a".repeat(26_000)}`,
        },
      ]).flat()
    : [];
  input.history.push(
    {
      id: "canonical-goal",
      role: "user",
      content: "Keep the original exact goal.",
      requiredForRun: true,
    },
    {
      id: "canonical-card",
      role: "assistant",
      content: "Choose the exact option.",
      requiredForRun: true,
    },
  );
  input.prompt = "  Exact answer🙂\r\nContinue my task.  ";
  input.sourceMessageId = "canonical-answer";
  input.history.push({
    id: input.sourceMessageId,
    role: "user",
    content: input.prompt,
    requiredForRun: true,
  });
  return { target, input };
}

it.each(["current", "cache-aware"] as const)(
  "uses native compaction before the first request and accounts each split summary call with %s",
  async (strategy) => {
    const { target, input } = compactionRequest();
    input.contextStrategy = strategy;
    const onUsage = vi.fn();
    input.onUsage = onUsage;
    const observer: ModelCallObserver = {
      beforeCall: vi.fn(async () => `reservation-${onUsage.mock.calls.length}`),
      afterCall: vi.fn(async () => undefined),
    };
    providerState.stream.mockImplementation(
      (_model: Model<"openai-completions">, context: Context) =>
        stream(
          target,
          message(
            target,
            [
              {
                type: "text",
                text: context.systemPrompt?.includes("summarization assistant")
                  ? "Native progress summary."
                  : "Done.",
              },
            ],
            "stop",
          ),
        ),
    );
    const events = await run(input, [], new PiAgentRuntime({ modelCallObserver: observer }));
    const summaries = onUsage.mock.calls.filter(([event]) => event.operationKind === "compaction");
    expect(summaries).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "progress" && event.phase === "compacting"),
    ).toEqual([{ type: "progress", text: "", activity: true, phase: "compacting" }]);
    expect(observer.beforeCall).toHaveBeenCalledTimes(3);
    expect(observer.afterCall).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(3);
    expect(
      providerState.stream.mock.calls.every((call) => call[2].cacheRetention === "short"),
    ).toBe(true);
    const wire = providerState.stream.mock.calls.at(-1)![1] as Context;
    const serialized = JSON.stringify(wire);
    expect(serialized).toContain("Native progress summary.");
    expect(serialized).toContain("untrusted");
    for (const exact of [
      "Keep the original exact goal.",
      "Choose the exact option.",
      input.prompt,
    ]) {
      expect(
        wire.messages.filter((entry) =>
          typeof entry.content === "string"
            ? entry.content === exact
            : entry.content.some((part) => part.type === "text" && part.text === exact),
        ),
      ).toHaveLength(1);
    }
    expect(
      providerState.agent!.state.messages.some((entry) => entry.role === "compactionSummary"),
    ).toBe(true);
    expect(input.history[1]!.content).toHaveLength("Earlier result 0: ".length + 26_000);
    const convertedState = await providerState.agentOptions!.convertToLlm!(
      providerState.agent!.state.messages,
    );
    const protectedIndexes = createRuntimeContextPolicy(input).protectedIndexes(convertedState);
    expect(
      protectedIndexes.some(
        (index) =>
          "rakazoMessageId" in convertedState[index]! &&
          String(convertedState[index]!.rakazoMessageId).startsWith("old-user-"),
      ),
    ).toBe(false);
  },
);

it.each([true, false])(
  "preserves an explicit connection cache:none during native compaction when supported=%s",
  async (supported) => {
    const { target, input } = compactionRequest();
    if (supported) target.compat = { cacheControlFormat: "anthropic" };
    input.model.cacheCapabilities = { scope: "connection", retentionMode: "none" };
    providerState.stream.mockImplementation(() =>
      stream(target, message(target, [{ type: "text", text: "Native progress summary." }], "stop")),
    );
    if (!supported) {
      await expect(run(input)).rejects.toThrow("Unsupported prompt-cache retention mode");
      expect(providerState.stream).not.toHaveBeenCalled();
      return;
    }
    await run(input);
    const summaries = providerState.stream.mock.calls.filter((call) =>
      (call[1] as Context).systemPrompt?.includes("summarization assistant"),
    );
    expect(summaries).toHaveLength(2);
    expect(summaries.every((call) => call[2].cacheRetention === "none")).toBe(true);
  },
);

it("compacts a running native tool loop while preserving exact role state, sibling results and steering", async () => {
  const { target, input } = compactionRequest(false);
  target.contextWindow = 32_768;
  input.tools = [
    {
      name: "recruiting_role",
      description: "Adopt exact role",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    },
    {
      name: "read_file",
      description: "Read evidence",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    },
  ];
  let turn = 0;
  let projectedPressureCalls = 0;
  let claimed = false;
  input.claimSteering = async () => {
    if (turn < 12 || claimed) return [];
    claimed = true;
    return [{ id: "steer", messageId: "steer", text: "Exact human correction: continue B." }];
  };
  input.executeTool = vi.fn(async (name, _args, executionId) => ({
    ...(name === "recruiting_role"
      ? { roleContext: `EXACT ROLE ${executionId.includes("role-a") ? "A" : "B"}` }
      : { evidence: "e".repeat(11_500) }),
  }));
  providerState.stream.mockImplementation(
    (_model: Model<"openai-completions">, context: Context) => {
      if (context.systemPrompt?.includes("summarization assistant")) {
        const original = convertToLlm(providerState.agent!.state.messages);
        expect(estimateModelContextTokens({ messages: original })).toBeGreaterThan(
          target.contextWindow - 16_384,
        );
        projectedPressureCalls++;
        return stream(
          target,
          message(target, [{ type: "text", text: "Completed file review; keep working." }], "stop"),
        );
      }
      turn++;
      const content: AssistantMessage["content"] =
        turn <= 17
          ? [
              { type: "toolCall", id: `file-${turn}`, name: "read_file", arguments: {} },
              ...(turn === 1 || turn === 8 || turn === 17
                ? [
                    {
                      type: "toolCall" as const,
                      id: turn === 8 ? "role-b" : `role-a-${turn}`,
                      name: "recruiting_role",
                      arguments: {},
                    },
                  ]
                : []),
            ]
          : [{ type: "text", text: "Done." }];
      const next = message(target, content, turn <= 17 ? "toolUse" : "stop");
      next.usage.totalTokens = estimateContextTokens(
        providerContextPrefix(context.systemPrompt ?? "", context.tools ?? [], context.messages),
      );
      return stream(target, next);
    },
  );
  await run(input);
  const summaries = providerState.stream.mock.calls.filter((call) =>
    (call[1] as Context).systemPrompt?.includes("summarization assistant"),
  );
  expect(summaries.length).toBeGreaterThanOrEqual(2);
  expect(projectedPressureCalls).toBe(summaries.length);
  expect(
    summaries
      .slice(1)
      .some((call) => JSON.stringify(call[1]).includes("Completed file review; keep working.")),
  ).toBe(true);
  const wire = providerState.stream.mock.calls.at(-1)![1] as Context;
  expect(JSON.stringify(wire).includes("Completed file review; keep working.")).toBe(true);
  expect(JSON.stringify(wire).includes("EXACT ROLE A")).toBe(true);
  expect(
    wire.messages.filter(
      (entry) =>
        entry.role === "user" &&
        JSON.stringify(entry.content).includes("Exact human correction: continue B."),
    ),
  ).toHaveLength(1);
  const lastRole = wire.messages.findLast(
    (entry) => entry.role === "toolResult" && entry.toolName === "recruiting_role",
  );
  expect(lastRole?.role === "toolResult" && lastRole.toolCallId).toBe("role-a-17");
  for (const entry of wire.messages) {
    if (entry.role !== "assistant") continue;
    for (const call of entry.content.filter((part) => part.type === "toolCall")) {
      expect(
        wire.messages.filter(
          (result) => result.role === "toolResult" && result.toolCallId === call.id,
        ),
      ).toHaveLength(1);
    }
  }
});

it.each(["failure", "empty"])(
  "preserves original native state when the second split summary has %s",
  async (failure) => {
    const { target, input } = compactionRequest();
    const onUsage = vi.fn();
    input.onUsage = onUsage;
    const observer: ModelCallObserver = {
      beforeCall: vi.fn(async () => "reservation"),
      afterCall: vi.fn(async () => undefined),
    };
    let calls = 0;
    providerState.stream.mockImplementation(() => {
      calls++;
      return stream(
        target,
        message(
          target,
          [{ type: "text", text: calls === 1 ? "Completed first summary." : "" }],
          calls === 2 && failure === "failure" ? "error" : "stop",
          "Invalid summary response",
        ),
      );
    });
    await expect(
      run(input, [], new PiAgentRuntime({ modelCallObserver: observer })),
    ).rejects.toThrow(failure === "failure" ? "Invalid summary response" : "nonempty summary");
    expect(calls).toBe(2);
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(observer.afterCall).toHaveBeenCalledTimes(2);
    expect(
      providerState.agent!.state.messages.some((entry) => entry.role === "compactionSummary"),
    ).toBe(false);
    expect(
      providerState
        .agent!.state.messages.filter((entry) => "rakazoMessageId" in entry)
        .map((entry) => (entry as AgentMessage & { rakazoMessageId: string }).rakazoMessageId),
    ).toContain("old-answer-0");
  },
);

it("accounts each native summary retry before the answer without provider-hidden retries", async () => {
  const { target, input } = compactionRequest();
  const onUsage = vi.fn();
  input.onUsage = onUsage;
  const observer: ModelCallObserver = {
    beforeCall: vi.fn(async () => "reservation"),
    afterCall: vi.fn(async () => undefined),
  };
  let calls = 0;
  providerState.stream.mockImplementation(() => {
    calls++;
    return stream(
      target,
      message(
        target,
        [{ type: "text", text: "Native progress summary." }],
        calls === 1 ? "error" : "stop",
        calls === 1 ? "503 Service unavailable" : undefined,
      ),
    );
  });
  await run(input, [], new PiAgentRuntime({ modelCallObserver: observer }));
  expect(calls).toBe(4);
  expect(onUsage.mock.calls.filter(([event]) => event.operationKind === "compaction")).toHaveLength(
    3,
  );
  expect(observer.beforeCall).toHaveBeenCalledTimes(4);
  expect(observer.afterCall).toHaveBeenCalledTimes(4);
  expect(providerState.stream.mock.calls.every((call) => call[2].maxRetries === 0)).toBe(true);
});

it("aborts native compaction before committing state and leaves queued steering unconsumed", async () => {
  const { target, input } = compactionRequest();
  const controller = new AbortController();
  const onUsage = vi.fn();
  input.onUsage = onUsage;
  const observer: ModelCallObserver = {
    beforeCall: vi.fn(async () => "reservation"),
    afterCall: vi.fn(async () => undefined),
  };
  providerState.stream.mockImplementation(() => {
    providerState.agent!.steer({
      role: "user",
      content: "Queued exact human steering.",
      timestamp: 1,
    });
    controller.abort();
    return stream(
      target,
      message(target, [{ type: "text", text: "A summary after cancellation." }], "stop"),
    );
  });
  const events: AgentRuntimeEvent[] = [];
  const collecting = (async () => {
    for await (const event of new PiAgentRuntime({ modelCallObserver: observer }).run(input, {
      signal: controller.signal,
    }))
      events.push(event);
  })();
  await expect(collecting).rejects.toThrow("aborted");
  expect(providerState.stream).toHaveBeenCalledTimes(1);
  expect(onUsage).toHaveBeenCalledTimes(1);
  expect(observer.afterCall).toHaveBeenCalledTimes(1);
  expect(
    providerState.agent!.state.messages.some((entry) => entry.role === "compactionSummary"),
  ).toBe(false);
  expect(providerState.agent!.peekQueuedMessages()).toEqual([
    expect.objectContaining({ content: "Queued exact human steering." }),
  ]);
  expect(
    providerState.agent!.state.messages.some(
      (entry) => "rakazoMessageId" in entry && entry.rakazoMessageId === "old-answer-0",
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) => event.type === "text" && event.text.includes("A summary after cancellation."),
    ),
  ).toBe(false);
});

it("uses the same observed native compaction inside a delegated tool loop", async () => {
  const { target, input } = compactionRequest(false);
  target.contextWindow = 32_768;
  input.tools = [
    {
      name: "run_subagent",
      description: "Delegate",
      inputSchema: { type: "object", properties: { task: { type: "string" } } },
      readOnly: true,
    },
    {
      name: "read_file",
      description: "Read evidence",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    },
  ];
  input.executeTool = vi.fn(async () => ({ evidence: "e".repeat(11_500) }));
  let parentTurns = 0;
  let childTurns = 0;
  providerState.stream.mockImplementation(
    (_model: Model<"openai-completions">, context: Context) => {
      if (context.systemPrompt?.includes("summarization assistant"))
        return stream(
          target,
          message(target, [{ type: "text", text: "Native delegated progress summary." }], "stop"),
        );
      if (JSON.stringify(context.messages[0]?.content).includes("Rakazo subagent")) {
        childTurns++;
        const next = message(
          target,
          childTurns <= 15
            ? [{ type: "toolCall", id: `child-${childTurns}`, name: "read_file", arguments: {} }]
            : [{ type: "text", text: "Child finished." }],
          childTurns <= 15 ? "toolUse" : "stop",
        );
        next.usage.totalTokens = estimateContextTokens(
          providerContextPrefix(context.systemPrompt ?? "", context.tools ?? [], context.messages),
        );
        return stream(target, next);
      }
      parentTurns++;
      return stream(
        target,
        message(
          target,
          parentTurns === 1
            ? [
                {
                  type: "toolCall",
                  id: "delegate",
                  name: "run_subagent",
                  arguments: { name: "reviewer", task: "Review every file" },
                },
              ]
            : [{ type: "text", text: "Done." }],
          parentTurns === 1 ? "toolUse" : "stop",
        ),
      );
    },
  );
  const observer: ModelCallObserver = {
    beforeCall: vi.fn(async () => "reservation"),
    afterCall: vi.fn(async () => undefined),
  };
  const events = await run(input, [], new PiAgentRuntime({ modelCallObserver: observer }));
  expect(events.filter((event) => event.type === "subagent" && event.status === "failed")).toEqual(
    [],
  );
  expect(childTurns).toBe(16);
  const summaries = events.filter(
    (event) => event.type === "usage" && event.operationKind === "compaction",
  );
  expect(summaries.length).toBeGreaterThan(0);
  expect(summaries.every((event) => "agentId" in event && typeof event.agentId === "string")).toBe(
    true,
  );
  expect(observer.afterCall).toHaveBeenCalledTimes(providerState.stream.mock.calls.length);
  expect(
    providerState.stream.mock.calls.some((call) =>
      JSON.stringify(call[1]).includes("Native delegated progress summary."),
    ),
  ).toBe(true);
});

it("does not spend a summary call when exact protected controls already exceed the budget", async () => {
  const { target, input } = compactionRequest();
  input.prompt = `Current exact human instructions: ${"x".repeat(520_000)}`;
  providerState.stream.mockImplementation(() =>
    stream(
      target,
      message(target, [{ type: "text", text: "Summary cannot solve oversized controls." }], "stop"),
    ),
  );
  await expect(run(input)).rejects.toThrow("context");
  expect(providerState.stream).not.toHaveBeenCalled();
  expect(
    providerState.agent!.state.messages.some((entry) => entry.role === "compactionSummary"),
  ).toBe(false);
});

it("leaves the original state when the native summary cannot reduce context enough", async () => {
  const { target, input } = compactionRequest();
  input.history.unshift({ id: "earlier-context", role: "user", content: "x".repeat(40_000) });
  providerState.stream.mockImplementation(() =>
    stream(target, message(target, [{ type: "text", text: "s".repeat(480_000) }], "stop")),
  );
  await expect(run(input)).rejects.toThrow("preserving required messages");
  expect(providerState.stream).toHaveBeenCalledTimes(2);
  expect(
    providerState.agent!.state.messages.some((entry) => entry.role === "compactionSummary"),
  ).toBe(false);
  expect(
    providerState.agent!.state.messages.some(
      (entry) => "rakazoMessageId" in entry && entry.rakazoMessageId === "old-answer-0",
    ),
  ).toBe(true);
});

it("keeps fitting native receipts without compaction when serialized bytes exceed the token window", async () => {
  const { target, input } = compactionRequest(false);
  target.contextWindow = 272_000;
  target.maxTokens = 32_768;
  input.instructions = `Exact instructions: ${"i".repeat(140_000)}`;
  input.history.unshift(
    ...Array.from({ length: 10 }, (_, index) => [
      { id: `old-request-${index}`, role: "user" as const, content: "Earlier completed work." },
      { id: `old-result-${index}`, role: "assistant" as const, content: "e".repeat(12_000) },
    ]).flat(),
  );
  const receipt = {
    rows: Array.from({ length: 5 }, (_, rowIndex) => ({
      rowIndex,
      evidence: "evidence🙂\r\n".repeat(100),
    })),
  };
  input.tools = [
    { name: "get_rows", description: "Read saved rows", inputSchema: { type: "object" } },
  ];
  input.executeTool = vi.fn(async () => receipt);
  let answers = 0;
  let summaries = 0;
  providerState.stream.mockImplementation(
    (_model: Model<"openai-completions">, context: Context) => {
      if (context.systemPrompt?.includes("summarization assistant")) {
        summaries++;
        return stream(
          target,
          message(target, [{ type: "text", text: "Earlier completed work." }], "stop"),
        );
      }
      const next = message(
        target,
        ++answers === 1
          ? [{ type: "toolCall", id: "rows", name: "get_rows", arguments: {} }]
          : [{ type: "text", text: "Done." }],
        answers === 1 ? "toolUse" : "stop",
      );
      next.usage = {
        ...next.usage,
        input: 28_000,
        output: 400,
        cacheRead: 16_000,
        totalTokens: 44_400,
      };
      return stream(target, next);
    },
  );
  expect((await run(input)).at(-1)).toEqual({ type: "done", text: "Done." });
  expect(summaries).toBe(0);
  expect(input.executeTool).toHaveBeenCalledOnce();
  const wire = providerState.stream.mock.calls.at(-1)![1] as Context;
  expect(
    wire.messages.find((entry) => entry.role === "toolResult" && entry.toolCallId === "rows"),
  ).toMatchObject({ content: [{ type: "text", text: JSON.stringify(receipt) }] });
  expect(
    wire.messages.filter(
      (entry) => entry.role === "user" && JSON.stringify(entry.content).includes("Exact answer🙂"),
    ),
  ).toHaveLength(1);
  expect(
    providerState.agent!.state.messages.some((entry) => entry.role === "compactionSummary"),
  ).toBe(false);
});

it("counts initial system/tools and invalidates measured usage after a newer native summary", () => {
  const context: Context = {
    systemPrompt: "i".repeat(8_000),
    tools: [{ name: "read", description: "d".repeat(8_000), parameters: { type: "object" } }],
    messages: [{ role: "user", content: "Exact request🙂\r\n", timestamp: 1 }],
  };
  const first = estimateModelContextTokens(context);
  expect(first).toBeGreaterThan(4_000);
  expect(first).toBeLessThan(5_000);
  const used = message(
    primary,
    [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
    "toolUse",
  );
  used.timestamp = 2;
  used.usage = {
    ...used.usage,
    input: 28_000,
    output: 400,
    cacheRead: 16_000,
    totalTokens: 44_400,
  };
  context.messages.push(used, {
    role: "toolResult",
    toolCallId: "read",
    toolName: "read",
    content: [{ type: "text", text: "Exact evidence🙂\r\n" }],
    isError: false,
    timestamp: 3,
  });
  expect(estimateModelContextTokens(context)).toBeGreaterThan(44_400);
  context.messages.splice(
    1,
    0,
    ...convertToLlm([createCompactionSummaryMessage("Earlier progress only.", 44_400, 4)]),
  );
  expect(estimateModelContextTokens(context)).toBeGreaterThan(first);
  expect(estimateModelContextTokens(context)).toBeLessThan(5_000);
  const fresh = message(primary, [{ type: "text", text: "New answer." }], "stop");
  fresh.timestamp = 5;
  fresh.usage.totalTokens = 2_000;
  context.messages.push(fresh);
  expect(estimateModelContextTokens(context)).toBeGreaterThan(2_000);
  expect(estimateModelContextTokens(context)).toBeLessThan(3_000);
});

it("keeps fitting exact context when a native progress summary would exceed its remaining budget", async () => {
  const { target, input } = compactionRequest(false);
  input.instructions = `Exact run instructions: ${"i".repeat(90_000)}`;
  input.history.unshift(
    ...Array.from({ length: 10 }, (_, index) => [
      { id: `old-request-${index}`, role: "user" as const, content: "Earlier status request." },
      {
        id: `old-progress-${index}`,
        role: "assistant" as const,
        content: "Earlier status. ".repeat(500),
      },
    ]).flat(),
  );
  input.tools = [
    { name: "recruiting_role", inputSchema: { type: "object" }, description: "Read role" },
  ];
  const role = {
    roleContext: "Exact current role and memory.",
    workspace: { source: "r".repeat(25_433) },
  };
  input.executeTool = vi.fn(async () => role);
  let turns = 0;
  let summaries = 0;
  providerState.stream.mockImplementation(
    (_model: Model<"openai-completions">, context: Context) => {
      if (context.systemPrompt?.includes("summarization assistant")) {
        summaries++;
        return stream(
          target,
          message(target, [{ type: "text", text: "s".repeat(500_000) }], "stop"),
        );
      }
      turns++;
      if (turns > 1)
        return stream(target, message(target, [{ type: "text", text: "Done." }], "stop"));
      const next = message(
        target,
        [{ type: "toolCall", id: "role", name: "recruiting_role", arguments: {} }],
        "toolUse",
      );
      next.usage.totalTokens = 113_000;
      return stream(target, next);
    },
  );
  expect((await run(input)).at(-1)).toEqual({ type: "done", text: "Done." });
  expect(summaries).toBe(2);
  const original = convertToLlm(providerState.agent!.state.messages);
  expect(estimateContextTokens(providerContextPrefix("", [], original)) + 240).toBeLessThan(
    target.contextWindow - target.maxTokens,
  );
  expect(
    original.find((entry) => entry.role === "toolResult" && entry.toolCallId === "role"),
  ).toMatchObject({
    content: [{ type: "text", text: JSON.stringify(role) }],
  });
  expect(
    original.filter(
      (entry) =>
        entry.role === "user" &&
        (typeof entry.content === "string"
          ? entry.content === input.prompt
          : entry.content.some((part) => part.type === "text" && part.text === input.prompt)),
    ),
  ).toHaveLength(1);
  expect(
    providerState.agent!.state.messages.some((entry) => entry.role === "compactionSummary"),
  ).toBe(false);
});

it("does not compact an unfinished native tool batch", async () => {
  const { target, input } = compactionRequest(false);
  const pending = message(
    target,
    [
      { type: "text", text: "p".repeat(130_000) },
      { type: "toolCall", id: "unfinished", name: "read_file", arguments: {} },
    ],
    "toolUse",
  );
  let checking: unknown;
  providerState.stream.mockImplementation(() => {
    const context = {
      messages: [...providerState.agent!.state.messages, pending],
      tools: providerState.agent!.state.tools,
    };
    checking = providerState.agentOptions!.prepareRequest!(
      { context, model: target, thinkingLevel: "off" },
      new AbortController().signal,
    );
    return stream(target, message(target, [{ type: "text", text: "Done." }], "stop"));
  });
  await run(input);
  expect(await checking).toBeUndefined();
  expect(providerState.stream).toHaveBeenCalledTimes(1);
  expect(
    providerState.agent!.state.messages.some((entry) => entry.role === "compactionSummary"),
  ).toBe(false);
});

it("uses native compaction for initial history in a small context window", async () => {
  const { target, input } = compactionRequest();
  target.contextWindow = 32_768;
  input.history = [...input.history.slice(0, 8), ...input.history.slice(-3)];
  providerState.stream.mockImplementation((_model: Model<"openai-completions">, context: Context) =>
    stream(
      target,
      message(
        target,
        [
          {
            type: "text",
            text: context.systemPrompt?.includes("summarization assistant")
              ? "Native earlier progress."
              : "Done.",
          },
        ],
        "stop",
      ),
    ),
  );
  const events = await run(input);
  expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
  expect(
    providerState.agent!.state.messages.some((entry) => entry.role === "compactionSummary"),
  ).toBe(true);
});

it("excludes duplicate tool bookkeeping from the native prompt budget for a saved read", async () => {
  const { target, input } = compactionRequest(false);
  input.instructions = `Existing exact instructions: ${"s".repeat(55_000)}`;
  input.history.unshift(
    { id: "earlier-user", role: "user", content: `Earlier request: ${"u".repeat(1_000)}` },
    { id: "earlier-answer", role: "assistant", content: `Earlier answer: ${"a".repeat(1_000)}` },
  );
  input.tools = [
    {
      name: "recruiting_candidates",
      description: "Read saved assessment",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    },
  ];
  const assessment = {
    candidateKey: "saved-candidate",
    assessment: "e".repeat(40_000),
    sourceArtifactId: "saved-source",
  };
  input.executeTool = vi.fn(async () => assessment);
  let turns = 0;
  let summaries = 0;
  providerState.stream.mockImplementation(
    (_model: Model<"openai-completions">, context: Context) => {
      if (context.systemPrompt?.includes("summarization assistant")) {
        summaries++;
        return stream(
          target,
          message(target, [{ type: "text", text: "Earlier progress." }], "stop"),
        );
      }
      turns++;
      return stream(
        target,
        message(
          target,
          turns === 1
            ? [{ type: "toolCall", id: "read-saved", name: "recruiting_candidates", arguments: {} }]
            : [{ type: "text", text: "Saved assessment summarized." }],
          turns === 1 ? "toolUse" : "stop",
        ),
      );
    },
  );
  const events = await run(input);
  expect(events.at(-1)).toEqual({ type: "done", text: "Saved assessment summarized." });
  expect(input.executeTool).toHaveBeenCalledTimes(1);
  expect(summaries).toBe(0);
  const final = providerState.stream.mock.calls.at(-1)![1] as Context;
  const available = target.contextWindow - target.maxTokens;
  expect(estimateModelContextTokens(final)).toBeLessThan(available);
  expect(
    selectContext(final.messages, {
      strategy: "current",
      protectedIndexes: final.messages.map((_, index) => index),
      truncateToolResults: false,
      budget: {
        contextWindow: target.contextWindow,
        outputReserve: target.maxTokens,
        systemPrompt: "",
        tools: [],
      },
    }).estimatedInputTokens,
  ).toBeLessThan(available);
  expect(
    final.messages.find(
      (entry) => entry.role === "toolResult" && entry.toolCallId === "read-saved",
    ),
  ).toMatchObject({ content: [{ type: "text", text: JSON.stringify(assessment) }] });
});

it("updates the previous native summary when protected history leaves only a split turn prefix", async () => {
  const { target, input } = compactionRequest(false);
  target.contextWindow = 8_192;
  const previous = "PRIOR_COMPLETED_PROGRESS_SENTINEL";
  const exactRole = JSON.stringify({ roleContext: "Exact current role." });
  const steering = "Exact current human steering.";
  const summaryPrompts: string[] = [];
  let replacement: Awaited<ReturnType<NonNullable<AgentOptions["prepareRequest"]>>>;
  function batch(
    id: string,
    name = "read_file",
    text = "Earlier completed file review.",
  ): AgentMessage[] {
    return [
      message(target, [{ type: "toolCall", id, name, arguments: {} }], "toolUse"),
      {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 1,
      },
    ];
  }
  providerState.stream.mockImplementation(
    (_model: Model<"openai-completions">, context: Context) => {
      if (context.systemPrompt?.includes("summarization assistant")) {
        const prompt = JSON.stringify(context);
        summaryPrompts.push(prompt);
        return stream(
          target,
          message(
            target,
            [
              {
                type: "text",
                text: prompt.includes(previous)
                  ? `${previous}: updated progress.`
                  : "New progress only.",
              },
            ],
            "stop",
          ),
        );
      }
      const role = batch("role", "recruiting_role", exactRole);
      if (role[0]?.role === "assistant") role[0].usage.totalTokens = 30_000;
      const messages = [
        ...providerState.agent!.state.messages,
        ...role,
        createCompactionSummaryMessage(previous, 30_000, 1),
        { role: "user" as const, content: steering, timestamp: 1 },
        ...Array.from({ length: 4 }, (_, index) => batch(`old-${index}`)).flat(),
        ...batch("latest"),
      ];
      const latestAssistant = messages.at(-2)!;
      if (latestAssistant.role === "assistant") latestAssistant.usage.totalTokens = 30_000;
      const waiting = new AssistantMessageEventStream();
      void Promise.resolve(
        providerState.agentOptions!.prepareRequest!(
          {
            context: { messages, tools: providerState.agent!.state.tools },
            model: target,
            thinkingLevel: "off",
          },
          new AbortController().signal,
        ),
      )
        .then(async (update) => {
          replacement = update;
          expect(
            estimateModelContextTokens({ messages: convertToLlm(update?.context?.messages ?? []) }),
          ).toBeLessThan(target.contextWindow - target.maxTokens);
          const retry = await providerState.agentOptions!.prepareRequest!(
            { context: update!.context!, model: target, thinkingLevel: "off" },
            new AbortController().signal,
          );
          expect(retry).toBeUndefined();
          expect(summaryPrompts).toHaveLength(1);
          const done = message(target, [{ type: "text", text: "Done." }], "stop");
          waiting.push({ type: "done", reason: "stop", message: done });
          waiting.end(done);
        })
        .catch((error) => {
          const failed = message(target, [], "error", String(error));
          waiting.push({ type: "error", reason: "error", error: failed });
          waiting.end(failed);
        });
      return waiting;
    },
  );
  const events = await run(input);
  expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
  expect(summaryPrompts).toHaveLength(1);
  expect(summaryPrompts[0]!.includes(previous)).toBe(true);
  expect(summaryPrompts[0]!.includes("Exact current role.")).toBe(false);
  expect(summaryPrompts[0]!.includes(steering)).toBe(false);
  const messages = replacement?.context?.messages ?? [];
  expect(messages.filter((entry) => entry.role === "compactionSummary")).toHaveLength(1);
  expect(messages.find((entry) => entry.role === "compactionSummary")?.summary).toContain(previous);
  expect(
    messages.find((entry) => entry.role === "toolResult" && entry.toolCallId === "role"),
  ).toMatchObject({
    content: [{ type: "text", text: exactRole }],
  });
  expect(
    messages.filter((entry) => entry.role === "user" && entry.content === steering),
  ).toHaveLength(1);
});

it("replays native questions as assistant turns with the latest exact human answer current", async () => {
  const goal = "Ask my language, echo the complete answer in a code block, then stop. Chat only.";
  const answer = "  中文🙂\r\nEnglish details  ";
  const input = request();
  input.sourceMessageId = "answer-2";
  input.prompt = answer;
  input.history = [
    {
      role: "user",
      content:
        "Platform task state (data):\n" +
        goal +
        "\nSaved skill: quote raw input. Resolved selected value: private-choice",
      requiredForRun: true,
    },
    {
      id: "old-jd",
      role: "user",
      content: "[bot peer-sourcer] Earlier unrelated task: create a role from a JD.",
    },
    { id: "original-goal", role: "user", content: goal, requiredForRun: true },
    { id: "card-1", role: "assistant", content: "Which language?", requiredForRun: true },
    { id: "answer-1", role: "user", content: answer, requiredForRun: true },
    {
      id: "card-2",
      role: "assistant",
      content: "Which language is preferred?",
      requiredForRun: true,
    },
    { id: "answer-2", role: "user", content: answer, requiredForRun: true },
  ];
  providerState.stream.mockImplementation(() =>
    stream(primary, message(primary, [{ type: "text", text: "Done." }], "stop")),
  );
  await run(input);
  const wireContext = providerState.stream.mock.calls[0]![1] as Context;
  const context = {
    ...wireContext,
    messages: wireContext.messages.filter((m) => m.role !== "system"),
  };
  const texts = context.messages.map((m) =>
    typeof m.content === "string"
      ? m.content
      : m.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(""),
  );
  expect(context.messages.map((m) => m.role)).toEqual([
    "user",
    "user",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
  ]);
  expect(texts).toEqual([
    input.history[0]!.content,
    input.history[1]!.content,
    goal,
    "Which language?",
    answer,
    "Which language is preferred?",
    answer,
  ]);
  expect(
    context.messages.filter(
      (m) => (m as { rakazoMessageId?: string }).rakazoMessageId === "original-goal",
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(context.messages)).toContain("private-choice");
  expect(context.messages).not.toContainEqual(
    expect.objectContaining({ rakazoMessageId: "answer-2" }),
  );
  expect(input.executeTool).not.toHaveBeenCalled();
});

describe("Pi pre-dispatch tool audit", () => {
  it("does not persist an undeclared tool name or its error text", async () => {
    const input = request();
    const audits: Record<string, unknown>[] = [];
    input.onToolCompleted = (completion) => {
      audits.push(toolCompletionAuditPayload(completion));
    };
    const unknownName = "private-unknown-name-canary";
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [{ type: "toolCall", id: "unknown", name: unknownName, arguments: {} }],
            "toolUse",
          ),
        ),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Done." }], "stop")),
      );

    await run(input);

    expect(input.executeTool).not.toHaveBeenCalled();
    expect(audits).toEqual([
      expect.objectContaining({
        name: "unknown-tool",
        outcome: "error",
        error: "Tool not found before execution.",
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(unknownName);
    const nextContext = providerState.stream.mock.calls[1]?.[1] as Context;
    expect(JSON.stringify(nextContext.messages)).toContain(`Tool ${unknownName} not found`);
  });

  it("audits rejected fields without argument values and leaves the model error intact", async () => {
    const input = request();
    input.tools = [
      {
        name: "source.lookup",
        description: "Read a source.",
        readOnly: true,
        inputSchema: {
          type: "object",
          properties: {
            operation: { const: "read" },
            sourceRefs: {
              type: "array",
              items: {
                type: "object",
                properties: { artifactId: { type: "string" } },
                required: ["artifactId"],
              },
            },
          },
          required: ["operation", "sourceRefs"],
        },
      },
    ];
    const args = {
      operation: "private-invalid-enum-value",
      sourceRefs: [{ artifact_id: "fake-artifact", quote: "private quote ".repeat(300) }],
    };
    const audits: Record<string, unknown>[] = [];
    const onToolCompleted = vi.fn((completion) => {
      audits.push(toolCompletionAuditPayload(completion));
    });
    input.onToolCompleted = onToolCompleted;
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "rejected",
                name: "source_lookup",
                arguments: args,
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Done." }], "stop")),
      );

    const events = await run(input);

    expect(input.executeTool).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "tool")).toEqual([]);
    expect(onToolCompleted).toHaveBeenCalledOnce();
    expect(audits[0]).toMatchObject({
      name: "source.lookup",
      executionId: JSON.stringify(["pi-tool", "main", "rejected"]),
      outcome: "error",
    });
    const error = String(audits[0]?.error);
    expect(error).toContain("sourceRefs.0.artifactId");
    expect(error).toContain("operation: must be equal to constant");
    expect(error).not.toContain("Received arguments");
    expect(error).not.toContain(args.operation);
    expect(error).not.toContain("private quote");
    expect(error.length).toBeLessThanOrEqual(2_000);
    const nextContext = providerState.stream.mock.calls[1]?.[1] as Context;
    const rejection = nextContext.messages.find((entry) => entry.role === "toolResult");
    expect(JSON.stringify(rejection)).toContain(args.operation);
    expect(JSON.stringify(rejection)).toContain("private quote");
    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
  });

  it.each([false, true])("keeps one existing host audit with host failure=%s", async (failed) => {
    const input = request();
    const audits: Record<string, unknown>[] = [];
    input.onToolCompleted = (completion) => {
      audits.push(toolCompletionAuditPayload(completion));
    };
    if (failed)
      input.executeTool = vi.fn(async () => {
        throw new Error("host rejected the write");
      });
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "valid",
                name: "write_effect",
                arguments: { value: "ready" },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Done." }], "stop")),
      );

    await run(input);

    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      name: "write_effect",
      outcome: failed ? "error" : "succeeded",
    });
    if (failed) expect(audits[0]?.error).toBe("host rejected the write");
  });

  it("audits a helper rejection separately when parent and helper reuse a call ID", async () => {
    const input = request();
    input.tools = [
      ...input.tools,
      {
        name: "run_subagent",
        description: "Run a helper.",
        readOnly: true,
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
      },
    ];
    const audits: Record<string, unknown>[] = [];
    input.onToolCompleted = (completion) => {
      audits.push(toolCompletionAuditPayload(completion));
    };
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "same-call",
                name: "run_subagent",
                arguments: { name: "helper", task: "Check the source." },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "same-call",
                name: "write_effect",
                arguments: {},
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Done." }], "stop")),
      );

    await run(input);

    expect(input.executeTool).not.toHaveBeenCalled();
    expect(audits).toHaveLength(2);
    const parentId = JSON.stringify(["pi-tool", "main", "same-call"]);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "run_subagent",
          executionId: parentId,
          outcome: "succeeded",
        }),
        expect.objectContaining({
          name: "write_effect",
          executionId: JSON.stringify(["pi-tool", parentId, "same-call"]),
          outcome: "error",
          error: expect.stringContaining("value"),
        }),
      ]),
    );
  });
});

describe("Pi runtime transient model retries", () => {
  it.each([
    "terminated",
    "Codex error: Our servers are currently overloaded. Please try again later.",
  ])(
    "recovers from two pre-output failures with %s and commits one assistant message",
    async (error) => {
      providerState.stream
        .mockImplementationOnce(() => stream(primary, message(primary, [], "error", error)))
        .mockImplementationOnce(() => stream(primary, message(primary, [], "error", error)))
        .mockImplementation(() =>
          stream(primary, message(primary, [{ type: "text", text: "Recovered." }], "stop")),
        );
      const appendMessage = vi.fn(async (_entry: AgentMessage) => undefined);
      vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
      const events = await run(
        request(),
        [],
        new PiAgentRuntime({ sessionRoot: "fixture-sessions" }),
      );
      expect(providerState.stream).toHaveBeenCalledTimes(3);
      expect(providerState.stream.mock.calls.map(([target]) => target)).toEqual([
        expect.objectContaining({ provider: primary.provider, id: primary.id }),
        expect.objectContaining({ provider: primary.provider, id: primary.id }),
        expect.objectContaining({ provider: primary.provider, id: primary.id }),
      ]);
      expect(events.filter((event) => event.type === "text")).toEqual([
        { type: "text", text: "Recovered." },
      ]);
      expect(events.at(-1)).toEqual({ type: "done", text: "Recovered." });
      expect(appendMessage.mock.calls.filter(([entry]) => entry.role === "assistant")).toEqual([
        [
          expect.objectContaining({
            stopReason: "stop",
            content: [{ type: "text", text: "Recovered." }],
          }),
        ],
      ]);
      expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000, 8_000]);
    },
  );

  it.each([
    "HTTP 401; servers are overloaded",
    "invalid api key; terminated",
    "context_length_exceeded; 503 overloaded",
    "bad request; terminated",
  ])("does not retry or switch on %s", async (error) => {
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", error)),
    );
    await expect(
      run(request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }])),
    ).rejects.toThrow(error);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it("exhausts three retries without a backup and preserves the first provider error", async () => {
    providerState.stream
      .mockImplementationOnce(() => stream(primary, message(primary, [], "error", "terminated")))
      .mockImplementation(() =>
        stream(primary, message(primary, [], "error", "HTTP 503 unavailable")),
      );
    await expect(run(request())).rejects.toThrow("terminated");
    expect(providerState.stream).toHaveBeenCalledTimes(4);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000, 8_000, 20_000]);
  });

  it("keeps a separate rate-limit budget and honours the provider's retry-after", async () => {
    providerState.stream
      .mockImplementationOnce(() => stream(primary, message(primary, [], "error", "terminated")))
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [], "error", "429 Too Many Requests; retry after 42s")),
      )
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [], "error", "HTTP 503 unavailable")),
      )
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [], "error", "429 rate limit")),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Recovered." }], "stop")),
      );
    const events = await run(request());
    expect(events.at(-1)).toEqual({ type: "done", text: "Recovered." });
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([
      2_000, 42_000, 8_000, 15_000,
    ]);
  });

  it("does not back off after a provider timeout, which already spent its request budget", async () => {
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", "Request timed out.")),
    );
    await expect(run(request())).rejects.toThrow("Request timed out.");
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it("surfaces a non-retryable error encountered after a transient failure", async () => {
    providerState.stream
      .mockImplementationOnce(() => stream(primary, message(primary, [], "error", "terminated")))
      .mockImplementation(() => stream(primary, message(primary, [], "error", "invalid api key")));
    await expect(run(request())).rejects.toThrow("invalid api key");
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000]);
  });

  it("does not retry after a tool call starts even if the terminal error omits it", async () => {
    const failure = message(primary, [], "error", "terminated");
    providerState.stream.mockImplementation(() => {
      const result = new AssistantMessageEventStream();
      result.push({ type: "start", partial: failure });
      result.push({ type: "toolcall_start", contentIndex: 0, partial: failure });
      result.push({ type: "error", reason: "error", error: failure });
      result.end(failure);
      return result;
    });
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    await expect(run(input)).rejects.toThrow("terminated");
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(providerState.delay).not.toHaveBeenCalled();
    expect(input.executeTool).not.toHaveBeenCalled();
  });

  it("retries the same model for a helper agent without configured backups", async () => {
    const input = request();
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
        readOnly: true,
      },
    ];
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "retry-helper",
                name: "run_subagent",
                arguments: { name: "helper", task: "Summarize the fixture." },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() => stream(primary, message(primary, [], "error", "terminated")))
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [], "error", "503 overloaded")),
      )
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [{ type: "text", text: "Helper result." }], "stop")),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Complete." }], "stop")),
      );
    const events = await run(input);
    expect(providerState.stream).toHaveBeenCalledTimes(5);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "subagent", status: "completed", result: "Helper result." }),
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "Complete." });
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000, 8_000]);
  });

  it("waits for each bounded backoff before retrying", async () => {
    vi.useFakeTimers();
    const { abortableDelay } = await vi.importActual<typeof Core>("@rakazo/core");
    providerState.delay.mockImplementation(abortableDelay);
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", "429 rate limit")),
    );
    const outcome = run(request()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    for (const [index, delay] of [5_000, 15_000, 30_000, 60_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(providerState.stream).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(providerState.stream).toHaveBeenCalledTimes(index + 2);
    }
    expect(await outcome).toEqual(expect.objectContaining({ message: "429 rate limit" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["run", "turn"])(
    "stops promptly when the %s signal aborts during backoff",
    async (source) => {
      vi.useFakeTimers();
      const { abortableDelay } = await vi.importActual<typeof Core>("@rakazo/core");
      providerState.delay.mockImplementation(abortableDelay);
      providerState.stream.mockImplementation(() =>
        stream(primary, message(primary, [], "error", "429 rate limit")),
      );
      const controller = new AbortController();
      const input = request();
      const events: AgentRuntimeEvent[] = [];
      const consume = async () => {
        for await (const event of new PiAgentRuntime().run(input, { signal: controller.signal })) {
          events.push(event);
        }
        return undefined;
      };
      const outcome = consume().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(providerState.delay).toHaveBeenCalled();
      const attempts = providerState.stream.mock.calls.length;
      if (source === "run") controller.abort();
      else providerState.agent?.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/abort|stop/i) }),
      );
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(providerState.stream).toHaveBeenCalledTimes(attempts);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("Pi runtime ordered model fallback", () => {
  it.each(["absent", "empty"])(
    "passes the original stream options and terminal content through with %s backups",
    async (backups) => {
      const initialStream = new AssistantMessageEventStream();
      providerState.stream.mockReturnValue(initialStream);
      const input = request();
      if (backups === "absent") delete input.fallbackModels;
      const initialRun = run(input);
      await vi.waitFor(() => expect(providerState.stream).toHaveBeenCalledOnce());
      const agentOptions = providerState.agentOptions;
      if (!agentOptions) throw new Error("Agent was not created");
      expect(await agentOptions.getApiKey?.(primary.provider)).toBe("fake-primary-key");

      const upstream = new AssistantMessageEventStream();
      providerState.stream.mockReturnValue(upstream);
      const signal = new AbortController().signal;
      const options = {
        apiKey: "caller-key",
        reasoning: "high" as const,
        maxTokens: 123,
        timeoutMs: 456,
        maxRetries: 2,
        headers: { "x-fixture": "unchanged" },
        signal,
      };
      const response = await agentOptions.streamFn(
        primary,
        { messages: [] } as unknown as TranscriptContext,
        options,
      );
      const iterator = response[Symbol.asyncIterator]();
      const first = iterator.next();
      const failure = message(
        primary,
        [{ type: "text", text: "partial result" }],
        "error",
        "503 overloaded",
      );
      const start = { type: "start" as const, partial: { ...failure, content: [] } };
      upstream.push(start);
      let started = false;
      void first.then(() => {
        started = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(started).toBe(false);
      expect(providerState.stream.mock.lastCall?.[2]).toMatchObject(options);
      upstream.push({ type: "error", reason: "error", error: failure });
      upstream.end(failure);
      expect((await first).value).toBe(start);
      expect((await iterator.next()).value).toEqual({
        type: "error",
        reason: "error",
        error: failure,
      });
      expect(await response.result()).toBe(failure);
      const initialMessage = message(primary, [{ type: "text", text: "healthy" }], "stop");
      initialStream.push({ type: "done", reason: "stop", message: initialMessage });
      initialStream.end(initialMessage);
      await initialRun;
    },
  );

  it("preserves OAuth getApiKey behavior with no backup list", async () => {
    const input = request();
    delete input.fallbackModels;
    delete input.model.apiKey;
    input.model.oauth = {
      credential: {
        type: "oauth",
        access: "fake-user-access",
        refresh: "fake-user-refresh",
        expires: Date.now() + 60_000,
      },
    };
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [{ type: "text", text: "answer" }], "stop")),
    );
    await run(input);
    expect(await providerState.agentOptions?.getApiKey?.(primary.provider)).toBeUndefined();
    expect(providerState.stream.mock.lastCall?.[2]).toMatchObject({ apiKey: undefined });
  });

  it("skips a backup with no user credential even when a process key is set", async () => {
    const unconnected = model("openrouter", "unconnected", 16_384);
    providerState.models.set(
      `${unconnected.provider}/${unconnected.id}`,
      unconnected as unknown as Record<string, unknown>,
    );
    vi.stubEnv("OPENROUTER_API_KEY", "fake-process-key");
    try {
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        target.provider === primary.provider
          ? stream(target, message(target, [], "error", "429 rate limit"))
          : stream(target, message(target, [{ type: "text", text: "backup" }], "stop")),
      );
      await run(
        request([
          { provider: unconnected.provider, id: unconnected.id },
          { provider: backupB.provider, id: backupB.id, apiKey: "fake-user-backup-key" },
        ]),
      );
      expect(
        providerState.stream.mock.calls.map(
          ([target]) => (target as Model<"openai-completions">).provider,
        ),
      ).toEqual([primary.provider, backupB.provider]);
      expect(providerState.stream.mock.lastCall?.[2]).toMatchObject({
        apiKey: "fake-user-backup-key",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])(
    "bills configured model ids with switched=%s despite provider response ids",
    async (switched) => {
      const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => "reservation");
      const afterCall = vi.fn<ModelCallObserver["afterCall"]>(async () => undefined);
      const onUsage = vi.fn<NonNullable<AgentRunRequest["onUsage"]>>(async () => undefined);
      const input = request(
        switched ? [{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }] : [],
      );
      input.onUsage = onUsage;
      providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
        const failure = switched && target.provider === primary.provider;
        const result = message(
          target,
          failure ? [] : [{ type: "text", text: "answer" }],
          failure ? "error" : "stop",
          failure ? "429 rate limit" : undefined,
        );
        result.provider = "reported-provider";
        result.model = "reported-model";
        result.responseModel = "reported-model-2026-10-08";
        return stream(target, result);
      });
      const events = await run(
        input,
        [],
        new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall } }),
      );
      const targets = switched ? [primary, backupA] : [primary];
      expect(beforeCall.mock.calls.map(([call]) => call)).toEqual(
        targets.map((target) =>
          expect.objectContaining({ provider: target.provider, modelId: target.id }),
        ),
      );
      expect(onUsage.mock.calls.map(([event]) => event)).toEqual(
        targets.map((target) =>
          expect.objectContaining({
            provider: target.provider,
            model: target.id,
            inputTokens: 4,
            outputTokens: 2,
          }),
        ),
      );
      expect(afterCall).toHaveBeenCalledTimes(targets.length);
      expect(events.filter((event) => event.type === "usage")).toEqual(
        targets.map((target) =>
          expect.objectContaining({ provider: target.provider, model: target.id, accounted: true }),
        ),
      );
    },
  );

  it.each(["reservation", "accounting"])(
    "does not fail over on a local %s timeout",
    async (phase) => {
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
      const localError = new Error("503 local billing timeout");
      const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => {
        if (phase === "reservation") throw localError;
        return "reservation";
      });
      if (phase === "accounting")
        input.onUsage = async () => {
          throw localError;
        };
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        stream(target, message(target, [], "error", "429 provider rate limit")),
      );
      await expect(
        run(
          input,
          [],
          new PiAgentRuntime({
            modelCallObserver: { beforeCall, afterCall: async () => undefined },
          }),
        ),
      ).rejects.toThrow(/local billing timeout/);
      expect(providerState.stream).toHaveBeenCalledTimes(phase === "reservation" ? 0 : 1);
      expect(beforeCall).toHaveBeenCalledTimes(1);
    },
  );

  it("advances after a provider stream throws before output", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) throw new Error("503 provider unavailable");
      return stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
    });
    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
    );
    expect(events).toContainEqual({ type: "text", text: "backup answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("completes on the backup when the primary throws a Kimi 403 usage-limit error", async () => {
    const kimiUsageLimit =
      '403 {"error":{"type":"permission_error","message":"You\'ve reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota"},"type":"error"}';
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) throw new Error(kimiUsageLimit);
      return stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
    });
    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
    );
    expect(events).toContainEqual({ type: "text", text: "backup answer" });
    expect(events.at(-1)).toEqual({ type: "done", text: "backup answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("switches after a Codex idle timeout before output", async () => {
    vi.useFakeTimers();
    try {
      const codex = {
        ...primary,
        provider: "openai-codex",
        api: "openai-codex-responses" as const,
      };
      providerState.models.set(`${codex.provider}/${codex.id}`, codex);
      providerState.stream.mockImplementation(
        (
          target: Model<"openai-completions">,
          _ctx: unknown,
          options: {
            signal: AbortSignal;
            onResponse: (response: Response, model: Model<"openai-completions">) => void;
          },
        ) => {
          if (target.provider !== codex.provider)
            return stream(target, message(target, [{ type: "text", text: "recovered" }], "stop"));
          const result = new AssistantMessageEventStream();
          options.onResponse(new Response(null, { status: 200 }), target);
          options.signal.addEventListener("abort", () => {
            const failure = message(target, [], "aborted", "aborted");
            result.push({ type: "error", reason: "aborted", error: failure });
            result.end(failure);
          });
          return result;
        },
      );
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
      input.model.provider = codex.provider;
      const pending = run(input);
      await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS + 1);
      expect(await pending).toContainEqual({ type: "text", text: "recovered" });
      expect(providerState.stream).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a silent Codex first step once on the same model when there is no backup", async () => {
    vi.useFakeTimers();
    try {
      const codex = {
        ...primary,
        provider: "openai-codex",
        api: "openai-codex-responses" as const,
      };
      providerState.models.set(`${codex.provider}/${codex.id}`, codex);
      let calls = 0;
      providerState.stream.mockImplementation(
        (
          target: Model<"openai-completions">,
          _ctx: unknown,
          options: {
            signal: AbortSignal;
            onResponse: (response: Response, model: Model<"openai-completions">) => void;
          },
        ) => {
          calls += 1;
          if (calls > 1)
            return stream(target, message(target, [{ type: "text", text: "recovered" }], "stop"));
          const result = new AssistantMessageEventStream();
          options.onResponse(new Response(null, { status: 200 }), target);
          options.signal.addEventListener("abort", () => {
            const failure = message(target, [], "aborted", "aborted");
            result.push({ type: "error", reason: "aborted", error: failure });
            result.end(failure);
          });
          return result;
        },
      );
      const input = request();
      input.model.provider = codex.provider;
      const pending = run(input);
      await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS - 1);
      expect(providerState.stream).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2);
      const events = await pending;
      expect(events).toContainEqual({ type: "text", text: "recovered" });
      // The person sees that the reply is reconnecting, with no model or provider named.
      expect(events).toContainEqual({
        type: "progress",
        text: "",
        activity: true,
        phase: "retrying",
      });
      expect(providerState.stream).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the retry of a silent step a longer wait for its first item", async () => {
    vi.useFakeTimers();
    try {
      const codex = {
        ...primary,
        provider: "openai-codex",
        api: "openai-codex-responses" as const,
      };
      providerState.models.set(`${codex.provider}/${codex.id}`, codex);
      let calls = 0;
      providerState.stream.mockImplementation(
        (
          target: Model<"openai-completions">,
          _ctx: unknown,
          options: {
            signal: AbortSignal;
            onResponse: (response: Response, model: Model<"openai-completions">) => void;
          },
        ) => {
          calls += 1;
          const result = new AssistantMessageEventStream();
          options.onResponse(new Response(null, { status: 200 }), target);
          // The retry is only slow: its first item comes after the first attempt's bound.
          if (calls > 1)
            setTimeout(() => {
              const done = message(target, [{ type: "text", text: "slow but fine" }], "stop");
              result.push({ type: "text_start", contentIndex: 0, partial: done });
              result.push({ type: "done", reason: "stop", message: done });
              result.end(done);
            }, MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS + 10_000);
          options.signal.addEventListener("abort", () => {
            const failure = message(target, [], "aborted", "aborted");
            result.push({ type: "error", reason: "aborted", error: failure });
            result.end(failure);
          });
          return result;
        },
      );
      const input = request();
      input.model.provider = codex.provider;
      const pending = run(input);
      await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS * 2 + 10_000 + 1);
      expect(await pending).toContainEqual({ type: "text", text: "slow but fine" });
      expect(providerState.stream).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries once when the provider reports the stalled stream in its own words", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      providerState.stream.mock.calls.length > 1
        ? stream(target, message(target, [{ type: "text", text: "recovered" }], "stop"))
        : stream(
            target,
            message(target, [], "error", `Codex error: ${CODEX_STREAM_IDLE_TIMEOUT_MESSAGE}`),
          ),
    );
    const events = await run(request());
    expect(events).toContainEqual({ type: "text", text: "recovered" });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("records streamed content when the provider iterator throws after output", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "keep this text" }],
      "error",
      "503 timeout",
    );
    providerState.stream.mockImplementation(() => {
      class ThrowingStream extends AssistantMessageEventStream {
        override async *[Symbol.asyncIterator]() {
          yield { type: "start" as const, partial: { ...failure, content: [] } };
          yield {
            type: "text_delta" as const,
            contentIndex: 0,
            delta: "keep this text",
            partial: failure,
          };
          throw new Error("503 timeout");
        }
      }
      return new ThrowingStream();
    });
    const appendMessage = vi.fn(async () => undefined);
    vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
    const events: AgentRuntimeEvent[] = [];
    await expect(
      run(
        request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
        events,
        new PiAgentRuntime({ sessionRoot: "fixture-sessions" }),
      ),
    ).rejects.toThrow(/503 timeout/);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: failure.content }),
    );
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("keep this text");
  });

  it("keeps terminal-only partial text even when usage accounting fails", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "terminal answer" }],
      "error",
      "503 unavailable",
    );
    providerState.stream.mockImplementation(() => stream(primary, failure));
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    input.onUsage = async () => {
      throw new Error("local accounting timeout");
    };
    const appendMessage = vi.fn(async () => undefined);
    vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
    const events: AgentRuntimeEvent[] = [];
    await expect(
      run(input, events, new PiAgentRuntime({ sessionRoot: "fixture-sessions" })),
    ).rejects.toThrow(/local accounting timeout/);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: failure.content }),
    );
    expect(events).toContainEqual({ type: "text", text: "terminal answer" });
  });

  it("continues after a long-retry 429 on a smaller backup without replaying a completed tool effect", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
    ]);
    const executeTool = vi.mocked(input.executeTool!);
    let primaryCalls = 0;
    let backupContext: { messages?: unknown[] } | undefined;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: { messages?: unknown[] }) => {
        if (target.provider === primary.provider) {
          primaryCalls += 1;
          if (primaryCalls === 1) {
            const call = {
              type: "toolCall" as const,
              id: "write-once",
              name: "write_effect",
              arguments: { value: "persist this once" },
            };
            return stream(target, message(target, [call], "toolUse"));
          }
          return stream(
            target,
            message(
              target,
              [],
              "error",
              "Server requested 3301s retry delay (max:60s). 429 rate_limit_error",
            ),
          );
        }
        backupContext = context;
        return stream(
          target,
          message(target, [{ type: "text", text: "Finished safely." }], "stop"),
        );
      },
    );

    const events = await run(input);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(primaryCalls).toBe(2);
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider, backupA.provider]);
    expect(JSON.stringify(backupContext?.messages)).toContain("write-once");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text", text: "Finished safely." }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage", provider: backupA.provider, model: backupA.id }),
    );
  });

  it("keeps the primary on a healthy response and leaves an empty chain unchanged", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [{ type: "text", text: "Primary response." }], "stop")),
    );

    const events = await run(request());

    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(providerState.stream.mock.calls[0]?.[0]).toMatchObject({ provider: primary.provider });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage", provider: primary.provider, model: primary.id }),
    );
  });

  it("keeps helper-model selection on the active backup after the primary fails", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "backup-fixture-key" },
    ]);
    input.model.apiKey = "primary-fixture-key";
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
        readOnly: true,
      },
    ];
    const providers: string[] = [];
    const apiKeys: Array<string | undefined> = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        providers.push(target.provider);
        apiKeys.push(options?.apiKey);
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        if (backupCalls === 1) {
          return stream(
            target,
            message(
              target,
              [
                {
                  type: "toolCall",
                  id: "helper-call",
                  name: "run_subagent",
                  arguments: { name: "helper", task: "Summarize the fixture." },
                },
              ],
              "toolUse",
            ),
          );
        }
        return stream(target, message(target, [{ type: "text", text: "Complete." }], "stop"));
      },
    );

    await run(input);

    expect(providers).toEqual([
      primary.provider,
      backupA.provider,
      backupA.provider,
      backupA.provider,
    ]);
    expect(apiKeys).toEqual([
      "primary-fixture-key",
      "backup-fixture-key",
      "backup-fixture-key",
      "backup-fixture-key",
    ]);
  });

  it("keeps a refreshed backup OAuth token for later helper calls", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
        readOnly: true,
      },
    ];
    input.resolveFallbackModel = vi.fn(async () => ({
      provider: backupA.provider,
      id: backupA.id,
      oauth: {
        credential: {
          type: "oauth" as const,
          access: "backup-access-before-refresh",
          refresh: "backup-refresh",
          expires: Date.now() + 60_000,
        },
      },
    }));
    const backupKeys: Array<string | undefined> = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        backupKeys.push(options?.apiKey);
        if (backupCalls !== 1) {
          return stream(target, message(target, [{ type: "text", text: "Complete." }], "stop"));
        }
        const credentialStore = providerState.credentialStores[0] as CredentialStore;
        const response = message(
          target,
          [
            {
              type: "toolCall",
              id: "oauth-helper-call",
              name: "run_subagent",
              arguments: { name: "helper", task: "Summarize the fixture." },
            },
          ],
          "toolUse",
        );
        const output = new AssistantMessageEventStream();
        void (async () => {
          await credentialStore.modify(backupA.provider, async (current) => {
            if (current?.type !== "oauth") throw new Error("OAuth credential missing in fixture");
            return { ...current, access: "backup-access-after-refresh" };
          });
          for await (const event of stream(target, response)) output.push(event);
          output.end(response);
        })();
        return output;
      },
    );

    const events = await run(input);

    expect(backupKeys).toEqual([
      "backup-access-before-refresh",
      "backup-access-after-refresh",
      "backup-access-after-refresh",
    ]);
    expect(JSON.stringify(events)).not.toContain("backup-access-before-refresh");
    expect(JSON.stringify(events)).not.toContain("backup-access-after-refresh");
  });

  it("persists the selected model before streaming from the backup", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    let modelChangePersisted = false;
    input.onModelChange = vi.fn(async () => {
      await Promise.resolve();
      modelChangePersisted = true;
    });
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) {
        return stream(target, message(target, [], "error", "429 rate_limit_error"));
      }
      expect(modelChangePersisted).toBe(true);
      return stream(target, message(target, [{ type: "text", text: "backup response" }], "stop"));
    });

    const events = await run(input);

    expect(input.onModelChange).toHaveBeenCalledExactlyOnceWith(backupA.provider, backupA.id);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "progress",
        text: expect.stringContaining(backupA.id),
      }),
    );
  });

  it("prunes new screenshots using the active backup image limit", async () => {
    const visionBackup = { ...backupA, input: ["text", "image"] };
    providerState.models.set(`${backupA.provider}/${backupA.id}`, visionBackup);
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.resolveFallbackModel = async () => ({
      provider: backupA.provider,
      id: backupA.id,
      apiKey: "test-key",
      maxImagesPerPrompt: 1,
    });
    input.tools = [
      {
        name: "computer_observe",
        description: "Read the screen",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];
    input.executeTool = vi.fn(async () => ({
      kind: "agent_tool_result",
      content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      details: { frameId: "test-frame" },
    }));
    let calls = 0;
    const counts: number[] = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: Context) => {
        if (target.provider === primary.provider)
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        counts.push(
          context.messages.reduce(
            (total, item) =>
              total +
              (typeof item.content === "string"
                ? 0
                : item.content.filter((part) => part.type === "image").length),
            0,
          ),
        );
        calls += 1;
        return calls <= 2
          ? stream(
              target,
              message(
                target,
                [
                  {
                    type: "toolCall",
                    id: `frame-${calls}`,
                    name: "computer_observe",
                    arguments: {},
                  },
                ],
                "toolUse",
              ),
            )
          : stream(target, message(target, [{ type: "text", text: "Done" }], "stop"));
      },
    );
    await run(input);
    expect(counts).toEqual([0, 1, 1]);
    expect(input.executeTool).toHaveBeenCalledTimes(2);
  });

  it("preserves terminal partial text while refusing unsafe failover", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "partial answer" }],
      "error",
      "429 rate_limit_error",
    );
    providerState.stream.mockImplementation(() => stream(primary, failure));
    const events: AgentRuntimeEvent[] = [];
    await expect(run(request(), events)).rejects.toThrow(/429 rate_limit_error/);
    expect(events).toContainEqual({ type: "text", text: "partial answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "records streamed output and terminal suffixes with emptyTerminal=%s",
    async (emptyTerminal) => {
      const targetMessage = message(
        primary,
        [{ type: "text", text: "partial plus terminal suffix" }],
        "error",
        "429 rate_limit_error",
      );
      providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
        if (target.provider === primary.provider) {
          const result = new AssistantMessageEventStream();
          const partial = { ...targetMessage, content: [] };
          result.push({ type: "start", partial });
          result.push({ type: "text_start", contentIndex: 0, partial });
          result.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "partial",
            partial: { ...targetMessage, content: [{ type: "text", text: "partial" }] },
          });
          const terminal = emptyTerminal ? { ...targetMessage, content: [] } : targetMessage;
          result.push({ type: "error", reason: "error", error: terminal });
          result.end(terminal);
          return result;
        }
        return stream(target, message(target, [{ type: "text", text: "must not run" }], "stop"));
      });

      const appendMessage = vi.fn(async () => undefined);
      vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
      const events: AgentRuntimeEvent[] = [];
      await expect(
        run(
          request([{ provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" }]),
          events,
          new PiAgentRuntime({ sessionRoot: "fixture-sessions" }),
        ),
      ).rejects.toThrow(/429 rate_limit_error/);

      expect(providerState.stream).toHaveBeenCalledTimes(1);
      expect(appendMessage).toHaveBeenCalledWith(
        emptyTerminal
          ? { ...targetMessage, content: [{ type: "text", text: "partial" }] }
          : targetMessage,
      );
      expect(
        events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
      ).toBe(emptyTerminal ? "partial" : "partial plus terminal suffix");
    },
  );

  it("keeps terminal error text when nothing was streamed and does not switch", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "terminal partial" }],
      "error",
      "429 rate_limit_error",
    );
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, failure)
        : stream(target, message(target, [{ type: "text", text: "must not run" }], "stop")),
    );
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    const events: Array<{ type: string; text?: string }> = [];
    const runtime = new PiAgentRuntime();
    const consume = async () => {
      for await (const event of runtime.run(input, {
        operationId: "operation",
        traceId: "trace",
        spaceId: "space",
        userId: "user",
        signal: new AbortController().signal,
      })) {
        events.push(event);
      }
    };

    await expect(consume()).rejects.toThrow(/429 rate_limit_error/);

    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text", text: "terminal partial" }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "text", text: "must not run" }),
    );
  });

  it("prunes later screenshots with the active backup image limit", async () => {
    const input = request([
      {
        provider: backupA.provider,
        id: backupA.id,
        apiKey: "backup-key",
        maxImagesPerPrompt: 1,
      },
    ]);
    input.model = { ...input.model, maxImagesPerPrompt: 3 };
    input.tools = [
      {
        name: "computer_observe",
        description: "Observe the computer",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    let shots = 0;
    input.executeTool = vi.fn(async () => {
      shots += 1;
      return {
        kind: "agent_tool_result" as const,
        content: [
          { type: "text" as const, text: `frame ${shots}` },
          { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" as const },
        ],
        details: { frameId: `frame-${shots}` },
      };
    });
    const backupImageCounts: number[] = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: { messages?: unknown[] }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        backupImageCounts.push(countContextImages(context));
        if (backupCalls <= 3) {
          const call = {
            type: "toolCall" as const,
            id: `observe-${backupCalls}`,
            name: "computer_observe",
            arguments: {},
          };
          return stream(target, message(target, [call], "toolUse"));
        }
        return stream(target, message(target, [{ type: "text", text: "done looking" }], "stop"));
      },
    );

    await run(input);

    expect(backupCalls).toBe(4);
    expect(backupImageCounts[0]).toBe(0);
    expect(backupImageCounts.at(-1)).toBe(1);
  });

  it.each([
    {
      label: "thinking",
      content: [{ type: "thinking" as const, thinking: "terminal reasoning" }],
    },
    {
      label: "tool call",
      content: [
        {
          type: "toolCall" as const,
          id: "terminal-call",
          name: "write_effect",
          arguments: { value: "must not execute" },
        },
      ],
    },
  ])(
    "does not switch when the terminal error contains partial $label without deltas",
    async ({ content, label }) => {
      const failure = message(primary, content, "error", "429 rate_limit_error");
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        target.provider === primary.provider
          ? stream(target, failure)
          : stream(target, message(target, [{ type: "text", text: "must not run" }], "stop")),
      );
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
      const events: Array<{ type: string; text?: string }> = [];
      const runtime = new PiAgentRuntime();
      const consume = async () => {
        for await (const event of runtime.run(input, {
          operationId: "operation",
          traceId: "trace",
          spaceId: "space",
          userId: "user",
          signal: new AbortController().signal,
        })) {
          events.push(event);
        }
      };

      await expect(consume()).rejects.toThrow(/429 rate_limit_error/);

      expect(providerState.stream).toHaveBeenCalledTimes(1);
      if (label === "text") {
        expect(events).toContainEqual(
          expect.objectContaining({ type: "text", text: "terminal partial" }),
        );
      }
      expect(input.executeTool).not.toHaveBeenCalled();
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "text", text: "must not run" }),
      );
      expect(label).toBeTruthy();
    },
  );

  it("does not switch because a tool failed", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
    ]);
    input.executeTool = vi.fn(async () => {
      throw new Error("tool permission denied");
    });
    let primaryCalls = 0;
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      primaryCalls += 1;
      if (primaryCalls === 1) {
        const call = {
          type: "toolCall" as const,
          id: "failed-tool",
          name: "write_effect",
          arguments: { value: "denied" },
        };
        return stream(target, message(target, [call], "toolUse"));
      }
      return stream(
        target,
        message(target, [{ type: "text", text: "The tool was denied." }], "stop"),
      );
    });

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider]);
  });

  it("tries each backup once in order, then retries the last before surfacing exhaustion", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "error", "529 overloaded_error")),
    );

    await expect(
      run(
        request([
          { provider: primary.provider, id: primary.id, apiKey: "duplicate-primary" },
          { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
          { provider: backupA.provider, id: backupA.id, apiKey: "duplicate-backup" },
          { provider: backupB.provider, id: backupB.id, apiKey: "fake-backup-b" },
        ]),
      ),
    ).rejects.toThrow(/overloaded_error/);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupA.provider, ...Array<string>(4).fill(backupB.provider)]);
  });

  it("skips a backup that cannot fit the actual prompt and selects the next smaller-than-primary fit", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "small...key" },
      { provider: backupB.provider, id: backupB.id, apiKey: "fitti...key" },
    ]);
    input.prompt = "x".repeat(20_000);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "fit" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it("uses a small-context backup when the actual input and configured output fit", async () => {
    const smallContextBackup = model("provider-small", "small-context", 2_048);
    providerState.models.set(
      `${smallContextBackup.provider}/${smallContextBackup.id}`,
      smallContextBackup as unknown as Record<string, unknown>,
    );
    const input = request([
      {
        provider: smallContextBackup.provider,
        id: smallContextBackup.id,
        apiKey: "small...key",
        maxTokens: 512,
      },
    ]);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "fits" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, smallContextBackup.provider]);
  });

  it("skips backups without the primary turn's reasoning capability", async () => {
    const reasoningPrimary = { ...primary, reasoning: true };
    const textOnlyBackup = { ...backupA, reasoning: false };
    const reasoningBackup = { ...backupB, reasoning: true };
    providerState.models.set(`${primary.provider}/${primary.id}`, reasoningPrimary);
    providerState.models.set(`${backupA.provider}/${backupA.id}`, textOnlyBackup);
    providerState.models.set(`${backupB.provider}/${backupB.id}`, reasoningBackup);
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "text-only-key" },
      { provider: backupB.provider, id: backupB.id, apiKey: "reasoning-key" },
    ]);
    input.model.reasoning = true;
    input.model.thinkingLevel = "high";
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "reasoned" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it.each([...IMAGE_RETURNING_COMPUTER_TOOLS, "write_effect"])(
    "requires image-capable backups only when %s can return screenshots",
    async (toolName) => {
      providerState.models.set(`${backupA.provider}/${backupA.id}`, {
        ...backupA,
        input: ["text"],
      });
      const input = request([
        { provider: backupA.provider, id: backupA.id, apiKey: "text-only-key" },
        { provider: backupB.provider, id: backupB.id, apiKey: "image-backup-key" },
      ]);
      input.tools = [{ ...input.tools[0]!, name: toolName }];
      providerState.stream.mockImplementation(
        (target: Model<"openai-completions">, context: Context) => {
          expect(countContextImages(context)).toBe(0);
          return target.provider === primary.provider
            ? stream(target, message(target, [], "error", "429 rate_limit_error"))
            : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
        },
      );

      await run(input);

      expect(
        providerState.stream.mock.calls.map(
          ([target]) => (target as Model<"openai-completions">).provider,
        ),
      ).toEqual([
        primary.provider,
        IMAGE_RETURNING_COMPUTER_TOOLS.has(toolName) ? backupB.provider : backupA.provider,
      ]);
    },
  );

  it("skips backups that cannot accept the current image input", async () => {
    const textOnlyBackup = { ...backupA, input: ["text"] as ["text"] };
    providerState.models.set(`${backupA.provider}/${backupA.id}`, textOnlyBackup);
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "text-only-key" },
      { provider: backupB.provider, id: backupB.id, apiKey: "image-backup-key" },
    ]);
    input.currentTurnImages = [
      { name: "fixture.png", mimeType: "image/png", data: new Uint8Array([1]) },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "image understood" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it("uses a native vision backup with acceptsImages false after a 429", async () => {
    providerState.models.set(`${backupA.provider}/${backupA.id}`, {
      ...backupA,
      input: ["text", "image"],
    });
    const input = request([
      {
        provider: backupA.provider,
        id: backupA.id,
        apiKey: "vision-backup-key",
        acceptsImages: false,
      },
    ]);
    input.tools = [
      {
        name: "computer_observe",
        description: "Read the screen",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "saw the screen" }], "stop")),
    );

    const events = await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupA.provider]);
    expect(events.at(-1)).toEqual({ type: "done", text: "saw the screen" });
  });

  it("still skips a native text-only backup when screen tools can return images", async () => {
    providerState.models.set(`${backupA.provider}/${backupA.id}`, {
      ...backupA,
      input: ["text"],
    });
    const input = request([
      {
        provider: backupA.provider,
        id: backupA.id,
        apiKey: "text-only-key",
        acceptsImages: false,
      },
    ]);
    input.tools = [
      {
        name: "computer_observe",
        description: "Read the screen",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "error", "429 rate_limit_error")),
    );

    await expect(run(input)).rejects.toThrow(/429 rate_limit_error/);
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual(Array(5).fill(primary.provider));
  });

  it("skips an OpenAI-compatible backup with acceptsImages false and uses one with true", async () => {
    const refused = model("openai-compatible", "compat-refused", 16_384);
    const accepted = model("openai-compatible", "compat-accepted", 16_384);
    providerState.models.set(`${refused.provider}/${refused.id}`, {
      ...refused,
      input: ["text", "image"],
    });
    providerState.models.set(`${accepted.provider}/${accepted.id}`, {
      ...accepted,
      input: ["text", "image"],
    });
    const input = request([
      {
        provider: refused.provider,
        id: refused.id,
        apiKey: "compat-refused-key",
        baseUrl: "https://compat.invalid/v1",
        acceptsImages: false,
      },
      {
        provider: accepted.provider,
        id: accepted.id,
        apiKey: "compat-accepted-key",
        baseUrl: "https://compat.invalid/v1",
        acceptsImages: true,
      },
    ]);
    input.tools = [
      {
        name: "computer_observe",
        description: "Read the screen",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "compat saw it" }], "stop")),
    );

    const events = await run(input);

    expect(
      providerState.stream.mock.calls.map(([target]) => target as Model<"openai-completions">),
    ).toEqual([
      expect.objectContaining({ provider: primary.provider, id: primary.id }),
      expect.objectContaining({ provider: accepted.provider, id: accepted.id }),
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "compat saw it" });
  });

  it("does not persist or start a backup when cancellation wins during credential resolution", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    let releaseResolution: ((model: AgentRunRequest["model"]) => void) | undefined;
    input.resolveFallbackModel = vi.fn(
      () =>
        new Promise<AgentRunRequest["model"]>((resolve) => {
          releaseResolution = resolve;
        }),
    );
    const onModelChange = vi.fn(async () => undefined);
    input.onModelChange = onModelChange;
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(
        target,
        target.provider === primary.provider
          ? message(target, [], "error", "429 rate_limit_error")
          : message(target, [{ type: "text", text: "must not start" }], "stop"),
      ),
    );
    const controller = new AbortController();
    const runtime = new PiAgentRuntime();
    const consume = async () => {
      try {
        for await (const _event of runtime.run(input, {
          operationId: "operation",
          traceId: "trace",
          spaceId: "space",
          userId: "user",
          signal: controller.signal,
        })) {
          // Drain the runtime stream while cancellation is tested.
        }
      } catch {
        // Cancellation is surfaced as a stopped run by the outer runtime.
      }
    };
    const running = consume();
    await vi.waitFor(() => expect(input.resolveFallbackModel).toHaveBeenCalledOnce());
    controller.abort();
    releaseResolution?.({ provider: backupA.provider, id: backupA.id, apiKey: "test-backup-key" });
    await running;

    expect(onModelChange).not.toHaveBeenCalled();
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider]);
  });

  it("skips a backup with changed credentials and uses only the next backup's credential", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id },
      { provider: backupB.provider, id: backupB.id },
    ]);
    const resolveFallbackModel = vi.fn(async (provider: string, id: string) => {
      if (provider === backupA.provider) throw new Error("connected credential changed");
      return { provider, id, apiKey: "backup-only-key" };
    });
    input.resolveFallbackModel = resolveFallbackModel;
    const requestKeys: Array<string | undefined> = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        requestKeys.push(options?.apiKey);
        return stream(target, message(target, [{ type: "text", text: "safe" }], "stop"));
      },
    );

    const events = await run(input);

    expect(resolveFallbackModel).toHaveBeenNthCalledWith(1, backupA.provider, backupA.id);
    expect(resolveFallbackModel).toHaveBeenNthCalledWith(2, backupB.provider, backupB.id);
    expect(requestKeys).toEqual(["backup-only-key"]);
    expect(JSON.stringify(events)).not.toContain("backup-only-key");
  });
});

describe("provider availability classification", () => {
  it.each([
    ["dropped fetch body", new TypeError("terminated"), true],
    [
      "Codex overload",
      new Error("Codex error: Our servers are currently overloaded. Please try again later."),
      true,
    ],
    [
      "HTTP 400 before retry text",
      { status: 400, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "HTTP 401 before retry text",
      { statusCode: 401, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "HTTP 403 before retry text",
      { httpStatus: 403, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "unprocessable input before retry text",
      { status: 422, message: "The request cannot be processed; 429 rate limit" },
      false,
    ],
    [
      "cancellation",
      new Error("user cancelled request; retry after 3301 seconds; 429 rate limit"),
      false,
    ],
    [
      "consent refusal",
      new Error("user declined consent; retry after 3301 seconds; 429 rate limit"),
      false,
    ],
    [
      "Kimi 403 5-hour usage limit",
      {
        status: 403,
        type: "permission_error",
        message:
          "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.",
      },
      true,
    ],
    [
      "Kimi 403 5-hour usage limit, curly apostrophe",
      {
        status: 403,
        type: "permission_error",
        message: "You\u2019ve reached your 5-hour usage limit.",
      },
      true,
    ],
    [
      "Kimi 403 weekly usage limit",
      {
        status: 403,
        type: "permission_error",
        message: "You've reached your weekly (7-day) usage limit.",
      },
      true,
    ],
    [
      "Kimi 403 monthly usage limit",
      {
        status: 403,
        type: "permission_error",
        message: "You've reached your monthly usage limit.",
      },
      true,
    ],
    [
      "Kimi 403 billing-cycle usage limit",
      {
        status: 403,
        type: "permission_error",
        message: "You've reached your usage limit for this billing cycle.",
      },
      true,
    ],
    [
      "HTTP 401 with nested Kimi 403 usage limit",
      {
        status: 401,
        cause: { status: 403, message: "You've reached your monthly usage limit." },
      },
      false,
    ],
    [
      "Kimi 403 monthly usage limit not reached",
      {
        status: 403,
        message: "You have not reached your monthly usage limit; access denied",
      },
      false,
    ],
    [
      "Kimi 401",
      {
        status: 401,
        type: "invalid_authentication_error",
        message: "The API Key appears to be invalid or may have expired.",
      },
      false,
    ],
    [
      "Kimi 403 concurrent request limit",
      {
        status: 403,
        message:
          "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.",
      },
      false,
    ],
    [
      "generic 403 permission_error",
      { status: 403, type: "permission_error", message: "permission denied" },
      false,
    ],
    ["quota exhaustion", { status: 402, message: "provider quota exhausted" }, true],
    ["plain status", new Error("503 provider unavailable"), true],
    ["HTTP server status", new Error("HTTP 500"), true],
    ["context overflow", new Error("context_length_exceeded; retry after 60s"), false],
    ["transient server failure", { status: 503, message: "service unavailable" }, true],
  ])("classifies %s", (_label, error, expected) => {
    expect(isRetryableProviderUnavailable(error)).toBe(expected);
  });
});

describe("Pi runtime interject", () => {
  it("aborts only the live model stream, steers the flagged message in, and continues the run", async () => {
    const partial = message(primary, [{ type: "text", text: "Partial answer" }], "stop");
    const contexts: Context[] = [];
    providerState.stream.mockImplementation(
      (
        _model: Model<"openai-completions">,
        context: Context,
        options: { signal?: AbortSignal },
      ) => {
        contexts.push(context);
        if (contexts.length === 2) {
          return stream(primary, message(primary, [{ type: "text", text: "Switched." }], "stop"));
        }
        const signal = options.signal!;
        class InterruptedStream extends AssistantMessageEventStream {
          override async *[Symbol.asyncIterator]() {
            yield { type: "start" as const, partial: { ...partial, content: [] } };
            yield {
              type: "text_delta" as const,
              contentIndex: 0,
              delta: "Partial answer",
              partial,
            };
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new Error("Request was aborted");
          }
        }
        return new InterruptedStream();
      },
    );
    const input = request();
    let claims = 0;
    input.claimSteering = vi.fn(async (seenIds: string[]) => {
      claims += 1;
      if (seenIds.includes("steer-1") || claims === 1) return [];
      return [
        {
          id: "steer-1",
          messageId: "message-1",
          text: "Stop, use the other file",
          interrupt: true as const,
        },
      ];
    });
    const events = await run(input, [], new PiAgentRuntime({ interjectPollMs: 5 }));

    expect(contexts).toHaveLength(2);
    const continued = contexts[1]!.messages.slice(-2);
    expect(continued[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial answer" }],
    });
    expect(continued[1]).toMatchObject({ role: "user" });
    expect(JSON.stringify(continued[1])).toContain("Stop, use the other file");
    expect(events.map((event) => event.type)).not.toContain("error");
    expect(events.at(-1)).toEqual({ type: "done", text: "Partial answer\n\nSwitched." });
    expect(providerState.agent!.state.errorMessage).toBeUndefined();
  });

  it("reads a message that arrived during the step instead of pausing on that step's question", async () => {
    const ask = message(
      primary,
      [
        {
          type: "toolCall",
          id: "ask-1",
          name: "ask_user",
          arguments: { question: "What next?", options: ["Find 100", "Another round"] },
        },
      ],
      "toolUse",
    );
    let calls = 0;
    providerState.stream.mockImplementation(() => {
      calls += 1;
      if (calls > 1)
        return stream(primary, message(primary, [{ type: "text", text: "Scaling." }], "stop"));
      class SlowAsk extends AssistantMessageEventStream {
        override async *[Symbol.asyncIterator]() {
          yield { type: "start" as const, partial: { ...ask, content: [] } };
          // The recruiter's message is claimed while this step streams, but the claim lands only
          // after the step already called ask_user, too late for the interjection to abort it.
          await new Promise((resolve) => setTimeout(resolve, 15));
          yield* stream(primary, ask) as unknown as AsyncIterable<never>;
        }
      }
      return new SlowAsk();
    });
    const input = request();
    input.tools = [
      ...input.tools,
      {
        name: "ask_user",
        description: "Ask the user.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: { type: "array", items: { type: "string" } },
          },
          required: ["question"],
        },
        readOnly: true,
      },
    ];
    let claims = 0;
    input.claimSteering = vi.fn(async (seenIds: string[]) => {
      claims += 1;
      if (claims === 1 || seenIds.includes("steer-1")) return [];
      await new Promise((resolve) => setTimeout(resolve, 30));
      return [
        {
          id: "steer-1",
          messageId: "message-1",
          text: "Find 100 more like them.",
          interrupt: true as const,
        },
      ];
    });
    const events = await run(input, [], new PiAgentRuntime({ interjectPollMs: 5 }));
    expect(events.some((event) => event.type === "ask")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("drops an interrupted assistant message that carries no text", () => {
    const messages = [
      { role: "user", content: "hi", timestamp: 1 },
      { ...message(primary, [{ type: "toolCall", id: "c", name: "t", arguments: {} }], "aborted") },
    ] as AgentMessage[];
    keepInterruptedAssistantMessage(messages);
    expect(messages).toHaveLength(1);
    const kept = [
      {
        ...message(
          primary,
          [
            { type: "text", text: "keep" },
            { type: "toolCall", id: "c", name: "t", arguments: {} },
          ],
          "aborted",
        ),
      },
    ] as AgentMessage[];
    keepInterruptedAssistantMessage(kept);
    expect(kept[0]).toMatchObject({ content: [{ type: "text", text: "keep" }] });
  });
});

it("publishes a safe thinking progress at most once per 5 seconds", async () => {
  let clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
    const response = message(target, [{ type: "text", text: "Done." }], "stop");
    const result = new AssistantMessageEventStream();
    const partial = { ...response, content: [] };
    const think = (delta: string) =>
      result.push({ type: "thinking_delta", contentIndex: 0, delta, partial });
    void (async () => {
      result.push({ type: "start", partial });
      think("**Checking the Instantly campaign via write_effect**");
      think("\n\nsecret plan step two for id ck9x2m4q8p0000abcd1234efgh");
      await new Promise((resolve) => setTimeout(resolve, 20));
      clock += 4_999;
      think("still within the window");
      await new Promise((resolve) => setTimeout(resolve, 20));
      clock += 1;
      think("\nwindow elapsed");
      await new Promise((resolve) => setTimeout(resolve, 20));
      result.push({ type: "done", reason: "stop", message: response });
      result.end(response);
    })();
    return result;
  });
  const events = await run(request());
  const thinking = events.filter(
    (event) => event.type === "progress" && event.phase === "thinking",
  );
  expect(thinking).toEqual([
    {
      type: "progress",
      text: "",
      activity: true,
      phase: "thinking",
      summary: "Checking the campaign via",
      thought: "Checking the campaign via",
      at: new Date(1_000_000).toISOString(),
    },
    {
      type: "progress",
      text: "",
      activity: true,
      phase: "thinking",
      summary: "Checking the campaign via",
      thought: "Checking the campaign via",
      at: new Date(1_005_000).toISOString(),
    },
  ]);
  // Vendor names, tool names and ids never reach the thread; only the first line is shown.
  expect(JSON.stringify(thinking)).not.toMatch(/Instantly|write_effect|ck9x2m4q8p|secret/);
});

it("derives the thinking summary from the last tool category only", () => {
  expect(thinkingSummary(undefined)).toBe("Thinking");
  expect(thinkingSummary("recruiting_candidates")).toBe("Reviewing candidates");
  expect(thinkingSummary("unknown_tool")).toBe("Thinking");
});

it("passes tool-call arguments parsed so far to the run while the model writes them", async () => {
  providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
    const response = message(target, [{ type: "text", text: "Done." }], "stop");
    const result = new AssistantMessageEventStream();
    const call = {
      type: "toolCall" as const,
      id: "call-1",
      name: "picks",
      arguments: { keys: ["a"] },
    };
    const partial = { ...response, content: [call] };
    void (async () => {
      result.push({ type: "start", partial });
      result.push({ type: "toolcall_delta", contentIndex: 0, delta: '"a"', partial });
      await new Promise((resolve) => setTimeout(resolve, 10));
      result.push({ type: "done", reason: "stop", message: response });
      result.end(response);
    })();
    return result;
  });
  const deltas: unknown[] = [];
  await run({ ...request(), onToolCallDelta: (call) => deltas.push(call) });
  expect(deltas).toEqual([{ id: "call-1", name: "picks", args: { keys: ["a"] } }]);
});

describe("provider rate-limit facts", () => {
  it.each([
    ["429 rate limit", true, undefined],
    ["Rate limit reached. Please try again in 1.5s.", true, 1_500],
    ["Too Many Requests; retry-after: 12", true, 12_000],
    ["rate_limit_error retry_after_ms=750", true, 750],
    ["429; retry after 900 seconds", true, 60_000],
    ["HTTP 503 unavailable", false, undefined],
  ])("%s", (error, limited, wait) => {
    expect(isProviderRateLimited(new Error(error))).toBe(limited);
    expect(providerRetryAfterMs(new Error(error))).toBe(wait);
  });
});

it("compacts and retries once when the provider rejects the request as too long", async () => {
  const { target, input } = compactionRequest(true);
  // Our estimate fits; the provider counts more and refuses.
  target.contextWindow = 400_000;
  let answers = 0;
  let summaries = 0;
  providerState.stream.mockImplementation(
    (_model: Model<"openai-completions">, context: Context) => {
      if (context.systemPrompt?.includes("summarization assistant")) {
        summaries++;
        return stream(
          target,
          message(target, [{ type: "text", text: "Earlier completed work." }], "stop"),
        );
      }
      return ++answers === 1
        ? stream(target, message(target, [], "error", "prompt is too long: 412000 tokens > 400000"))
        : stream(target, message(target, [{ type: "text", text: "Recovered." }], "stop"));
    },
  );
  expect((await run(input)).at(-1)).toEqual({ type: "done", text: "Recovered." });
  expect(answers).toBe(2);
  expect(summaries).toBeGreaterThan(0);
  expect(
    providerState.agent!.state.messages.some((entry) => entry.role === "compactionSummary"),
  ).toBe(true);
});

it("fails normally when the retried request is still too long", async () => {
  const { target, input } = compactionRequest(true);
  target.contextWindow = 400_000;
  providerState.stream.mockImplementation(
    (_model: Model<"openai-completions">, context: Context) =>
      context.systemPrompt?.includes("summarization assistant")
        ? stream(target, message(target, [{ type: "text", text: "Summary." }], "stop"))
        : stream(target, message(target, [], "error", "context_length_exceeded")),
  );
  await expect(run(input)).rejects.toThrow("context_length_exceeded");
});
