import { describe, expect, it } from "vitest";
import type { LiveThread, LiveThreadEvent } from "./thread-reducer.js";
import {
  addPendingUserMessage,
  eventNeedsSnapshotRead,
  hasPendingUserMessage,
  reduceThreadEvent,
  removePendingUserMessage,
} from "./thread-reducer.js";

const base: LiveThread = {
  threadId: "thread",
  cursor: 10,
  messages: [],
  olderCursor: null,
  run: null,
  activeRuns: [],
};

function event(seq: number, type: string, payload: Record<string, unknown> = {}): LiveThreadEvent {
  return {
    id: `event-${seq}`,
    type,
    threadId: "thread",
    botId: "bot",
    runId: "run",
    seq,
    createdAt: "2026-10-23T00:00:00Z",
    payload,
  };
}

const turn: LiveThreadEvent[] = [
  event(11, "thread.message.created", {
    messageId: "user-1",
    role: "user",
    blocks: [{ kind: "text", text: "Find leads" }],
  }),
  event(12, "run.started", { trigger: "user" }),
  event(13, "agent.tool.called", { name: "recruiting_search" }),
  event(14, "thread.progress", { text: "Searching", streaming: true }),
  event(15, "thread.message.created", {
    messageId: "bot-1",
    role: "bot",
    blocks: [{ kind: "text", text: "Three leads." }],
  }),
  event(16, "run.completed"),
];

const fold = (start: LiveThread, events: readonly LiveThreadEvent[]) =>
  events.reduce((thread, item) => reduceThreadEvent(thread, item), start);

const visible = (thread: LiveThread) =>
  thread.messages.map((message) => [message.id, message.role, message.blocks]);

describe("shared thread reducer", () => {
  it("starts a run it has not seen, so a mobile snapshot tracks the same run as web", () => {
    const started = reduceThreadEvent(base, event(12, "run.started", { trigger: "user" }));
    expect(started.run).toMatchObject({ id: "run", status: "running", trigger: "user" });
    expect(started.activeRuns).toEqual([started.run]);
  });

  it("folds a whole turn to the final reply with no live bubble left", () => {
    const end = fold(base, turn);
    expect(visible(end)).toEqual([
      ["user-1", "user", [{ kind: "text", text: "Find leads" }]],
      ["bot-1", "bot", [{ kind: "text", text: "Three leads." }]],
    ]);
    expect(end.run).toBeNull();
    expect(end.cursor).toBe(16);
  });

  it("keeps two windows on the same stream identical, with the sender's echo settled", () => {
    const sender = addPendingUserMessage(base, {
      clientNonce: "nonce",
      text: "Find leads",
      createdAt: "2026-10-23T00:00:00Z",
    });
    expect(hasPendingUserMessage(sender)).toBe(true);
    const a = fold(sender, turn);
    const b = fold(base, turn);
    expect(visible(a)).toEqual(visible(b));
    expect(a.run).toEqual(b.run);
    expect(hasPendingUserMessage(a)).toBe(false);
  });

  it("catches a window up from its cursor without duplicates when it reconnects", () => {
    const early = fold(base, turn.slice(0, 2));
    // A reconnect replays from the window's cursor; one event may arrive twice.
    const late = fold(early, turn.slice(1));
    expect(visible(late)).toEqual(visible(fold(base, turn)));
  });

  it("never moves the cursor back for a transient (seq 0) progress frame", () => {
    const progressed = reduceThreadEvent(base, event(0, "thread.progress", { delta: "Hi" }));
    expect(progressed.cursor).toBe(10);
  });

  it("does not revive an ended run from a replayed older start", () => {
    const ended = { ...base, cursor: 20 };
    expect(reduceThreadEvent(ended, event(12, "run.started", { trigger: "user" }))).toBe(ended);
  });

  it("withdraws exactly the failed send's echo", () => {
    const two = addPendingUserMessage(
      addPendingUserMessage(base, { clientNonce: "a", text: "one", createdAt: "t" }),
      { clientNonce: "b", text: "two", createdAt: "t" },
    );
    expect(removePendingUserMessage(two, "a").messages.map((message) => message.id)).toEqual([
      "pending:b",
    ]);
  });

  it("settles the echo with the same text even when sends confirm out of order", () => {
    const two = addPendingUserMessage(
      addPendingUserMessage(base, { clientNonce: "a", text: "one", createdAt: "t" }),
      { clientNonce: "b", text: "two", createdAt: "t" },
    );
    const settled = reduceThreadEvent(
      two,
      event(11, "thread.message.created", {
        messageId: "durable-two",
        role: "user",
        blocks: [{ kind: "text", text: "two" }],
      }),
    );
    expect(settled.messages.map((message) => message.id)).toEqual(["pending:a", "durable-two"]);
  });

  it("marks compaction on the live bubble and clears it on the next update", () => {
    const compacting = reduceThreadEvent(
      base,
      event(11, "thread.progress", { text: "", activity: true, phase: "compacting" }),
    );
    expect(compacting.messages[0]?.blocks).toEqual([
      { kind: "progress", text: "", activity: true, phase: "compacting" },
    ]);
    const writing = reduceThreadEvent(compacting, event(12, "thread.progress", { text: "Done" }));
    expect(writing.messages[0]?.blocks).toEqual([{ kind: "progress", text: "Done" }]);
  });

  it("asks for a full read only after events the reducer cannot fold", () => {
    for (const type of ["thread.progress", "run.completed", "usage.recorded", "recruiting.changed"])
      expect(eventNeedsSnapshotRead({ type })).toBe(false);
    for (const type of ["routine.created", "skill.saved", "thread.meta", "thread.message.reaction"])
      expect(eventNeedsSnapshotRead({ type })).toBe(true);
  });
});

describe("tool step closure by execution", () => {
  const live = (thread: LiveThread) =>
    thread.messages.find((message) => message.id === "progress:run")?.blocks ?? [];
  const active = (thread: LiveThread) =>
    live(thread).some((block) => block.kind === "progress" && block.activity === true);
  const started = reduceThreadEvent(base, event(11, "run.started", { trigger: "user" }));

  it("keeps a step closed when its completion was stored before its start", () => {
    const end = fold(started, [
      event(12, "agent.tool.completed", {
        name: "task_catalog",
        executionId: "a",
        outcome: "succeeded",
      }),
      event(13, "agent.tool.called", { name: "task_catalog", executionId: "a" }),
    ]);
    expect(active(end)).toBe(false);
  });

  it("keeps a later step running when an earlier one completes", () => {
    const end = fold(started, [
      event(12, "agent.tool.called", { name: "skill_read", executionId: "a" }),
      event(13, "agent.tool.called", { name: "read_history", executionId: "b" }),
      event(14, "agent.tool.completed", {
        name: "skill_read",
        executionId: "a",
        outcome: "succeeded",
      }),
    ]);
    expect(active(end)).toBe(true);
    const done = reduceThreadEvent(
      end,
      event(15, "agent.tool.completed", {
        name: "read_history",
        executionId: "b",
        outcome: "succeeded",
      }),
    );
    expect(active(done)).toBe(false);
  });
});
