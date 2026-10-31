import { describe, expect, it } from "vitest";
import { answerableAskMessageIds } from "./answerable-ask.js";
import { userVisibleMessages } from "./message-visibility.js";
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
  it.each([undefined, "group"])(
    "projects background promotion without resetting time, steps or sibling turns (%s)",
    (groupId) => {
      const started = reduceThreadEvent(
        { ...base, groupId },
        event(12, "run.started", { trigger: "user" }),
      );
      const working = reduceThreadEvent(
        started,
        event(13, "agent.tool.called", {
          name: "web_fetch",
          executionId: "tool",
          startedAt: "2026-10-23T00:00:00Z",
        }),
      );
      const promoted = reduceThreadEvent(working, {
        ...event(14, "run.started", {
          trigger: "tool_background",
          sourceTrigger: "user",
          backgrounded: true,
          executionId: "tool",
          durationMs: 10_000,
        }),
        createdAt: "2026-10-23T00:00:10Z",
      });
      expect(promoted.run).toMatchObject({
        id: "run",
        trigger: "tool_background",
        startedAt: "2026-10-23T00:00:00Z",
        createdAt: "2026-10-23T00:00:00Z",
      });
      expect(promoted.messages).toBe(working.messages);
      expect(promoted.activeRuns).toHaveLength(1);
      const person = reduceThreadEvent(promoted, {
        ...event(15, "run.started", { trigger: "user" }),
        runId: "person",
      });
      expect(person.activeRuns?.map((run) => run.id)).toEqual(["run", "person"]);
      expect(person.run?.id).toBe("person");
    },
  );
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

  it("keeps a harness auto-continue turn internal so it is never shown live", () => {
    const live = reduceThreadEvent(
      base,
      event(11, "thread.message.created", {
        messageId: "auto-1",
        role: "system",
        internal: true,
        blocks: [{ kind: "text", text: "继续下一步：收集校准反馈。" }],
      }),
    );
    expect(live.messages[0]).toMatchObject({ id: "auto-1", internal: true });
    expect(userVisibleMessages(live.messages)).toEqual([]);
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

  it("keeps the reconnecting mark on the live bubble until the next update", () => {
    const retrying = reduceThreadEvent(
      base,
      event(11, "thread.progress", { text: "", activity: true, phase: "retrying" }),
    );
    expect(retrying.messages[0]?.blocks).toEqual([
      { kind: "progress", text: "", activity: true, phase: "retrying" },
    ]);
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

  it("keeps failed repeated calls distinct and carries audited contact counts", () => {
    const end = fold(started, [
      event(12, "agent.tool.called", { name: "connectors_execute_tool", executionId: "a" }),
      event(13, "agent.tool.called", { name: "connectors_execute_tool", executionId: "b" }),
      event(14, "agent.tool.completed", {
        name: "connectors_execute_tool",
        executionId: "a",
        outcome: "error",
        error: "private detail",
      }),
      event(15, "agent.tool.completed", {
        name: "connectors_execute_tool",
        executionId: "b",
        outcome: "succeeded",
        lookup: { found: 3 },
      }),
    ]);
    expect(live(end)).toEqual([
      {
        kind: "steps",
        steps: [
          {
            label: "Connectors execute tool",
            count: 1,
            status: "failed",
            executionId: "a",
            startedAt: "2026-10-23T00:00:00Z",
          },
          {
            label: "Connectors execute tool",
            count: 1,
            peopleWithEmail: 3,
            executionId: "b",
            startedAt: "2026-10-23T00:00:00Z",
          },
        ],
      },
    ]);
    expect(JSON.stringify(live(end))).not.toContain("private detail");
  });

  it("keeps outcome metadata when completion arrives before its call", () => {
    const end = fold(started, [
      event(12, "agent.tool.completed", { name: "web_search", executionId: "a", outcome: "error" }),
      event(13, "agent.tool.called", { name: "web_search", executionId: "a" }),
    ]);
    expect(live(end)).toEqual([
      {
        kind: "steps",
        steps: [
          {
            label: "Web search",
            count: 1,
            status: "failed",
            executionId: "a",
            startedAt: "2026-10-23T00:00:00Z",
          },
        ],
      },
    ]);
  });

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

describe("queued input", () => {
  const queued = event(11, "thread.message.created", {
    messageId: "user-2",
    role: "user",
    blocks: [{ kind: "text", text: "Only senior people" }],
    queued: true,
  });

  it("holds a queued message until the run reads it", () => {
    const held = reduceThreadEvent(base, queued);
    expect(held.queuedMessageIds).toEqual(["user-2"]);
    const edited = reduceThreadEvent(
      held,
      event(12, "thread.message.updated", {
        messageId: "user-2",
        role: "user",
        blocks: [{ kind: "text", text: "Only staff engineers" }],
        queued: true,
      }),
    );
    expect(edited.queuedMessageIds).toEqual(["user-2"]);
    expect(edited.messages.at(-1)?.blocks).toEqual([
      { kind: "text", text: "Only staff engineers" },
    ]);
    const applied = reduceThreadEvent(
      edited,
      event(13, "run.steering.claimed", { steeringIds: ["s-1"], messageIds: ["user-2"] }),
    );
    expect(applied.queuedMessageIds).toEqual([]);
    expect(applied.messages.map((message) => message.id)).toEqual(["user-2"]);
    expect(eventNeedsSnapshotRead({ type: "run.steering.claimed" })).toBe(false);
  });

  it("drops a removed message and never requeues a replay older than the snapshot", () => {
    const removed = reduceThreadEvent(
      reduceThreadEvent(base, queued),
      event(12, "thread.message.deleted", { messageId: "user-2" }),
    );
    expect(removed.messages).toEqual([]);
    expect(removed.queuedMessageIds).toEqual([]);
    const replayed = reduceThreadEvent({ ...base, cursor: 20 }, queued);
    expect(replayed.queuedMessageIds).toBeUndefined();
  });
});

describe("expired wait", () => {
  it("uses each waiting event timestamp as the persisted deadline anchor on every client", () => {
    const started = reduceThreadEvent(base, event(11, "run.started"));
    const waiting = reduceThreadEvent(started, {
      ...event(12, "run.waiting_input", { updatedAt: "2026-10-30T12:00:00.000Z" }),
      createdAt: "2026-10-30T12:00:02.000Z",
    });
    expect(waiting.run).toMatchObject({ updatedAt: "2026-10-30T12:00:00.000Z" });
    expect(waiting.activeRuns?.[0]).toMatchObject({ updatedAt: "2026-10-30T12:00:00.000Z" });
  });
  const card = { kind: "ask", text: "Which city?", status: "pending" } as const;
  const waiting = fold(base, [
    event(11, "run.started", { trigger: "user" }),
    event(12, "thread.message.created", { messageId: "ask-1", role: "bot", blocks: [card] }),
    event(13, "run.waiting_input"),
  ]);

  it("closes the card the moment the wait expires, before the run ends", () => {
    expect(answerableAskMessageIds(waiting)).toEqual(["ask-1"]);
    const closed = reduceThreadEvent(
      waiting,
      event(14, "thread.message.updated", {
        messageId: "ask-1",
        role: "bot",
        blocks: [{ ...card, status: "expired" }],
      }),
    );
    expect(answerableAskMessageIds(closed)).toEqual([]);
    const ended = reduceThreadEvent(closed, event(15, "run.cancelled"));
    expect(ended.activeRuns).toEqual([]);
    expect(answerableAskMessageIds(ended)).toEqual([]);
    expect(ended.messages.map((message) => message.id)).toEqual(["ask-1"]);
  });

  it("starts the answer like any message: the card shows the answer and a new run works", () => {
    const ended = fold(waiting, [
      event(14, "thread.message.updated", {
        messageId: "ask-1",
        role: "bot",
        blocks: [{ ...card, status: "expired" }],
      }),
      event(15, "run.cancelled"),
    ]);
    const restarted = fold(ended, [
      {
        ...event(16, "thread.message.created", {
          messageId: "user-1",
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          replyToMessageId: "ask-1",
        }),
        runId: "run-2",
      },
      event(17, "thread.message.updated", {
        messageId: "ask-1",
        role: "bot",
        blocks: [{ ...card, status: "answered", answer: "Paris" }],
      }),
      { ...event(18, "run.started", { trigger: "user" }), runId: "run-2" },
    ]);
    expect(restarted.messages.map((message) => message.id)).toEqual(["ask-1", "user-1"]);
    expect(restarted.messages[0]?.blocks).toEqual([
      { ...card, status: "answered", answer: "Paris" },
    ]);
    expect(restarted.run).toMatchObject({ id: "run-2", status: "running" });
    expect(answerableAskMessageIds(restarted)).toEqual([]);
  });
});

it("preserves safe thinking phase and summary through the shared reducer", () => {
  const next = reduceThreadEvent(
    base,
    event(11, "thread.progress", {
      text: "",
      activity: true,
      phase: "thinking",
      summary: "Reviewing the role",
    }),
  );
  expect(next.messages[0]?.blocks).toEqual([
    {
      kind: "progress",
      text: "",
      activity: true,
      phase: "thinking",
      summary: "Reviewing the role",
    },
  ]);
});
