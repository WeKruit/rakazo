import type { ProductEvent } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { TurnTiming } from "./turn-timing";
import { createTurnTimer, deliveryLagMs } from "./turn-timing";

const event = (type: string, payload: Record<string, unknown> = {}, runId = "run") =>
  ({ type, runId, payload }) as Pick<ProductEvent, "type" | "runId" | "payload">;

describe("turn timing", () => {
  it("times submit → echo → accepted → first visible text → final, with ids only", () => {
    let now = 0;
    const reports: TurnTiming[] = [];
    const timer = createTurnTimer({ now: () => now, report: (timing) => reports.push(timing) });
    timer.submit("nonce");
    now = 16;
    timer.echoed("nonce");
    now = 300;
    timer.accepted("nonce", "run");
    now = 320;
    timer.observe(event("thread.message.created", { role: "user", blocks: [] }));
    now = 900;
    timer.observe(event("thread.progress", { text: "Searching…", activity: true }));
    now = 2_000;
    timer.observe(event("thread.progress", { text: "Here", streaming: true }));
    now = 2_500;
    timer.observe(event("run.completed"));
    expect(reports).toEqual([
      {
        kind: "turn",
        clientNonce: "nonce",
        runId: "run",
        echoMs: 16,
        acceptedMs: 300,
        serverEchoMs: 320,
        firstTokenMs: 2_000,
        finalMs: 2_500,
      },
    ]);
    expect(JSON.stringify(reports)).not.toContain("Here");
  });

  it("reports a turn that ends on a question card", () => {
    const reports: TurnTiming[] = [];
    const timer = createTurnTimer({ now: () => 5, report: (timing) => reports.push(timing) });
    timer.submit("nonce");
    timer.accepted("nonce", "run");
    timer.observe(event("run.waiting_input"));
    expect(reports).toMatchObject([{ runId: "run", finalMs: 0 }]);
  });

  it("ignores other runs and drops failed sends", () => {
    const reports: TurnTiming[] = [];
    const timer = createTurnTimer({ now: () => 1, report: (timing) => reports.push(timing) });
    timer.submit("nonce");
    timer.accepted("nonce", "run");
    timer.observe(event("run.completed", {}, "other"));
    timer.submit("failed");
    timer.failed("failed");
    expect(reports).toEqual([]);
  });

  it("measures commit → shown from the event time", () => {
    expect(
      deliveryLagMs(
        { createdAt: "2026-10-23T00:00:00.000Z" },
        Date.parse("2026-10-23T00:00:00.250Z"),
      ),
    ).toBe(250);
    expect(deliveryLagMs({ createdAt: "not a date" }, 0)).toBeNull();
  });
});
