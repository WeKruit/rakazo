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
});
