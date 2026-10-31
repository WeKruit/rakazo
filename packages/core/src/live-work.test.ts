import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { WorkSession } from "./live-work.js";
import {
  EMPTY_WORK_TRACKER,
  formatWorkClock,
  formatWorkDuration,
  observeWorkSession,
  runWorkSteps,
  specialistWorkLabel,
  trackWork,
  workActivityForTool,
  workActivityLabel,
  workProgressLabel,
  workSessionElapsedMs,
  workSessionStages,
  workSessionSteps,
  workStageKind,
  workStageLabel,
  workStageMessages,
} from "./live-work.js";
import type { LiveThread, LiveThreadEvent } from "./thread-reducer.js";
import { reduceThreadEvent } from "./thread-reducer.js";

const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

it("includes fifty seconds of observed background work, survives reload and excludes a later user wait", () => {
  const run = { id: "source", botId: "sourcer", status: "running", startedAt: at(0) };
  const user = { id: "user", role: "user", createdAt: at(0), blocks: [] };
  const background = {
    runId: "source",
    botId: "sourcer",
    turnStartedAt: at(0),
    startedAt: at(5),
    endedAt: null,
  };
  let session = observeWorkSession(
    null,
    { runs: [run], messages: [user], backgroundWork: [background] },
    at(5),
  );
  session = observeWorkSession(
    session,
    { runs: [], messages: [user], backgroundWork: [background] },
    at(10),
  );
  expect(session?.endedAt).toBeNull();
  expect(workSessionElapsedMs(session!, T0 + 40_000)).toBe(40_000);
  const done = { runs: [], messages: [user], backgroundWork: [{ ...background, endedAt: at(55) }] };
  session = observeWorkSession(session, done, at(55));
  expect(session?.endedAt).toBe(at(55));
  expect(workSessionElapsedMs(session!, T0 + 90_000)).toBe(55_000);
  const reloaded = observeWorkSession(null, done, at(90));
  expect(workSessionElapsedMs(reloaded!, T0 + 90_000)).toBe(55_000);
  const resumed = observeWorkSession(
    session,
    {
      ...done,
      runs: [run],
      messages: [user, { ...user, id: "answer", createdAt: at(200) }],
    },
    at(220),
  );
  expect(resumed?.startedAt).toBe(at(200));
  expect(workSessionElapsedMs(resumed!, T0 + 220_000)).toBe(20_000);
});

it("does not attach an older completed background search to an unrelated new task", () => {
  const session = observeWorkSession(
    null,
    {
      runs: [{ id: "new", status: "running", startedAt: at(100) }],
      messages: [{ id: "new-user", role: "user", createdAt: at(100), blocks: [] }],
      backgroundWork: [
        { runId: "old", botId: "sourcer", turnStartedAt: at(0), startedAt: at(5), endedAt: at(55) },
      ],
    },
    at(110),
  );
  expect(session?.startedAt).toBe(at(100));
  expect(workSessionElapsedMs(session!, T0 + 110_000)).toBe(10_000);
});

it("rebuilds a promoted tool turn from its native saved wall duration on reload", () => {
  const session = observeWorkSession(
    null,
    {
      runs: [],
      messages: [
        { id: "user", role: "user", createdAt: at(0), blocks: [] },
        {
          id: "result",
          role: "bot",
          runId: "promoted",
          createdAt: at(60),
          blocks: [
            {
              kind: "steps",
              durationMs: 60_000,
              steps: [{ label: "Web fetch", count: 1, durationMs: 50_000, startedAt: at(5) }],
            },
          ],
        },
      ],
    },
    at(90),
  );
  expect(workSessionElapsedMs(session!, T0 + 90_000)).toBe(60_000);
});

it("restores completed crew stages and their native transcript after reload within the current user turn", () => {
  const messages = [
    { id: "old", role: "bot", runId: "old-run", botId: "outreach", createdAt: at(-10), blocks: [] },
    { id: "user", role: "user", createdAt: at(0), blocks: [] },
    {
      id: "lead",
      role: "bot",
      runId: "lead-run",
      botId: "main",
      createdAt: at(5),
      blocks: [
        {
          kind: "steps",
          durationMs: 5_000,
          steps: [{ label: "Recruiting role", count: 1, durationMs: 100 }],
        },
        { kind: "handoff", fromBotId: "main", toBotId: "sourcer", text: "Native task brief" },
      ],
    },
    {
      id: "source",
      role: "bot",
      runId: "source-run",
      botId: "sourcer",
      createdAt: at(55),
      blocks: [
        {
          kind: "steps",
          durationMs: 50_000,
          steps: [{ label: "Recruiting research", count: 1, durationMs: 49_000 }],
        },
      ],
    },
    { id: "wake", role: "user", internal: true, createdAt: at(56), blocks: [] },
    {
      id: "report",
      role: "bot",
      runId: "report-run",
      botId: "main",
      createdAt: at(60),
      blocks: [
        {
          kind: "steps",
          durationMs: 4_000,
          steps: [{ label: "Read file", count: 1, durationMs: 100 }],
        },
      ],
    },
  ] satisfies Parameters<typeof observeWorkSession>[1]["messages"];
  const restored = observeWorkSession(null, { runs: [], messages }, at(90))!;
  expect(restored.runIds).toEqual(["lead-run", "source-run", "report-run"]);
  expect(workSessionStages(restored).stages).toEqual([
    {
      botId: "sourcer",
      running: false,
      steps: [{ activity: "research", count: 1, durationMs: 49_000 }],
    },
  ]);
  expect(workSessionElapsedMs(restored, T0 + 90_000)).toBe(60_000);
  expect(
    workStageMessages(messages, {
      botId: "sourcer",
      runIds: ["source-run"],
      sourceRunIds: restored.runIds,
    }).map((message) => message.id),
  ).toEqual(["lead", "source"]);
  const nextTask = observeWorkSession(
    null,
    {
      runs: [],
      messages: [...messages, { id: "new-user", role: "user", createdAt: at(80), blocks: [] }],
    },
    at(90),
  );
  expect(nextTask).toBeNull();
});

it("keeps a completed search and its native completion report in the same reloaded total", () => {
  const session = observeWorkSession(
    null,
    {
      runs: [],
      messages: [
        { id: "user", role: "user", createdAt: at(0), blocks: [] },
        { id: "native-wake", role: "user", internal: true, createdAt: at(56), blocks: [] },
        {
          id: "report",
          role: "bot",
          runId: "wake",
          createdAt: at(70),
          blocks: [
            {
              kind: "steps",
              durationMs: 15_000,
              steps: [{ label: "Read file", count: 1, durationMs: 300 }],
            },
          ],
        },
      ],
      backgroundWork: [
        {
          runId: "source",
          botId: "sourcer",
          turnStartedAt: at(0),
          startedAt: at(5),
          endedAt: at(55),
        },
      ],
    },
    at(90),
  );
  expect(workSessionElapsedMs(session!, T0 + 90_000)).toBe(70_000);
});

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
    expect(workSessionSteps(session)).toEqual([{ activity: "role", count: 1, startedAt: at(2) }]);

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
      { activity: "role", count: 1, startedAt: at(2) },
      { activity: "research", count: 1, startedAt: at(5) },
      { activity: "research", count: 1, startedAt: at(31) },
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
      { activity: "role", count: 1, startedAt: at(2) },
      { activity: "research", count: 1, startedAt: at(5) },
      { activity: "research", count: 1, startedAt: at(31) },
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
      runBots: {},
      earlier: { r1: ["role"] },
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
    expect(next).toMatchObject({ startedAt: at(22), runIds: ["r3"], earlier: {} });
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

describe("specialistWorkLabel", () => {
  it("uses closed business status words", () => {
    expect(specialistWorkLabel("running")).toBe("A specialist is working…");
    expect(specialistWorkLabel("completed")).toBe("Specialist finished");
    expect(specialistWorkLabel("failed")).toBe("Specialist needs attention");
  });
});

describe("work progress", () => {
  it("keeps the latest runtime phase and clears it on the next update", () => {
    const thread = {
      runs: [{ id: "run", status: "running", startedAt: at(0) }],
      messages: [
        {
          id: "progress:run",
          runId: "run",
          blocks: [
            {
              kind: "progress",
              activity: true,
              text: "",
              phase: "thinking",
              summary: "Reviewing the search",
            } as MessageBlock,
          ],
        },
      ],
    };
    const session = observeWorkSession(null, thread, at(1));
    expect(session?.progress).toEqual({ phase: "thinking", summary: "Reviewing the search" });
    expect(workProgressLabel(session?.progress)).toBe("Reviewing the search");
    thread.messages[0]!.blocks = [{ kind: "progress", text: "", activity: true }];
    expect(observeWorkSession(session, thread, at(2))?.progress).toBeUndefined();
  });
  it("uses plain phase and activity labels", () => {
    expect(workProgressLabel({ phase: "retrying" })).toBe("Trying again…");
    expect(workProgressLabel({ phase: "compacting" })).toBe("Reviewing context…");
    expect(workProgressLabel({ phase: "thinking" })).toBe("Thinking…");
    expect(workActivityLabel("research")).toBe("Searching candidates");
  });
});

describe("work step outcomes", () => {
  it("preserves outcomes across live updates and turn completion without duplicating steps", () => {
    const runs = [{ id: "r", status: "running", startedAt: at(0) }];
    const message = (steps: MessageBlock[]) => ({
      id: "progress:r",
      runId: "r",
      blocks: steps,
      createdAt: at(2),
    });
    let session = observeWorkSession(
      null,
      {
        runs,
        messages: [message([{ kind: "steps", steps: [{ label: "Web search", count: 1 }] }])],
      },
      at(1),
    );
    session = observeWorkSession(
      session,
      {
        runs,
        messages: [
          message([
            { kind: "steps", steps: [{ label: "Web search", count: 1, status: "failed" }] },
          ]),
        ],
      },
      at(2),
    );
    expect(workSessionSteps(session)).toEqual([{ activity: "search", count: 1, status: "failed" }]);
    session = observeWorkSession(session, { runs: [], messages: [] }, at(3));
    expect(workSessionSteps(session)).toEqual([{ activity: "search", count: 1, status: "failed" }]);
  });
});

it("does not consume a completed step as current during a runtime phase", () => {
  expect(
    runWorkSteps({
      blocks: [
        { kind: "steps", steps: [{ label: "Web search", count: 1, status: "failed" }] },
        { kind: "progress", text: "", activity: true, phase: "retrying" },
      ],
    }),
  ).toEqual({ done: [{ activity: "search", status: "failed" }], current: null });
});

it("keeps the audited outcome when completion and terminal arrive before a render", () => {
  let thread: LiveThread = { threadId: "t", cursor: 0, messages: [], run: null, olderCursor: null };
  const ev = (seq: number, type: string, payload = {}): LiveThreadEvent => ({
    id: `e${seq}`,
    seq,
    type,
    runId: "r",
    threadId: "t",
    createdAt: at(seq),
    payload,
  });
  thread = reduceThreadEvent(thread, ev(1, "run.started"));
  thread = reduceThreadEvent(
    thread,
    ev(2, "agent.tool.called", { name: "web_search", executionId: "x" }),
  );
  let session = observeWorkSession(
    null,
    { runs: thread.activeRuns ?? [], messages: thread.messages },
    at(2),
  );
  thread = reduceThreadEvent(
    thread,
    ev(3, "agent.tool.completed", { name: "web_search", executionId: "x", outcome: "error" }),
  );
  thread = reduceThreadEvent(thread, ev(4, "run.failed", { error: "private failure" }));
  expect(thread.messages.some((message) => message.id.startsWith("progress:"))).toBe(false);
  session = observeWorkSession(
    session,
    { runs: thread.activeRuns ?? [], messages: thread.messages },
    at(4),
  );
  expect(workSessionSteps(session)).toEqual([
    { activity: "search", count: 1, status: "failed", startedAt: at(2) },
  ]);
});

it("uses durable final outcomes once without duplicating the live call", () => {
  let thread: LiveThread = { threadId: "t", cursor: 0, messages: [], run: null, olderCursor: null };
  const ev = (seq: number, type: string, payload = {}): LiveThreadEvent => ({
    id: `e${seq}`,
    seq,
    type,
    runId: "r",
    threadId: "t",
    createdAt: at(seq),
    payload,
  });
  thread = reduceThreadEvent(thread, ev(1, "run.started"));
  thread = reduceThreadEvent(
    thread,
    ev(2, "agent.tool.called", { name: "connectors_execute_tool", executionId: "x" }),
  );
  let session = observeWorkSession(
    null,
    { runs: thread.activeRuns ?? [], messages: thread.messages },
    at(2),
  );
  thread = reduceThreadEvent(
    thread,
    ev(3, "agent.tool.completed", {
      name: "connectors_execute_tool",
      executionId: "x",
      outcome: "succeeded",
      lookup: { found: 3 },
    }),
  );
  thread = reduceThreadEvent(
    thread,
    ev(4, "thread.message.created", {
      messageId: "reply",
      role: "bot",
      blocks: [
        {
          kind: "steps",
          steps: [{ label: "Connectors execute tool", count: 1, peopleWithEmail: 3 }],
        },
        { kind: "text", text: "Found contact details." },
      ],
    }),
  );
  thread = reduceThreadEvent(thread, ev(5, "run.completed"));
  session = observeWorkSession(
    session,
    { runs: thread.activeRuns ?? [], messages: thread.messages },
    at(5),
  );
  expect(workSessionSteps(session)).toEqual([
    { activity: "connected_action", count: 1, peopleWithEmail: 3 },
  ]);
  expect(thread.messages).toHaveLength(1);
});

it("marks an interrupted call paused without changing completed steps during thinking", () => {
  const ev = (seq: number, type: string, payload = {}): LiveThreadEvent => ({
    id: `e${seq}`,
    seq,
    type,
    runId: "r",
    threadId: "t",
    createdAt: at(seq),
    payload,
  });
  const start: LiveThread = {
    threadId: "t",
    cursor: 0,
    messages: [],
    run: null,
    olderCursor: null,
  };
  const called = [
    ev(1, "run.started"),
    ev(2, "agent.tool.called", { name: "web_search", executionId: "x" }),
  ].reduce(reduceThreadEvent, start);
  const interrupted = reduceThreadEvent(called, ev(3, "run.failed", { error: "private reason" }));
  expect(runWorkSteps(interrupted.messages[0]).done).toEqual([
    { activity: "search", status: "paused", startedAt: at(2) },
  ]);
  const thinking = [
    ev(3, "agent.tool.completed", { name: "web_search", executionId: "x", outcome: "succeeded" }),
    ev(4, "thread.progress", { text: "", activity: true, phase: "thinking" }),
    ev(5, "run.failed", { error: "private reason" }),
  ].reduce(reduceThreadEvent, called);
  expect(runWorkSteps(thinking.messages[0]).done).toEqual([
    { activity: "search", startedAt: at(2) },
  ]);
});

describe("workSessionStages", () => {
  const run = (id: string, botId: string, status = "running") => ({
    id,
    botId,
    status,
    startedAt: at(0),
  });
  const row = (runId: string, ...labels: string[]) => ({
    id: `progress:${runId}`,
    runId,
    role: "bot",
    createdAt: at(1),
    blocks: [
      { kind: "steps", steps: labels.map((label) => ({ label, count: 1 })) },
    ] as MessageBlock[],
  });

  it("keeps the lead's steps apart from each member it handed work to", () => {
    let session = observeWorkSession(
      null,
      { runs: [run("r1", "main")], messages: [row("r1", "Recruiting role", "Handoff to bot")] },
      at(1),
    );
    // Main ends its turn after the handoff; the stage carries the turn on.
    session = observeWorkSession(
      session,
      {
        runs: [run("r2", "sourcer")],
        messages: [
          row("r1", "Recruiting role", "Handoff to bot"),
          row("r2", "Recruiting research"),
        ],
      },
      at(3),
    );
    expect(workSessionStages(session)).toEqual({
      own: [
        { activity: "role", count: 1 },
        { activity: "specialist", count: 1 },
      ],
      stages: [{ botId: "sourcer", running: true, steps: [{ activity: "research", count: 1 }] }],
    });
    // A second run of the same member stays one stage; the lead's report run is its own work.
    session = observeWorkSession(
      session,
      {
        runs: [run("r3", "sourcer"), run("r4", "main")],
        messages: [row("r2", "Recruiting research"), row("r3", "Recruiting candidates")],
      },
      at(5),
    );
    session = observeWorkSession(session, { runs: [], messages: [] }, at(9));
    const { own, stages } = workSessionStages(session);
    expect(own).toHaveLength(2);
    expect(stages).toEqual([
      {
        botId: "sourcer",
        running: false,
        steps: [
          { activity: "research", count: 1 },
          { activity: "candidates", count: 1 },
        ],
      },
    ]);
    // The flat list still holds every step in run order.
    expect(workSessionSteps(session).map((step) => step.activity)).toEqual([
      "role",
      "specialist",
      "research",
      "candidates",
    ]);
  });

  it("names stages by what they are for, never by member", () => {
    expect(workStageKind({ spawnKey: "recruiting:u1:sourcer", name: "Ana" })).toBe("sourcing");
    expect(workStageKind({ name: "Reviewer" })).toBe("quality");
    expect(workStageKind({ name: "Helper" })).toBe("other");
    expect(workStageKind(undefined)).toBe("other");
    expect(workStageLabel("sourcing")).toBe("Finding candidates");
  });
});
