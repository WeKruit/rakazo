import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { ToolHost } from "../pi-runtime.js";
import { createGate, MAX_PARALLEL_SUBAGENTS } from "../pi-runtime.js";

/** What one Pi operation's tools run with: the run path's executor, bound to the run row. */
export type RunTurnRequest = Pick<
  AgentRunRequest,
  | "botId"
  | "threadId"
  | "runId"
  | "contextStrategy"
  | "tools"
  | "model"
  | "fallbackModels"
  | "executeTool"
  | "storeToolOutput"
  | "resolveModel"
>;

export interface RunTurnTools {
  request: RunTurnRequest;
  /** Writes the ask card of an `ask_user` call; the run ends after it. */
  showAsk(event: Extract<AgentRuntimeEvent, { type: "ask" }>): Promise<void>;
  /** Facts from the run's setup (approved sends it replayed), read before the first step. */
  notes?: string[];
}

/** Handed to the executor's per-operation setup (`openRunTurn`). */
export interface RunTurnBinding {
  /** Aborted when the operation is stopped or fails. */
  signal: AbortSignal;
  /** Gives the session the operation's tools; resolves when the operation has ended. */
  serve(tools: RunTurnTools): Promise<void>;
}

export type OpenRunTurn = (runId: string, binding: RunTurnBinding) => Promise<void>;

interface LiveTurn {
  runId: string;
  abort: AbortController;
  ready: Promise<RunTurnTools>;
  tools?: RunTurnTools;
  endTurn(): void;
  /** Card writes started by this turn's tools; the run's end waits for them. */
  pending: Set<Promise<unknown>>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A tool host whose tools run in the session's live operation. */
export type SessionToolHost = ToolHost & {
  /** Resolves once the operation's run setup has handed its tools over. */
  ready(operationId: string): Promise<void>;
};

/**
 * The live Pi operation of one session lane, as a run turn: started at run_start (after the run
 * row exists), ended at run_end. A session lane has at most one operation at a time.
 */
export function createRunTurns(open: OpenRunTurn) {
  const turns = new Map<string, LiveTurn>();
  let current: LiveTurn | undefined;

  const liveTools = (): RunTurnTools => {
    if (!current?.tools) throw new Error("No live turn");
    return current.tools;
  };

  return {
    start(runId: string): void {
      if (turns.has(runId)) return;
      const abort = new AbortController();
      const ended = deferred<void>();
      const ready = deferred<RunTurnTools>();
      const turn: LiveTurn = {
        runId,
        abort,
        ready: ready.promise,
        endTurn: () => ended.resolve(),
        pending: new Set(),
      };
      ready.promise.then(
        (tools) => {
          turn.tools = tools;
        },
        () => undefined,
      );
      turns.set(runId, turn);
      current = turn;
      void open(runId, {
        signal: abort.signal,
        serve: (tools) => {
          ready.resolve(tools);
          return ended.promise;
        },
      }).then(
        () => ready.reject(new Error("This turn's tools are not available.")),
        (error: unknown) => {
          getLogger().error("run turn setup failed", error, { runId });
          ready.reject(error);
        },
      );
    },

    /** The setup's facts for the run's first step; waits until its tools are ready. */
    async notes(runId: string): Promise<string[]> {
      const turn = turns.get(runId);
      if (!turn) return [];
      const tools = await turn.ready.catch(() => undefined);
      return tools?.notes ?? [];
    },

    /** Ends the turn's tools; waits for the card writes it started. */
    async end(runId: string, stopped: boolean): Promise<void> {
      const turn = turns.get(runId);
      if (!turn) return;
      turns.delete(runId);
      if (current === turn) current = undefined;
      if (stopped) turn.abort.abort(new Error("Stopped"));
      await Promise.allSettled([...turn.pending]);
      turn.endTurn();
    },

    host(base: { models: Models; model: Model<Api> }): SessionToolHost {
      const track = (work: Promise<unknown>) => {
        const turn = current;
        if (!turn) return;
        const settled = work.catch((error: unknown) =>
          getLogger().error("run turn card failed", error, { runId: turn.runId }),
        );
        turn.pending.add(settled);
      };
      return {
        queue: {
          push(event: AgentRuntimeEvent) {
            if (event.type === "ask") track(liveTools().showAsk(event));
          },
          fail() {},
          close() {},
          iterate() {
            throw new Error("A session tool host has no event stream");
          },
        },
        get request() {
          return liveTools().request as AgentRunRequest;
        },
        get activeModel() {
          return { config: liveTools().request.model, models: base.models, model: base.model };
        },
        models: base.models,
        model: base.model,
        apiKey: undefined,
        nestedAgents: new Set(),
        subagentGate: createGate(MAX_PARALLEL_SUBAGENTS),
        toolCallBudget: { count: 0, exceeded: false, limit: 0, inFlight: 0 },
        toolCallSeq: { value: 0 },
        dispatchedToolCalls: new Set(),
        abortTurn: () => undefined,
        get signal() {
          return current?.abort.signal ?? AbortSignal.abort(new Error("No live turn"));
        },
        depth: 0,
        pausePending: false,
        pendingShells: [],
        subagents: new Map(),
        subagentCount: { value: 0 },
        async ready(operationId: string) {
          const turn = turns.get(operationId);
          if (!turn) throw new Error("This turn has ended.");
          await turn.ready;
        },
      };
    },
  };
}

export type RunTurns = ReturnType<typeof createRunTurns>;
