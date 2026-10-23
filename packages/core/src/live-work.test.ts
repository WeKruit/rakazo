import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { WorkSession } from "./live-work.js";
import {
  EMPTY_WORK_TRACKER,
  formatWorkClock,
  formatWorkDuration,
  observeWorkSession,
  runWorkSteps,
  trackWork,
  workActivityForTool,
  workSessionElapsedMs,
  workSessionSteps,
} from "./live-work.js";
import type { LiveThread, LiveThreadEvent } from "./thread-reducer.js";
import { reduceThreadEvent } from "./thread-reducer.js";

const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

describe("workActivityForTool", () => {
  it.each([
    ["recruiting_role", "role"],
    ["recruiting_candidates", "candidates"],
    ["recruiting_research", "research"],
    ["mcp__autumn__research", "research"],
    ["Mcp  autumn  get rows", "research"],
    ["recruiting_reply", "drafting"],
    ["handoff_to_bot", "specialist"],
    ["run_subagent", "specialist"],
    ["read_file", "files"],
    ["Web search", "search"],
    ["mcp__personal-mail__get_email", "emails"],
    ["instantly__personal-mail__search_contact_emails", "emails"],
    ["Instantly personal-mail search contact emails", "emails"],
    ["mcp__calendar__get_availability", "availability"],
    // A send or booking may still wait for approval: never claim it.
    ["mcp__private__reply_to_email", "working"],
    ["mcp__private__create_booking", "working"],
    ["shell", "working"],
    ["", "working"],
  ])("maps %s to %s", (name, expected) => {
    expect(workActivityForTool(name)).toBe(expected);
  });
});

describe("runWorkSteps", () => {
  const steps = (...labels: string[]): MessageBlock => ({
    kind: "steps",
    steps: labels.map((label) => ({ label, count: 1 })),
  });
  it("reads finished calls and the pending call without free text", () => {
    expect(
      runWorkSteps({
        blocks: [
          steps("Recruiting role"),
          {
            kind: "progress",
            activity: true,
            text: "private path /tmp/token",
            pendingToolNames: ["mcp__autumn__research"],
          },
        ],
      }),
    ).toEqual({ done: ["role"], current: "research" });
  });
  it("treats the last step before an empty marker as still running", () => {
    expect(
      runWorkSteps({
        blocks: [
          steps("Recruiting role", "Web search"),
          { kind: "progress", activity: true, text: "" },
        ],
      }),
    ).toEqual({ done: ["role"], current: "search" });
    expect(runWorkSteps({ blocks: [steps("Web search")] })).toEqual({
      done: ["search"],
      current: null,
    });
  });
});

describe("observeWorkSession", () => {
  const thread = (): LiveThread => ({
    threadId: "t",
    cursor: 0,
    messages: [
      {
        id: "u1",
        role: "user",
        seq: 1,
        blocks: [{ kind: "text", text: "Find people" }],
        createdAt: at(-1),
      },
    ],
    olderCursor: null,
    run: null,
  });
  let seq = 1;
  const event = (
    type: string,
    seconds: number,
    payload: Record<string, unknown> = {},
    runId = "r1",
  ) =>
    ({
      type,
      seq: ++seq,
      threadId: "t",
      botId: "b",
      runId,
      createdAt: at(seconds),
      payload,
    }) as LiveThreadEvent;
  const view = (state: LiveThread) => ({
    runs: state.activeRuns ?? (state.run ? [state.run] : []),
    messages: state.messages,
  });

  it("keeps steps across narration, names the current step and ends at the final reply", () => {
    let state = thread();
    let session: WorkSession | null = null;
    const step = (next: LiveThreadEvent, now: number) => {
      state = reduceThreadEvent(state, next);
      session = observeWorkSession(session, view(state), at(now));
    };
    step(event("run.started", 0, { trigger: "user" }), 0);
    expect(session!.startedAt).toBe(at(0));
    expect(workSessionElapsedMs(session!, T0 + 42_000)).toBe(42_000);
    expect(formatWorkClock(workSessionElapsedMs(session!, T0 + 42_000))).toBe("0:42");

    step(event("agent.tool.called", 2, { name: "recruiting_role", executionId: "e1" }), 2);
    expect(session!.current).toBe("role");
    step(event("agent.tool.completed", 3, { name: "recruiting_role", executionId: "e1" }), 3);
    expect(session!.current).toBeNull();
    expect(workSessionSteps(session)).toEqual([{ activity: "role", count: 1 }]);

    // Mid-turn narration replaces the live row; the finished step stays in the turn.
    step(
      event("thread.message.created", 4, {
        messageId: "m1",
        role: "bot",
        blocks: [{ kind: "text", text: "Starting the search." }],
      }),
      4,
    );
    step(event("agent.tool.called", 5, { name: "mcp__autumn__research", executionId: "e2" }), 5);
    expect(session!.current).toBe("research");
    step(
      event("agent.tool.completed", 30, { name: "mcp__autumn__research", executionId: "e2" }),
      30,
    );
    step(event("agent.tool.called", 31, { name: "mcp__autumn__get_rows", executionId: "e3" }), 31);
    step(
      event("agent.tool.completed", 60, { name: "mcp__autumn__get_rows", executionId: "e3" }),
      60,
    );
    expect(workSessionSteps(session)).toEqual([
      { activity: "role", count: 1 },
      { activity: "research", count: 2 },
    ]);

    step(
      event("thread.message.created", 72, {
        messageId: "m2",
        role: "bot",
        blocks: [{ kind: "text", text: "Here are ten people." }],
      }),
      72,
    );
    step(event("run.completed", 72), 75);
    expect(session!.endedAt).toBe(at(72));
    expect(formatWorkDuration(workSessionElapsedMs(session!, T0 + 999_000))).toBe("1m 12s");
    expect(workSessionSteps(session)).toEqual([
      { activity: "role", count: 1 },
      { activity: "research", count: 2 },
    ]);
    const settled = session;
    expect(observeWorkSession(session, view(state), at(80))).toBe(settled);
  });

  it("uses the run's own start after a reload", () => {
    const session = observeWorkSession(
      null,
      {
        runs: [{ id: "r1", status: "running", startedAt: at(0), createdAt: at(-2) }],
        messages: [],
      },
      at(42),
    );
    expect(formatWorkClock(workSessionElapsedMs(session!, T0 + 42_000))).toBe("0:42");
  });

  it("never counts queued time or a pause for an answer", () => {
    const queued = { id: "r1", status: "queued", startedAt: null, createdAt: at(0) };
    expect(observeWorkSession(null, { runs: [queued], messages: [] }, at(120))).toBeNull();
    // Resumed after an answer: the run's start is 16 minutes old, but the answer is not.
    const resumed = { id: "r1", status: "running", startedAt: at(60), createdAt: at(0) };
    const answered = observeWorkSession(
      null,
      {
        runs: [resumed],
        messages: [{ id: "a", role: "user", blocks: [], createdAt: at(1000) }],
      },
      at(1005),
    );
    expect(answered?.startedAt).toBe(at(1000));
    // The client watched the run wait, so work restarts no earlier than it saw it idle.
    const watched = observeWorkSession(null, { runs: [resumed], messages: [] }, at(1020), {
      notBefore: at(1018),
    });
    expect(workSessionElapsedMs(watched!, T0 + 1_020_000)).toBe(2_000);
  });

  it("continues a turn into a handed-off run and starts fresh after a new message", () => {
    const ended: WorkSession = {
      startedAt: at(0),
      endedAt: at(20),
      runIds: ["r1"],
      earlier: ["role"],
      live: {},
      current: null,
    };
    const handoff = observeWorkSession(
      ended,
      { runs: [{ id: "r2", status: "running", startedAt: at(22) }], messages: [] },
      at(23),
    );
    expect(handoff).toMatchObject({ startedAt: at(0), endedAt: null, runIds: ["r1", "r2"] });
    const next = observeWorkSession(
      ended,
      {
        runs: [{ id: "r3", status: "running", startedAt: at(22) }],
        messages: [{ id: "u2", role: "user", blocks: [], createdAt: at(21) }],
      },
      at(23),
    );
    expect(next).toMatchObject({ startedAt: at(22), runIds: ["r3"], earlier: [] });
    expect(observeWorkSession(null, { runs: [], messages: [] }, at(0))).toBeNull();
  });
});

describe("trackWork", () => {
  it("restarts the clock where the client last saw the run waiting", () => {
    const waiting = { id: "r1", status: "waiting_input", startedAt: at(0) };
    const running = { ...waiting, status: "running" };
    let tracker = trackWork(EMPTY_WORK_TRACKER, { runs: [waiting], messages: [] }, at(960));
    expect(tracker.session).toBeNull();
    const same = trackWork(tracker, { runs: [waiting], messages: [] }, at(960));
    expect(same).toBe(tracker);
    tracker = trackWork(tracker, { runs: [running], messages: [] }, at(961));
    expect(tracker.session?.startedAt).toBe(at(960));
    expect(formatWorkClock(workSessionElapsedMs(tracker.session!, T0 + 970_000))).toBe("0:10");
  });
});

describe("formatting", () => {
  it.each([
    [0, "0:00", "0s"],
    [7_400, "0:07", "7s"],
    [72_000, "1:12", "1m 12s"],
    [3_723_000, "1:02:03", "1h 2m"],
    [-5, "0:00", "0s"],
  ])("formats %ims", (ms, clock, duration) => {
    expect(formatWorkClock(ms)).toBe(clock);
    expect(formatWorkDuration(ms)).toBe(duration);
  });
});
