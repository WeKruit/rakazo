import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { builtinAgentTools, PiAgentRuntime } from "@rakazo/adapters";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ModelEmulatorRequest,
  ModelEmulatorResponse,
  ModelEmulatorStep,
} from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

type Scripted = {
  expect?: (request: ModelEmulatorRequest) => void;
  response: ModelEmulatorResponse;
};

const lookupTool: ConnectorTool = {
  name: "slow_lookup",
  description: "Look something up",
  inputSchema: { type: "object", properties: {} },
};
const tools = [
  lookupTool,
  ...builtinAgentTools.filter((tool) => ["run_subagent", "ask_user"].includes(tool.name)),
];

function isChild(request: ModelEmulatorRequest) {
  return String(request.messages[0]?.content).includes("Rakazo subagent named");
}

/** Parent and helper requests race; route each to its own ordered script. */
function routedSteps(parent: Scripted[], child: Scripted[]): ModelEmulatorStep[] {
  const chosen = new WeakMap<ModelEmulatorRequest, Scripted>();
  return Array.from({ length: parent.length + child.length }, () => ({
    expect(request: ModelEmulatorRequest) {
      const step = (isChild(request) ? child : parent).shift();
      if (!step) throw new Error(`Unexpected ${isChild(request) ? "helper" : "parent"} request`);
      chosen.set(request, step);
      step.expect?.(request);
    },
    response: (request: ModelEmulatorRequest) => chosen.get(request)!.response,
  }));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function lastToolResult(request: ModelEmulatorRequest) {
  return String(request.messages.findLast((message) => message.role === "tool")?.content);
}

function count(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

function runRequest(
  model: AgentRunRequest["model"],
  executeTool: AgentRunRequest["executeTool"],
): AgentRunRequest {
  return {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: randomUUID(),
    prompt: "Find candidates.",
    instructions: "Coordinate helpers.",
    history: [],
    tools,
    model,
    executeTool,
  };
}

const childLookup: Scripted[] = [
  { response: { type: "tool", id: "lookup", name: "slow_lookup", arguments: {} } },
  { response: { type: "text", text: "Found Ada." } },
];

describe("background helpers with real Pi", () => {
  it("replies while a helper works, then delivers its result once at the next turn", async () => {
    const lookup = deferred();
    const parentRequests: ModelEmulatorRequest[] = [];
    const server = await startModelEmulator({
      steps: routedSteps(
        [
          {
            expect: (request) => parentRequests.push(request),
            response: {
              type: "tool",
              id: "start",
              name: "run_subagent",
              arguments: { name: "scout", task: "Find people", background: true },
            },
          },
          {
            expect(request) {
              parentRequests.push(request);
              expect(lastToolResult(request)).toContain("handle subagent-1");
            },
            response: { type: "text", text: "Scout is looking." },
          },
          {
            expect(request) {
              parentRequests.push(request);
              const body = JSON.stringify(request.messages);
              expect(count(body, "Helper scout (subagent-1) finished:")).toBe(1);
              expect(body).toContain("Found Ada.");
            },
            response: { type: "text", text: "Scout found Ada." },
          },
        ],
        [...childLookup],
      ),
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run(
      runRequest(server.model, async (name) => {
        if (name === "slow_lookup") await lookup.promise;
        return { ok: true };
      }),
    )) {
      events.push(event);
      // The helper finishes only after the reply reached the user.
      if (event.type === "text" && event.text.includes("Scout is looking.")) lookup.resolve();
    }
    server.assertComplete();
    const replied = events.findIndex(
      (event) => event.type === "text" && event.text.includes("Scout is looking."),
    );
    const completed = events.findIndex(
      (event) => event.type === "subagent" && event.status === "completed",
    );
    expect(replied).toBeGreaterThanOrEqual(0);
    expect(completed).toBeGreaterThan(replied);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      text: "Scout is looking.\n\nScout found Ada.",
    });
    // The system prompt and the tool list are the same bytes on every parent step.
    const prefixes = parentRequests.map((request) =>
      JSON.stringify([request.messages[0], request.tools]),
    );
    expect(new Set(prefixes).size).toBe(1);
  });

  it("returns results from wait and never delivers them a second time", async () => {
    const lookup = deferred();
    const server = await startModelEmulator({
      steps: routedSteps(
        [
          {
            response: {
              type: "tool",
              id: "start",
              name: "run_subagent",
              arguments: { name: "scout", task: "Find people", background: true },
            },
          },
          {
            expect: () => lookup.resolve(),
            response: {
              type: "tool",
              id: "wait",
              name: "run_subagent",
              arguments: { wait: ["subagent-1"], timeout_seconds: 30 },
            },
          },
          {
            expect(request) {
              expect(lastToolResult(request)).toContain(
                "Helper scout (subagent-1) finished:\nFound Ada.",
              );
            },
            response: { type: "text", text: "Ada is a match." },
          },
        ],
        [...childLookup],
      ),
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run(
      runRequest(server.model, async (name) => {
        if (name === "slow_lookup") await lookup.promise;
        return { ok: true };
      }),
    ))
      events.push(event);
    // No extra parent step: the result was read through wait, so the run ends.
    server.assertComplete();
    expect(events.at(-1)).toMatchObject({ type: "done", text: "Ada is a match." });
  });

  it("continues the same helper by its handle", async () => {
    const server = await startModelEmulator({
      steps: routedSteps(
        [
          {
            response: {
              type: "tool",
              id: "first",
              name: "run_subagent",
              arguments: { name: "scout", task: "Find people" },
            },
          },
          {
            expect(request) {
              expect(lastToolResult(request)).toContain("Found Ada.");
              expect(lastToolResult(request)).toContain("(helper handle: subagent-1)");
            },
            response: {
              type: "tool",
              id: "more",
              name: "run_subagent",
              arguments: { handle: "subagent-1", task: "Now find Bob." },
            },
          },
          {
            expect(request) {
              expect(lastToolResult(request)).toContain("Found Bob.");
            },
            response: { type: "text", text: "Ada and Bob." },
          },
        ],
        [
          { response: { type: "text", text: "Found Ada." } },
          {
            expect(request) {
              const body = JSON.stringify(request.messages);
              // The follow-up keeps the helper's own conversation.
              expect(body).toContain("Find people");
              expect(body).toContain("Found Ada.");
              expect(body).toContain("Now find Bob.");
            },
            response: { type: "text", text: "Found Bob." },
          },
        ],
      ),
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run(
      runRequest(server.model, async () => ({ ok: true })),
    ))
      events.push(event);
    server.assertComplete();
    const rows = events.filter((event) => event.type === "subagent");
    expect(new Set(rows.map((event) => event.agentId)).size).toBe(1);
    expect(rows.filter((event) => event.status === "completed")).toHaveLength(2);
  });

  it("gives helper results to the model before it pauses with a question", async () => {
    const lookup = deferred();
    const server = await startModelEmulator({
      steps: routedSteps(
        [
          {
            response: {
              type: "tool",
              id: "start",
              name: "run_subagent",
              arguments: { name: "scout", task: "Find people", background: true },
            },
          },
          {
            expect: () => lookup.resolve(),
            response: {
              type: "tool",
              id: "ask",
              name: "ask_user",
              arguments: { question: "Which location?", options: ["Remote", "Onsite"] },
            },
          },
          {
            expect(request) {
              expect(lastToolResult(request)).toContain("Found Ada.");
              expect(lastToolResult(request)).toContain("ask again only if you still need to");
            },
            response: { type: "text", text: "Ada is remote, so no question needed." },
          },
        ],
        [...childLookup],
      ),
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run(
      runRequest(server.model, async (name) => {
        if (name === "slow_lookup") await lookup.promise;
        return { ok: true };
      }),
    ))
      events.push(event);
    server.assertComplete();
    expect(events.some((event) => event.type === "ask")).toBe(false);
  });

  it("Stop ends a run that is waiting for a background helper", async () => {
    const lookupStarted = deferred();
    const stop = new AbortController();
    const server = await startModelEmulator({
      steps: routedSteps(
        [
          {
            response: {
              type: "tool",
              id: "start",
              name: "run_subagent",
              arguments: { name: "scout", task: "Find people", background: true },
            },
          },
          { response: { type: "text", text: "Scout is looking." } },
        ],
        [childLookup[0]!],
      ),
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    const run = (async () => {
      for await (const event of new PiAgentRuntime().run(
        runRequest(server.model, async (name) => {
          if (name === "slow_lookup") {
            lookupStarted.resolve();
            await new Promise(() => undefined);
          }
          return { ok: true };
        }),
        { signal: stop.signal },
      ))
        events.push(event);
    })();
    await lookupStarted.promise;
    await expect
      .poll(() => events.some((event) => event.type === "text"), { timeout: 10_000 })
      .toBe(true);
    stop.abort(new Error("stopped"));
    await run.catch(() => undefined);
    // Two parent steps and one helper step: nothing was delivered after Stop.
    server.assertComplete();
    expect(events.some((event) => event.type === "subagent" && event.status === "completed")).toBe(
      false,
    );
  });
});
