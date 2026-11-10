import { describe, expect, it } from "vitest";
import type { LiveThread } from "./thread-reducer.js";
import { currentSuggestion, reduceThreadEvent } from "./thread-reducer.js";

const thread: LiveThread = {
  threadId: "t1",
  olderCursor: null,
  run: null,
  messages: [
    { id: "u1", role: "user", blocks: [{ kind: "text", text: "hi" }] },
    { id: "b1", role: "bot", runId: "r1", blocks: [{ kind: "text", text: "hello" }] },
  ],
};

describe("thread suggestion", () => {
  it("shows the suggestion while its reply is the newest message", () => {
    const next = reduceThreadEvent(thread, {
      type: "thread.suggestion",
      threadId: "t1",
      runId: "r1",
      seq: 0,
      payload: { text: "Find more" },
    });
    expect(currentSuggestion(next)).toBe("Find more");
    const answered = {
      ...next,
      messages: [
        ...next.messages,
        { id: "u2", role: "user" as const, blocks: [{ kind: "text" as const, text: "ok" }] },
      ],
    };
    expect(currentSuggestion(answered)).toBeNull();
  });

  it("ignores a suggestion for another thread or an older run", () => {
    const other = reduceThreadEvent(thread, {
      type: "thread.suggestion",
      threadId: "t2",
      runId: "r1",
      payload: { text: "x" },
    });
    expect(other.suggestion).toBeUndefined();
    const stale = reduceThreadEvent(thread, {
      type: "thread.suggestion",
      threadId: "t1",
      runId: "r0",
      payload: { text: "x" },
    });
    expect(currentSuggestion(stale)).toBeNull();
  });

  it("hides while a reply is being written, not while background work runs", () => {
    const next = reduceThreadEvent(
      {
        ...thread,
        messages: [
          ...thread.messages,
          { id: "progress:bg", role: "bot", runId: "bg", blocks: [{ kind: "steps", steps: [] }] },
        ],
      },
      { type: "thread.suggestion", threadId: "t1", runId: "r1", payload: { text: "Find more" } },
    );
    expect(currentSuggestion(next, [{ status: "running", trigger: "tool_background" }])).toBe(
      "Find more",
    );
    expect(currentSuggestion(next, [{ status: "running", trigger: "user" }])).toBeNull();
    // A card waiting on the person keeps its suggested answer.
    expect(currentSuggestion(next, [{ status: "waiting_input", trigger: "user" }])).toBe(
      "Find more",
    );
  });

  it("keeps a card's suggested answer only while that card waits", () => {
    const reduced = reduceThreadEvent(thread, {
      type: "thread.suggestion",
      threadId: "t1",
      runId: "r1",
      seq: 0,
      payload: { text: "Remote is fine", card: true },
    });
    expect(reduced.suggestion).toEqual({ runId: "r1", text: "Remote is fine", card: true });
    const card = {
      ...thread,
      messages: [
        {
          id: "m-card",
          role: "bot" as const,
          runId: "run-1",
          blocks: [{ kind: "ask" as const, text: "Remote or onsite?", status: "pending" as const }],
        },
      ],
      suggestion: { runId: "run-1", text: "Remote is fine", card: true as const },
    };
    expect(currentSuggestion(card, [{ status: "waiting_input", trigger: "user" }])).toBe(
      "Remote is fine",
    );
    const later = {
      ...card,
      messages: [
        ...card.messages,
        {
          id: "m-reply",
          role: "bot" as const,
          runId: "run-1",
          blocks: [{ kind: "text" as const, text: "Searching remote people." }],
        },
      ],
    };
    expect(currentSuggestion(later)).toBeNull();
  });
});
