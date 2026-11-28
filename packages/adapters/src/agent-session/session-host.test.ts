import type {
  AgentLane,
  AgentTool,
  HarnessEvent,
  Session,
  SessionMetadata,
} from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import type {
  FauxProviderHandle,
  FauxResponseStep,
  Model,
  MutableModels,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({ models: undefined as unknown }));

// Backup failover resolves each configured model through the shared runtime catalog.
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => catalog.models,
}));
vi.mock("../pi-current-models.js", () => ({ supplementPiModels: (models: unknown) => models }));

import { createAccountModels } from "./harness-models.js";
import type { SessionConfig } from "./session-config.js";
import { buildSessionConfig } from "./session-config.js";
import type {
  SessionHostDeps,
  SessionHostOutcome,
  SessionInputKind,
  SessionInputRow,
} from "./session-host.js";
import { inputMessage, runSessionHost } from "./session-host.js";

const INTERRUPTED = "Tool execution was interrupted.";

function memoryInputs() {
  const rows: SessionInputRow[] = [];
  const delivered = new Map<string, { piEntryId?: string; operationId?: string }>();
  let seq = 0;
  let markWorks = true;
  return {
    rows,
    delivered,
    submit(kind: SessionInputKind, text = "", trigger = "person"): SessionInputRow {
      seq += 1;
      const row: SessionInputRow = {
        id: `input-${seq}`,
        seq,
        kind,
        messageId: kind === "stop" ? null : `message-${seq}`,
        payload: { text },
        trigger,
      };
      rows.push(row);
      return row;
    },
    /** Simulates a worker that dies between the Pi commit and the delivery mark. */
    loseMarks() {
      markWorks = false;
    },
    source: {
      async pending() {
        return rows.filter((row) => !delivered.has(row.id));
      },
      async markDelivered(inputId: string, delivery: { piEntryId?: string; operationId?: string }) {
        if (markWorks) delivered.set(inputId, delivery);
      },
    },
  };
}

function memorySessions() {
  const repo = new MemorySessionRepo();
  let metadata: SessionMetadata | undefined;
  return async (): Promise<Session> => {
    if (metadata) return repo.open(metadata, BACKGROUND_CONTEXT);
    const session = await repo.create({ id: "session-1" }, BACKGROUND_CONTEXT);
    metadata = session.metadata;
    return session;
  };
}

function fauxModels(provider = "faux") {
  const faux = fauxProvider({ provider, models: [{ id: "model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}

function tool(
  name: string,
  execute: (toolCallId: string, signal?: AbortSignal) => Promise<string>,
): AgentTool & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    label: name,
    description: `Test tool ${name}.`,
    parameters: Type.Object({}),
    calls,
    async execute(toolCallId, _params, signal) {
      calls.push(toolCallId);
      const text = await execute(toolCallId, signal);
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

function userTexts(context: TranscriptContext): string[] {
  return context.messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface HostHandle {
  events: HarnessEvent[];
  lane: () => AgentLane;
  notify: () => void;
  alive: { value: boolean };
  released: { value: boolean };
  stop: () => Promise<SessionHostOutcome>;
  done: Promise<SessionHostOutcome>;
}

function startHost(options: {
  openSession: () => Promise<Session>;
  inputs: ReturnType<typeof memoryInputs>;
  config: () => SessionConfig;
  onEvent?: (event: HarnessEvent, lane: AgentLane) => void;
  endStaleRun?: (runId: string) => Promise<void>;
}): HostHandle {
  const events: HarnessEvent[] = [];
  const listeners = new Set<() => void>();
  const alive = { value: true };
  const released = { value: false };
  let lane: AgentLane | undefined;
  const controller = new AbortController();
  const deps: SessionHostDeps = {
    acquireLease: async () => ({
      renew: async () => alive.value,
      release: async () => {
        released.value = true;
      },
    }),
    inputs: options.inputs.source,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openSession: options.openSession,
    buildConfig: async () => options.config(),
    onEvent(event, context) {
      lane = context.lane;
      events.push(event);
      options.onEvent?.(event, context.lane);
    },
    ...(options.endStaleRun ? { endStaleRun: options.endStaleRun } : {}),
    timing: { renewMs: 5, quiesceMs: 2_000 },
  };
  const done = runSessionHost(deps, controller.signal);
  return {
    events,
    lane: () => lane!,
    notify: () => {
      for (const listener of listeners) listener();
    },
    alive,
    released,
    done,
    stop: () => {
      controller.abort();
      return done;
    },
  };
}

function ofType<T extends HarnessEvent["type"]>(events: HarnessEvent[], type: T) {
  return events.filter((event): event is Extract<HarnessEvent, { type: T }> => event.type === type);
}

function simpleConfig(
  models: MutableModels,
  model: Model<string>,
  tools: AgentTool[] = [],
  guardrails?: Parameters<typeof buildSessionConfig>[0]["guardrails"],
): () => SessionConfig {
  return () =>
    buildSessionConfig({
      models,
      model,
      systemPrompt: "Test agent.",
      tools,
      ...(guardrails ? { guardrails } : {}),
    });
}

async function settle(faux: FauxProviderHandle, steps: FauxResponseStep[]) {
  faux.setResponses(steps);
}

const hosts: HostHandle[] = [];
afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.stop()));
});
function track(host: HostHandle): HostHandle {
  hosts.push(host);
  return host;
}

describe("session host", () => {
  it("message while idle starts one run", async () => {
    const { faux, models, model } = fauxModels();
    await settle(faux, [fauxAssistantMessage("hello back")]);
    const inputs = memoryInputs();
    const host = track(
      startHost({ openSession: memorySessions(), inputs, config: simpleConfig(models, model) }),
    );
    const input = inputs.submit("message", "hello");
    host.notify();

    await vi.waitFor(() => expect(ofType(host.events, "run_end")).toHaveLength(1));
    const [start] = ofType(host.events, "run_start");
    expect(ofType(host.events, "run_start")).toHaveLength(1);
    expect(inputs.delivered.get(input.id)?.operationId).toBe(start?.runId);
    expect(ofType(host.events, "run_end")[0]?.status).toBe("completed");
  });

  it("message while running is steered into the same run", async () => {
    const { faux, models, model } = fauxModels();
    const gate = deferred();
    const seen: TranscriptContext[] = [];
    await settle(faux, [
      async () => {
        await gate.promise;
        return fauxAssistantMessage("first answer");
      },
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("second answer");
      },
    ]);
    const inputs = memoryInputs();
    const host = track(
      startHost({ openSession: memorySessions(), inputs, config: simpleConfig(models, model) }),
    );
    inputs.submit("message", "find five engineers");
    host.notify();
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    const steer = inputs.submit("message", "only in Berlin");
    host.notify();
    await vi.waitFor(() => expect(inputs.delivered.has(steer.id)).toBe(true));
    gate.resolve();

    await vi.waitFor(() => expect(ofType(host.events, "run_end")).toHaveLength(1));
    expect(ofType(host.events, "run_start")).toHaveLength(1);
    expect(userTexts(seen[0]!)).toEqual(["find five engineers", "only in Berlin"]);
  });

  it("late steer after run_end starts the next run", async () => {
    const { faux, models, model } = fauxModels();
    const seen: TranscriptContext[] = [];
    await settle(faux, [
      fauxAssistantMessage("first answer"),
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("late answer");
      },
    ]);
    const inputs = memoryInputs();
    let steered = false;
    const host = track(
      startHost({
        openSession: memorySessions(),
        inputs,
        config: simpleConfig(models, model),
        onEvent: (event, lane) => {
          // The host's own steer committing just after the final boundary: Pi keeps it in the inbox.
          if (event.type === "run_end" && !steered) {
            steered = true;
            const late: SessionInputRow = {
              id: "late-input",
              seq: 99,
              kind: "message",
              payload: { text: "one more thing" },
              trigger: "person",
            };
            void lane.steer(inputMessage(late), undefined, BACKGROUND_CONTEXT);
          }
        },
      }),
    );
    inputs.submit("message", "hello");
    host.notify();

    await vi.waitFor(() => expect(ofType(host.events, "run_end")).toHaveLength(2));
    const order = host.events
      .filter((event) => event.type === "run_start" || event.type === "run_end")
      .map((event) => event.type);
    expect(order).toEqual(["run_start", "run_end", "run_start", "run_end"]);
    expect(faux.state.callCount).toBe(2);
    expect(userTexts(seen[0]!).filter((text) => text === "one more thing")).toHaveLength(1);
  });

  it("stop aborts the running operation and queued inputs stay queued", async () => {
    const { faux, models, model } = fauxModels();
    const seen: TranscriptContext[] = [];
    await settle(faux, [
      async (_context, options) => {
        await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve));
        return fauxAssistantMessage("never seen");
      },
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("after stop");
      },
    ]);
    const inputs = memoryInputs();
    const host = track(
      startHost({ openSession: memorySessions(), inputs, config: simpleConfig(models, model) }),
    );
    inputs.submit("message", "long search");
    host.notify();
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    inputs.submit("message", "also check Munich");
    inputs.submit("stop");
    host.notify();

    await vi.waitFor(() => expect(ofType(host.events, "run_end")).toHaveLength(1));
    expect(ofType(host.events, "run_end")[0]?.status).toBe("aborted");
    // The steer the stop pulled out of the inbox waits for the next run instead of starting one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ofType(host.events, "run_start")).toHaveLength(1);
    expect(inputs.rows.every((row) => inputs.delivered.has(row.id))).toBe(true);

    inputs.submit("message", "go on");
    host.notify();
    await vi.waitFor(() => expect(ofType(host.events, "run_end")).toHaveLength(2));
    expect(userTexts(seen[0]!)).toEqual(["long search", "also check Munich", "go on"]);
  });

  it("stop aborts only the run it names and ends a row no lane runs", async () => {
    const { faux, models, model } = fauxModels();
    await settle(faux, [
      async (_context, options) => {
        await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve));
        return fauxAssistantMessage("never seen");
      },
    ]);
    const inputs = memoryInputs();
    const stale: string[] = [];
    const host = track(
      startHost({
        openSession: memorySessions(),
        inputs,
        config: simpleConfig(models, model),
        endStaleRun: async (runId) => {
          stale.push(runId);
        },
      }),
    );
    inputs.submit("message", "long search");
    host.notify();
    await vi.waitFor(() => expect(ofType(host.events, "run_start")).toHaveLength(1));
    const live = ofType(host.events, "run_start")[0]!.runId;
    const other = inputs.submit("stop");
    other.payload = { text: "", runId: "an-earlier-run" };
    host.notify();
    await vi.waitFor(() => expect(stale).toEqual(["an-earlier-run"]));
    expect(ofType(host.events, "run_end")).toHaveLength(0);
    const named = inputs.submit("stop");
    named.payload = { text: "", runId: live };
    host.notify();
    await vi.waitFor(() => expect(ofType(host.events, "run_end")).toHaveLength(1));
    expect(ofType(host.events, "run_end")[0]?.status).toBe("aborted");
  });

  it("stop on an idle lane is a no-op", async () => {
    const { faux, models, model } = fauxModels();
    await settle(faux, []);
    const inputs = memoryInputs();
    const host = track(
      startHost({ openSession: memorySessions(), inputs, config: simpleConfig(models, model) }),
    );
    const stop = inputs.submit("stop");
    host.notify();
    await vi.waitFor(() => expect(inputs.delivered.has(stop.id)).toBe(true));
    expect(ofType(host.events, "run_start")).toHaveLength(0);
    expect(ofType(host.events, "handler_error")).toHaveLength(0);
  });

  it("crash mid effect: no replay for replay=never", async () => {
    const { faux, models, model } = fauxModels();
    await settle(faux, [
      fauxAssistantMessage(fauxToolCall("send_email", {})),
      fauxAssistantMessage("I could not confirm the email went out."),
    ]);
    const send = tool("send_email", () => never());
    const openSession = memorySessions();
    const inputs = memoryInputs();
    const first = track(
      startHost({ openSession, inputs, config: simpleConfig(models, model, [send]) }),
    );
    inputs.submit("message", "send it");
    first.notify();
    await vi.waitFor(() => expect(send.calls).toHaveLength(1));
    first.alive.value = false;
    expect(await first.done).toBe("lease_lost");
    expect(first.released.value).toBe(false);

    const second = track(
      startHost({ openSession, inputs, config: simpleConfig(models, model, [send]) }),
    );
    await vi.waitFor(() => expect(ofType(second.events, "run_end")).toHaveLength(1));
    expect(send.calls).toHaveLength(1);
    const [ended] = ofType(second.events, "tool_end");
    expect(ended?.isError).toBe(true);
    expect(JSON.stringify(ended?.result.content)).toContain(INTERRUPTED);
    expect(ofType(second.events, "run_end")[0]?.status).toBe("completed");
  });

  it("safe tool replays after crash", async () => {
    const { faux, models, model } = fauxModels();
    await settle(faux, [
      fauxAssistantMessage(fauxToolCall("read_memory", {})),
      fauxAssistantMessage("done"),
    ]);
    let attempt = 0;
    const read = tool("read_memory", async () => {
      attempt += 1;
      if (attempt === 1) return never();
      return "memory contents";
    });
    const openSession = memorySessions();
    const inputs = memoryInputs();
    const first = track(
      startHost({ openSession, inputs, config: simpleConfig(models, model, [read]) }),
    );
    inputs.submit("message", "what do you remember");
    first.notify();
    await vi.waitFor(() => expect(read.calls).toHaveLength(1));
    first.alive.value = false;
    await first.done;

    const second = track(
      startHost({ openSession, inputs, config: simpleConfig(models, model, [read]) }),
    );
    await vi.waitFor(() => expect(ofType(second.events, "run_end")).toHaveLength(1));
    expect(read.calls).toHaveLength(2);
    // The effect key is the harness invocation id, unchanged across the replay.
    expect(read.calls[1]).toBe(read.calls[0]);
    const [ended] = ofType(second.events, "tool_end");
    expect(ended?.isError).toBe(false);
    expect(JSON.stringify(ended?.result.content)).toContain("memory contents");
  });

  it("duplicate delivery after crash is skipped by rakazoInputId", async () => {
    const { faux, models, model } = fauxModels();
    await settle(faux, [fauxAssistantMessage("answered once")]);
    const openSession = memorySessions();
    const inputs = memoryInputs();
    inputs.loseMarks();
    const first = track(startHost({ openSession, inputs, config: simpleConfig(models, model) }));
    const input = inputs.submit("message", "hello");
    first.notify();
    await vi.waitFor(() => expect(ofType(first.events, "run_end")).toHaveLength(1));
    expect(await first.stop()).toBe("released");
    expect(inputs.delivered.has(input.id)).toBe(false);

    const fresh = memoryInputs();
    fresh.rows.push(input);
    const second = track(
      startHost({ openSession, inputs: fresh, config: simpleConfig(models, model) }),
    );
    await vi.waitFor(() => expect(fresh.delivered.has(input.id)).toBe(true));
    expect(ofType(second.events, "run_start")).toHaveLength(0);
    expect(faux.state.callCount).toBe(1);
  });
});

describe("session guardrails", () => {
  it("unapproved send is blocked before execute", async () => {
    const { faux, models, model } = fauxModels();
    await settle(faux, [
      fauxAssistantMessage(fauxToolCall("send_email", {})),
      fauxAssistantMessage("waiting for approval"),
    ]);
    const send = tool("send_email", async () => "sent");
    const inputs = memoryInputs();
    const host = track(
      startHost({
        openSession: memorySessions(),
        inputs,
        config: simpleConfig(models, model, [send], {
          checkTool: ({ toolName }) =>
            toolName === "send_email" ? { reason: "Not approved." } : undefined,
        }),
      }),
    );
    inputs.submit("message", "email them");
    host.notify();
    await vi.waitFor(() => expect(ofType(host.events, "run_end")).toHaveLength(1));
    expect(send.calls).toHaveLength(0);
    const [ended] = ofType(host.events, "tool_end");
    expect(ended?.isError).toBe(true);
    expect(JSON.stringify(ended?.result.content)).toContain("Not approved.");
  });

  it("card tool terminates the run and its answer starts the next", async () => {
    const { faux, models, model } = fauxModels();
    const seen: TranscriptContext[] = [];
    await settle(faux, [
      fauxAssistantMessage(fauxToolCall("ask_user", {})),
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("going with Berlin");
      },
    ]);
    const ask = tool("ask_user", async () => "Question shown.");
    const inputs = memoryInputs();
    const host = track(
      startHost({
        openSession: memorySessions(),
        inputs,
        config: simpleConfig(models, model, [ask], { cardTools: new Set(["ask_user"]) }),
      }),
    );
    inputs.submit("message", "find engineers");
    host.notify();
    await vi.waitFor(() => expect(ofType(host.events, "run_end")).toHaveLength(1));
    expect(faux.state.callCount).toBe(1);
    expect(ofType(host.events, "tool_end")[0]?.terminate).toBe(true);

    inputs.submit("cardAnswer", "Berlin");
    host.notify();
    await vi.waitFor(() => expect(ofType(host.events, "run_end")).toHaveLength(2));
    expect(ofType(host.events, "run_start")).toHaveLength(2);
    expect(userTexts(seen[0]!)).toEqual(["find engineers", "Berlin"]);
  });

  it("spend over limit aborts the lane", async () => {
    const { faux, models, model } = fauxModels();
    await settle(faux, [
      async (_context, options) => {
        await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve));
        return fauxAssistantMessage("never seen");
      },
    ]);
    const limits: unknown[] = [];
    const inputs = memoryInputs();
    const host = track(
      startHost({
        openSession: memorySessions(),
        inputs,
        config: simpleConfig(models, model, [], {
          runLimits: { costUsd: 1, wallClockMs: 60_000 },
          onRunLimit: (fact) => limits.push(fact),
        }),
      }),
    );
    inputs.submit("message", "search everything");
    host.notify();
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    // A paid lookup's cost recorded against the running operation.
    await host.lane().recordUsage(
      {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
      undefined,
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(ofType(host.events, "run_end")).toHaveLength(1));
    expect(ofType(host.events, "run_end")[0]?.status).toBe("aborted");
    expect(limits).toEqual([expect.objectContaining({ limit: "cost", costUsd: 2 })]);
  });
});

describe("account models", () => {
  it("backup model takes over on outage", async () => {
    const primary = fauxProvider({ provider: "acct-primary", models: [{ id: "p1" }] });
    const backup = fauxProvider({ provider: "acct-backup", models: [{ id: "b1" }] });
    const shared = createModels();
    shared.setProvider(primary.provider);
    shared.setProvider(backup.provider);
    catalog.models = shared;
    primary.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" }),
    ]);
    backup.setResponses([fauxAssistantMessage("answered by the backup")]);
    const request = {
      model: { provider: "acct-primary", id: "p1", apiKey: "test-key" },
      fallbackModels: [{ provider: "acct-backup", id: "b1", apiKey: "test-key" }],
      tools: [],
    } as unknown as Pick<AgentRunRequest, "model" | "fallbackModels" | "tools">;
    const account = createAccountModels(request);
    expect(account).toBeDefined();
    const inputs = memoryInputs();
    const host = track(
      startHost({
        openSession: memorySessions(),
        inputs,
        config: () =>
          buildSessionConfig({
            models: account!.models,
            model: account!.model,
            systemPrompt: "Test agent.",
            tools: [],
          }),
      }),
    );
    inputs.submit("message", "hello");
    host.notify();
    await vi.waitFor(() => expect(ofType(host.events, "run_end")).toHaveLength(1));
    expect(primary.state.callCount).toBe(1);
    expect(backup.state.callCount).toBe(1);
    const replies = ofType(host.events, "message_end").filter(
      (event) => event.message.role === "assistant",
    );
    expect(JSON.stringify(replies.at(-1)?.message)).toContain("answered by the backup");
    expect(ofType(host.events, "run_end")[0]?.status).toBe("completed");
  });
});
