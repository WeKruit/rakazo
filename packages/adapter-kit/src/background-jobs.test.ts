import { describe, expect, it, vi } from "vitest";
import {
  dispatchBackgroundJob,
  HISTORY_COMPACT_MAX_ATTEMPTS,
  historyCompactJob,
  historyCompactJobKey,
  messagingDeliverJob,
  NOTIFICATION_RETRY_ATTEMPTS,
  notificationRetryJob,
  parseBackgroundJob,
  recruitingCandidateProfilesJob,
} from "./background-jobs.js";
import type { BackgroundJobHandlers } from "./types.js";

function handlers(): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "recruiting_research.poll": vi.fn(async () => undefined),
    "recruiting_grade.start": vi.fn(async () => undefined),
    "recruiting_checkin.start": vi.fn(async () => undefined),
    "recruiting_agent_run.wait": vi.fn(async () => undefined),
    "recruiting_profile.project": vi.fn(async () => undefined),
    "recruiting_inbox.project": vi.fn(async () => undefined),
    "thread.reply_check": vi.fn(async () => undefined),
    "notification.retry": vi.fn(async () => undefined),
    "poll.close": vi.fn(async () => undefined),
    "discovery.warm": vi.fn(async () => undefined),
  };
}

describe("background job contracts", () => {
  it("accepts only a canonical inbox receipt id, never caller scope or raw mail", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "recruiting_inbox.project", { effectId: "receipt" });
    expect(target["recruiting_inbox.project"]).toHaveBeenCalledWith({ effectId: "receipt" });
    expect(() =>
      parseBackgroundJob("recruiting_inbox.project", { effectId: "receipt", userId: "other" }),
    ).toThrow();
    expect(() =>
      parseBackgroundJob("recruiting_inbox.project", { effectId: "receipt", mail: "private" }),
    ).toThrow();
  });
  it("accepts a bounded server-normalized live observation and rejects raw provider fields", async () => {
    const email = {
      id: "source:mail",
      sourceId: "source",
      sourceName: "Mail",
      providerMessageId: "mail",
      savedRead: null,
      sender: null,
      recipients: [],
      subject: "Saved",
      body: "Typed observation",
      snippet: false,
      date: null,
      url: null,
    };
    const observation = {
      threadId: "thread",
      roleId: "role",
      sourceId: "source",
      sourceRevision: 1,
      botId: "main",
      campaignId: "campaign",
      observedAt: "2026-10-23T00:00:00.000Z",
      emails: [email],
    };
    expect(parseBackgroundJob("recruiting_inbox.project", { observation }).payload).toEqual({
      observation,
    });
    expect(() =>
      parseBackgroundJob("recruiting_inbox.project", {
        observation: { ...observation, token: "credential" },
      }),
    ).toThrow();
    expect(() =>
      parseBackgroundJob("recruiting_inbox.project", {
        observation: { ...observation, emails: Array.from({ length: 101 }, () => email) },
      }),
    ).toThrow();
  });
  it("queues only a candidate page reference and preserves an existing in-flight projection", async () => {
    const job = recruitingCandidateProfilesJob("page-effect-1");
    expect(job).toEqual({
      name: "recruiting_profile.project",
      payload: { pageEffectId: "page-effect-1" },
      replaceKey: "recruiting_profile.project:page-effect-1",
      keepExisting: true,
    });
    const target = handlers();
    await dispatchBackgroundJob(target, job.name, job.payload);
    expect(target["recruiting_profile.project"]).toHaveBeenCalledWith({
      pageEffectId: "page-effect-1",
    });
    expect(() => parseBackgroundJob(job.name, { pageEffectId: "" })).toThrow();
    expect(() =>
      parseBackgroundJob(job.name, {
        pageEffectId: "page-effect-1",
        profile: { photo: "https://example.test/private" },
      }),
    ).toThrow();
  });
  it("validates and dispatches messaging.deliver", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "messaging.deliver", { runId: "run-1" });
    expect(target["messaging.deliver"]).toHaveBeenCalledWith({ runId: "run-1" });
    expect(messagingDeliverJob("run-1")).toEqual({
      name: "messaging.deliver",
      payload: { runId: "run-1" },
      replaceKey: "messaging.deliver:run-1",
    });
    expect(messagingDeliverJob()).toEqual({
      name: "messaging.deliver",
      payload: {},
      replaceKey: "messaging.deliver:drain",
    });
  });

  it("validates and dispatches a typed job", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "routine.wakeup", {
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
    expect(target["routine.wakeup"]).toHaveBeenCalledWith({
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
  });

  it("rejects unknown names and malformed deliveries", () => {
    expect(() => parseBackgroundJob("unknown", {})).toThrow("Unknown background job");
    expect(() =>
      parseBackgroundJob("routine.wakeup", {
        routineId: "routine-1",
        scheduledFor: "not-a-date",
      }),
    ).toThrow();
    expect(() => parseBackgroundJob("run.continue", { runId: "" })).toThrow();
    expect(() =>
      parseBackgroundJob("computer.control-expire", {
        computerId: "computer-1",
        leaseId: "",
      }),
    ).toThrow();
  });

  it("validates and dispatches a control-expiry job", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "computer.control-expire", {
      computerId: "computer-1",
      leaseId: "lease-1",
    });
    expect(target["computer.control-expire"]).toHaveBeenCalledWith({
      computerId: "computer-1",
      leaseId: "lease-1",
    });
  });
});

describe("historyCompactJob", () => {
  it("retains the actual originating run through dispatch", async () => {
    const target = handlers();
    const job = historyCompactJob("thread-1", "origin-run");
    expect(job).toMatchObject({
      payload: { threadId: "thread-1", sourceRunId: "origin-run" },
    });
    await dispatchBackgroundJob(target, job.name, job.payload);
    expect(target["history.compact"]).toHaveBeenCalledWith({
      threadId: "thread-1",
      sourceRunId: "origin-run",
    });
  });

  it("builds a job with a replace key scoped to the thread", () => {
    expect(historyCompactJob("thread-1")).toEqual({
      name: "history.compact",
      payload: { threadId: "thread-1" },
      replaceKey: historyCompactJobKey("thread-1"),
      serialKey: historyCompactJobKey("thread-1"),
      maxAttempts: HISTORY_COMPACT_MAX_ATTEMPTS,
    });
  });

  it("caps attempts below the queue default so a stuck thread cannot storm", () => {
    expect(HISTORY_COMPACT_MAX_ATTEMPTS).toBeLessThan(25);
  });

  it("keys different threads differently", () => {
    expect(historyCompactJobKey("thread-1")).not.toBe(historyCompactJobKey("thread-2"));
  });
});

describe("notificationRetryJob", () => {
  it("retries a failed run notification a few times and dispatches it intact", async () => {
    const message = {
      kind: "completion" as const,
      title: "Main finished",
      body: "Found 12 people",
      botId: "bot-1",
      threadId: "thread-1",
    };
    const job = notificationRetryJob({ runId: "run-1", message }, new Date(0));
    expect(job).toMatchObject({
      replaceKey: "notification.retry:run-1:completion",
      maxAttempts: NOTIFICATION_RETRY_ATTEMPTS,
    });
    const handlers = { "notification.retry": vi.fn(async () => undefined) };
    await dispatchBackgroundJob(handlers as never, job.name, job.payload);
    expect(handlers["notification.retry"]).toHaveBeenCalledWith({ runId: "run-1", message });
  });
});
