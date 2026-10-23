import type { ProductEvent } from "@rakazo/contracts";
import { isRunTerminalEvent } from "@rakazo/core";

/** Milliseconds from Send for one turn. Ids only: never prompt or reply text. */
export type TurnTiming = {
  kind: "turn";
  clientNonce: string;
  runId?: string;
  /** Local echo of the user's message on screen. */
  echoMs?: number;
  /** threads.send returned. */
  acceptedMs?: number;
  /** The durable user message arrived on the event stream. */
  serverEchoMs?: number;
  /** First reply text the reader can see (streamed or final). */
  firstTokenMs?: number;
  finalMs?: number;
};

/** Event committed on the server → applied in this page, by event.createdAt (clock skew applies). */
export type DeliveryTiming = { kind: "delivery"; type: string; lagMs: number };

export type Timing = TurnTiming | DeliveryTiming;

type Turn = { start: number; timing: TurnTiming };

export function createTurnTimer(options: {
  now: () => number;
  report: (timing: TurnTiming) => void;
}) {
  const turns = new Map<string, Turn>();
  const since = (turn: Turn) => Math.round(options.now() - turn.start);
  const byRun = (runId: string | undefined) =>
    runId ? [...turns.values()].find((turn) => turn.timing.runId === runId) : undefined;
  return {
    submit(clientNonce: string) {
      turns.set(clientNonce, { start: options.now(), timing: { kind: "turn", clientNonce } });
    },
    echoed(clientNonce: string) {
      const turn = turns.get(clientNonce);
      if (turn && turn.timing.echoMs === undefined) turn.timing.echoMs = since(turn);
    },
    accepted(clientNonce: string, runId: string) {
      const turn = turns.get(clientNonce);
      if (!turn) return;
      turn.timing.acceptedMs = since(turn);
      turn.timing.runId = runId;
    },
    failed(clientNonce: string) {
      turns.delete(clientNonce);
    },
    observe(event: Pick<ProductEvent, "type" | "runId" | "payload">) {
      if (event.type === "thread.message.created" && event.payload.role === "user") {
        const turn = [...turns.values()].find((item) => item.timing.serverEchoMs === undefined);
        if (turn) turn.timing.serverEchoMs = since(turn);
        return;
      }
      const turn = byRun(event.runId ?? undefined);
      if (!turn) return;
      const visibleText =
        (event.type === "thread.progress" &&
          event.payload.activity !== true &&
          Boolean(event.payload.text || event.payload.delta)) ||
        (event.type === "thread.message.created" && event.payload.role === "bot");
      if (visibleText && turn.timing.firstTokenMs === undefined)
        turn.timing.firstTokenMs = since(turn);
      if (isRunTerminalEvent(event)) {
        turn.timing.finalMs = since(turn);
        turns.delete(turn.timing.clientNonce);
        options.report(turn.timing);
      }
    },
  };
}

export function deliveryLagMs(event: Pick<ProductEvent, "createdAt">, nowEpochMs: number) {
  const committed = Date.parse(event.createdAt);
  return Number.isFinite(committed) ? Math.max(0, Math.round(nowEpochMs - committed)) : null;
}

const KEEP = 200;

/** Console line plus a bounded in-page buffer that measurement scripts read back. */
export function reportTiming(timing: Timing) {
  const store = globalThis as { __rakazoTimings?: Timing[] };
  const buffer = store.__rakazoTimings ?? [];
  store.__rakazoTimings = buffer;
  buffer.push(timing);
  if (buffer.length > KEEP) buffer.splice(0, buffer.length - KEEP);
  if (timing.kind === "turn") console.info("[rakazo:timing]", timing);
}

export const turnTimer = createTurnTimer({
  now: () => performance.now(),
  report: reportTiming,
});

/** Feed every live thread event: turn milestones plus commit→applied delivery lag. */
export function observeThreadEvent(event: ProductEvent, initialCursor: number) {
  turnTimer.observe(event);
  if (event.seq <= initialCursor) return;
  const lagMs = deliveryLagMs(event, Date.now());
  if (lagMs !== null) reportTiming({ kind: "delivery", type: event.type, lagMs });
}
