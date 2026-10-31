import { describe, expect, it } from "vitest";
import { RunSchema, ThreadSnapshotSchema } from "./domain.js";
import {
  RoutineHistorySchema,
  RUN_TRIGGERS,
  RunActivityRowSchema,
  RunTriggerSchema,
} from "./runs.js";

describe("run triggers", () => {
  it("accepts every shared trigger in the run output schemas", () => {
    for (const trigger of RUN_TRIGGERS) {
      expect(RunTriggerSchema.parse(trigger)).toBe(trigger);
      expect(
        RunSchema.parse({
          id: "run-1",
          botId: "bot-1",
          threadId: "thread-1",
          taskId: "task-1",
          status: "running",
          trigger,
          routineId: null,
          modelProvider: null,
          modelId: null,
          error: null,
          startedAt: null,
          completedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }).trigger,
      ).toBe(trigger);
      expect(
        RunActivityRowSchema.parse({
          runId: "run-1",
          botId: "bot-1",
          botName: "Helper",
          groupId: null,
          groupName: null,
          threadId: "thread-1",
          status: "running",
          trigger,
          notificationsEnabled: false,
          promptSnippet: "",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }).trigger,
      ).toBe(trigger);
    }
  });

  it("returns a conversation whose latest run is a research wake-up", () => {
    // A group snapshot whose newest terminal run was a recruiting research wake-up failed
    // output validation, so threads.get answered 500 and the conversation would not open.
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "recruiting_research",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: "Run failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const snapshot = {
      groupId: "group-1",
      groupName: "Quality manager",
      members: [{ botId: "bot-1", name: "Main", color: "blue" }],
      threadId: "thread-1",
      cursor: 10,
      messages: [],
      olderCursor: null,
      run,
      activeRuns: [{ ...run, status: "waiting_input", error: null, completedAt: null }],
    };
    expect(ThreadSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("includes the ticket trigger and rejects unknown ones", () => {
    expect(RUN_TRIGGERS).toContain("tickets");
    expect(() => RunTriggerSchema.parse("not-a-trigger")).toThrow();
  });
});

it("keeps independent delegated run states and parentage under the original routine page", () => {
  const root = {
    id: "root",
    botId: "main",
    groupId: null,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    messageId: null,
  };
  const history = {
    runs: [
      {
        ...root,
        delegations: [
          {
            ...root,
            id: "child",
            parentRunId: root.id,
            botId: "helper",
            botName: "Helper",
            status: "waiting_input",
          },
        ],
      },
    ],
    nextCursor: null,
  };
  expect(RoutineHistorySchema.parse(history)).toEqual(history);
  expect(RoutineHistorySchema.safeParse({ runs: [root], nextCursor: null }).success).toBe(false);
});
