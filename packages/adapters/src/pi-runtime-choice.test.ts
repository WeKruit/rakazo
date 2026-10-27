import type { AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  options: ["Berlin", "Seoul", "Toronto"],
  question: "Which city should I use?",
  form: undefined as Record<string, unknown> | undefined,
  plannedSearches: undefined as string[] | undefined,
  result: undefined as unknown,
  steered: [] as unknown[],
  tools: [] as Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>,
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: typeof fakeAgentState.tools;

    constructor(options: { initialState: { tools: typeof fakeAgentState.tools } }) {
      this.tools = options.initialState.tools;
      fakeAgentState.tools = this.tools;
    }

    subscribe(_listener: unknown) {}

    async prompt() {
      const askUser = this.tools.find((tool) => tool.name === "ask_user");
      if (!askUser) throw new Error("ask_user tool missing");
      fakeAgentState.result = await askUser.execute("call-choice-1", {
        question: fakeAgentState.question,
        ...(fakeAgentState.plannedSearches
          ? { plannedSearches: fakeAgentState.plannedSearches }
          : {}),
        ...(fakeAgentState.form
          ? { requestedSchema: fakeAgentState.form }
          : { options: fakeAgentState.options }),
      });
    }

    async waitForIdle() {}

    steer(message: unknown) {
      fakeAgentState.steered.push(message);
    }

    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "choice-pi-model" ? { provider: "test", id: modelId } : undefined,
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
  }),
}));

vi.mock("./pi-current-models.js", () => ({
  supplementPiModels: (models: unknown) => models,
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const choiceTool: ConnectorTool = {
  name: "ask_user",
  description: "Ask a short multiple-choice question",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: { type: "array", items: { type: "string" } },
    },
    required: ["question", "options"],
  },
};

const runContext = {
  operationId: "choice-pi",
  traceId: "choice-pi",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const runRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "ask me which city to use",
  instructions: "Use ask_user for a short list of options.",
  history: [],
  tools: [choiceTool],
  model: { provider: "test", id: "choice-pi-model" },
};

describe("Pi choice asks", () => {
  beforeEach(() => {
    fakeAgentState.tools = [];
    fakeAgentState.options = ["Berlin", "Seoul", "Toronto"];
    fakeAgentState.form = undefined;
    fakeAgentState.plannedSearches = undefined;
    fakeAgentState.question = "Which city should I use?";
  });

  it("carries the searches planned on the last intake question to the ask", async () => {
    fakeAgentState.plannedSearches = ["warehouse supervisor Newark NJ", "sort lead Edison NJ"];
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run(runRequest, runContext)) events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ask",
        plannedSearches: ["warehouse supervisor Newark NJ", "sort lead Edison NJ"],
      }),
    );
  });

  it("emits the standard multi-field schema on the native ask and pauses", async () => {
    fakeAgentState.form = {
      type: "object",
      properties: {
        website: { type: "string", format: "uri" },
        regions: { type: "array", items: { type: "string", enum: ["north", "south"] } },
      },
      required: ["website"],
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run(runRequest, runContext)) events.push(event);
    expect(events).toContainEqual({
      type: "ask",
      text: "Which city should I use?",
      requestedSchema: fakeAgentState.form,
    });
    expect(events.some((event) => event.type === "text")).toBe(false);
  });

  it("emits a tappable ask and stops without a finished-work fallback", async () => {
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    expect(events).toContainEqual({
      type: "ask",
      text: "Which city should I use?",
      actions: [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
        { id: "choice-3", label: "Toronto" },
      ],
    });
    expect(
      events.some((event) => event.type === "text" && event.text.includes("I finished the work.")),
    ).toBe(false);
  });

  it("rejects an empty choice set before emitting an ask", async () => {
    fakeAgentState.options = [];
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    await expect(async () => {
      for await (const event of runtime.run(runRequest, runContext)) events.push(event);
    }).rejects.toThrow("ask_user requires two to four unique, non-empty options");
    expect(events.some((event) => event.type === "ask")).toBe(false);
  });

  it.each([
    "Which city should I use? And what salary range?",
    "Please answer:\n1. Which city\n2. Which salary range",
  ])("refuses more than one question in one ask: %s", async (question) => {
    fakeAgentState.question = question;
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    await expect(async () => {
      for await (const event of runtime.run(runRequest, runContext)) events.push(event);
    }).rejects.toThrow("Ask one question at a time");
    expect(events.some((event) => event.type === "ask")).toBe(false);
  });

  it("answers a question the conversation already answered instead of asking again", async () => {
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    const request = { ...runRequest, beforeAsk: async () => '"Which city?" → "Seoul"' };
    for await (const event of runtime.run(request, runContext)) events.push(event);
    expect(events.some((event) => event.type === "ask")).toBe(false);
    expect(JSON.stringify(fakeAgentState.result)).toContain("Already answered");
  });

  it("gives the run's question check the planned searches", async () => {
    fakeAgentState.plannedSearches = ["warehouse supervisor Newark NJ", "sort lead Edison NJ"];
    const beforeAsk = vi.fn(async () => undefined);
    const runtime = new PiAgentRuntime();
    for await (const _event of runtime.run({ ...runRequest, beforeAsk }, runContext));
    expect(beforeAsk).toHaveBeenCalledWith("Which city should I use?", [
      "warehouse supervisor Newark NJ",
      "sort lead Edison NJ",
    ]);
  });

  it("returns the run's own reason instead of a card the run may not ask yet", async () => {
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    const request = {
      ...runRequest,
      beforeAsk: async () => ({ instead: "Not asked: record the ten first." }),
    };
    for await (const event of runtime.run(request, runContext)) events.push(event);
    expect(events.some((event) => event.type === "ask")).toBe(false);
    expect(JSON.stringify(fakeAgentState.result)).toContain("Not asked: record the ten first.");
  });

  it("reads a message that arrived while the question was written instead of pausing on it", async () => {
    fakeAgentState.steered = [];
    const claims = [
      [],
      [{ id: "steer-1", messageId: "message-9", text: "Find 100 more like them." }],
    ];
    const claimSteering = vi.fn(async () => claims.shift() ?? []);
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run({ ...runRequest, claimSteering }, runContext))
      events.push(event);
    expect(events.some((event) => event.type === "ask")).toBe(false);
    expect(JSON.stringify(fakeAgentState.result)).toContain(
      "Not asked: the user sent a new message",
    );
    expect(JSON.stringify(fakeAgentState.steered)).toContain("Find 100 more like them.");
  });

  it("still asks when nothing new arrived", async () => {
    const claimSteering = vi.fn(async () => []);
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run({ ...runRequest, claimSteering }, runContext))
      events.push(event);
    expect(events.some((event) => event.type === "ask")).toBe(true);
  });
});
