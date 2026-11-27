import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_BEFORE_END, TurnReportLedger } from "../../adapters/src/turn-report.js";
import { type ModelEmulatorRequest, startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const peopleSearch: ConnectorTool = {
  name: "exa__web_search_advanced_exa",
  description: "Search for people",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};

const lastUserText = (request: ModelEmulatorRequest) => {
  const message = request.messages.findLast((item) => item.role === "user");
  return typeof message?.content === "string" ? message.content : JSON.stringify(message?.content);
};

/**
 * Drives the real Pi runtime the way the executor does: tool and text events feed the ledger in
 * stream order, tool results settle it, and reportOwed reads it.
 */
async function runWithLedger(
  model: AgentRunRequest["model"],
  tools: ConnectorTool[],
  ledger: TurnReportLedger,
  prompt = "Find 50 people for the role.",
) {
  const runtime = new PiAgentRuntime();
  const runId = randomUUID();
  cleanups.push(() => runtime.abort(runId));
  const events: AgentRuntimeEvent[] = [];
  let reply = "";
  for await (const event of runtime.run({
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId,
    prompt,
    instructions: "Complete the requested task.",
    history: [],
    tools,
    model: { ...model, maxTokens: 256 },
    reportOwed: () => ledger.owed().length > 0,
    executeTool: async (_name, _args, executionId) => {
      const result = { ok: true, saved: 70 };
      ledger.settle(executionId, { ok: true, result });
      return result;
    },
  })) {
    events.push(event);
    if (event.type === "text") reply += event.text;
    if (event.type === "text" && event.text.trim()) ledger.report();
    if (event.type === "tool") {
      ledger.tool(event.executionId, event.name, event.args);
      if (event.name === "message_user") ledger.report();
    }
  }
  return Object.assign(events, { reply });
}

describe("turn report invariant on real Pi with an offline model", () => {
  it("asks for the report once before ending, then ends empty for the server's report", async () => {
    const silent = (check?: (request: ModelEmulatorRequest) => void) => ({
      expect: check ?? (() => {}),
      response: { type: "text" as const, text: "" },
    });
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "search-1",
            name: peopleSearch.name,
            arguments: { query: "staff engineers" },
          },
        },
        silent(),
        silent((request) => expect(lastUserText(request)).not.toContain(REPORT_BEFORE_END)),
        silent((request) => expect(lastUserText(request)).not.toContain(REPORT_BEFORE_END)),
        silent((request) => expect(lastUserText(request)).toContain(REPORT_BEFORE_END)),
      ],
    });
    cleanups.push(() => model.close());
    const ledger = new TurnReportLedger(true);
    // Without the ledger this ending is a failed run ("did not write a final answer").
    const events = await runWithLedger(model.model, [peopleSearch], ledger);
    model.assertComplete();
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(ledger.owed()).toEqual(["people_search"]);
  }, 30_000);
});
