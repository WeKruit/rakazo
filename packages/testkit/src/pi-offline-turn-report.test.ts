import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import { afterEach, describe, expect, it } from "vitest";
import { builtinAgentTools } from "../../adapters/src/builtin-tools.js";
import {
  REPORT_BEFORE_ASK,
  REPORT_BEFORE_END,
  TurnReportLedger,
} from "../../adapters/src/turn-report.js";
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
const builtin = (name: string) => builtinAgentTools.find((tool) => tool.name === name)!;

const lastUserText = (request: ModelEmulatorRequest) => {
  const message = request.messages.findLast((item) => item.role === "user");
  return typeof message?.content === "string" ? message.content : JSON.stringify(message?.content);
};
const lastToolText = (request: ModelEmulatorRequest) =>
  JSON.stringify(request.messages.findLast((item) => item.role === "tool")?.content ?? "");

/**
 * Drives the real Pi runtime the way the executor does: tool and text events feed the ledger in
 * stream order, tool results settle it, and beforeAsk and reportOwed read it.
 */
async function runWithLedger(
  model: AgentRunRequest["model"],
  tools: ConnectorTool[],
  ledger: TurnReportLedger,
) {
  const runtime = new PiAgentRuntime();
  const runId = randomUUID();
  cleanups.push(() => runtime.abort(runId));
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run({
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId,
    prompt: "Find 50 people for the role.",
    instructions: "Complete the requested task.",
    history: [],
    tools,
    model: { ...model, maxTokens: 256 },
    reportOwed: () => ledger.owed().length > 0,
    beforeAsk: async (question) => {
      await ledger.caughtUpToAsk();
      const note = ledger.bounceAsk(question);
      return note ? { instead: note } : undefined;
    },
    executeTool: async (_name, _args, executionId) => {
      const result = { ok: true, saved: 70 };
      ledger.settle(executionId, { ok: true, result });
      return result;
    },
  })) {
    events.push(event);
    if (event.type === "text" && event.text.trim()) ledger.report();
    if (event.type === "tool") {
      ledger.tool(event.executionId, event.name, event.args);
      if (event.name === "message_user") ledger.report();
    }
  }
  return events;
}

describe("turn report invariant on real Pi with an offline model", () => {
  it("asks for the report before a question card over unreported work", async () => {
    const search = {
      expect() {},
      response: {
        type: "tool" as const,
        id: "search-1",
        name: peopleSearch.name,
        arguments: { query: "staff engineers" },
      },
    };
    const ask = (id: string) => ({
      type: "tool" as const,
      id,
      name: "ask_user",
      arguments: { question: "What next?", options: ["Keep going", "Stop here"] },
    });
    const model = await startModelEmulator({
      steps: [
        search,
        { expect() {}, response: ask("ask-1") },
        {
          expect(request) {
            expect(lastToolText(request)).toContain(REPORT_BEFORE_ASK.slice(0, 40));
          },
          response: {
            type: "tool",
            id: "report-1",
            name: "message_user",
            arguments: { message: "Added 70 people; the pool is now 139." },
          },
        },
        { expect() {}, response: ask("ask-2") },
      ],
    });
    cleanups.push(() => model.close());
    const ledger = new TurnReportLedger(true);
    const events = await runWithLedger(
      model.model,
      [peopleSearch, builtin("message_user"), builtin("ask_user")],
      ledger,
    );
    model.assertComplete();
    const order = events.flatMap((event) =>
      event.type === "ask" ? ["ask"] : event.type === "tool" ? [event.name] : [],
    );
    expect(order).toEqual([peopleSearch.name, "ask_user", "message_user", "ask_user", "ask"]);
    expect(ledger.owed()).toEqual([]);
  }, 30_000);

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
