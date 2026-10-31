import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { checkThreadReplied, replyNudgeNonce } from "./reply-check.js";

const now = Date.parse("2026-10-30T23:30:00Z");

function fixture(options: {
  latest?: {
    role: string;
    createdAt?: Date;
    sourceRuns?: Array<{ botId: string; trigger: string; status?: string; error?: string | null }>;
    steeringMessages?: Array<{
      botId: string;
      claimedAt: Date | null;
      run?: { status: string; error: string | null } | null;
    }>;
  } | null;
  busy?: boolean;
  nudged?: boolean;
}) {
  const latest =
    options.latest === null
      ? null
      : {
          id: "msg_1",
          blocks: [{ kind: "text", text: "find their contacts and email them" }],
          createdAt: new Date(now - 60_000),
          sourceRuns: [{ botId: "main", trigger: "user" }],
          steeringMessages: [],
          role: "user",
          ...options.latest,
        };
  const prisma = {
    thread: {
      findUnique: vi.fn(async () => ({ id: "thread", spaceId: "space", userId: "user" })),
    },
    message: {
      findFirst: vi.fn(async () => latest),
      findUnique: vi.fn(async () => (options.nudged ? { id: "nudge" } : null)),
    },
    run: { findFirst: vi.fn(async () => (options.busy ? { id: "busy" } : null)) },
  };
  const events = {
    sendUserMessage: vi.fn(async () => ({
      messageId: "m",
      seq: 9,
      taskId: "task_2",
      runId: "run_2",
    })),
  };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  return { prisma: prisma as unknown as PrismaClient, events, jobs };
}

describe("every message gets a reply", () => {
  it("still answers a message whose turn the server cancelled as stuck", async () => {
    const test = fixture({
      latest: {
        role: "user",
        sourceRuns: [
          { botId: "main", trigger: "user", status: "cancelled", error: "The turn stopped." },
        ],
      },
    });
    await checkThreadReplied(test, { threadId: "thread" }, now);
    expect(test.events.sendUserMessage).toHaveBeenCalledOnce();
  });

  it("answers a new message after an earlier turn was stopped", async () => {
    const test = fixture({
      latest: {
        role: "user",
        sourceRuns: [{ botId: "main", trigger: "user", status: "completed" }],
      },
    });
    await checkThreadReplied(test, { threadId: "thread" }, now);
    expect(test.events.sendUserMessage).toHaveBeenCalledOnce();
  });

  it("asks the agent once to answer a message its turn left unanswered", async () => {
    const test = fixture({});
    await checkThreadReplied(test, { threadId: "thread" }, now);
    expect(test.events.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "main",
        trigger: "follow_up",
        internal: true,
        clientNonce: replyNudgeNonce("msg_1"),
        prompt: expect.stringContaining('"find their contacts and email them"'),
      }),
    );
    expect(test.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue" }),
    );
  });

  it("answers to the agent that took the message while it was busy", async () => {
    const test = fixture({
      latest: {
        role: "user",
        sourceRuns: [],
        steeringMessages: [{ botId: "sourcer", claimedAt: new Date(now - 30_000) }],
      },
    });
    await checkThreadReplied(test, { threadId: "thread" }, now);
    expect(test.events.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "sourcer" }),
    );
  });

  it.each([
    ["the last message is a reply", { latest: { role: "bot" } }],
    ["a turn is still running", { busy: true }],
    [
      "the message waits to be picked up",
      {
        latest: { role: "user", steeringMessages: [{ botId: "main", claimedAt: null }] },
      },
    ],
    ["it was already nudged once", { nudged: true }],
    ["the message is old", { latest: { role: "user", createdAt: new Date(now - 2 * 3_600_000) } }],
    [
      "it came from an automation",
      {
        latest: { role: "user", sourceRuns: [{ botId: "main", trigger: "webhook" }] },
      },
    ],
    ["no agent received it", { latest: { role: "user", sourceRuns: [] } }],
    [
      "the person stopped the turn for their message",
      {
        latest: {
          role: "user",
          sourceRuns: [{ botId: "main", trigger: "user", status: "cancelled", error: null }],
        },
      },
    ],
    [
      "the person stopped the turn that took their message",
      {
        latest: {
          role: "user",
          sourceRuns: [],
          steeringMessages: [
            {
              botId: "main",
              claimedAt: new Date(now - 30_000),
              run: { status: "cancelled", error: null },
            },
          ],
        },
      },
    ],
  ])("leaves the conversation alone when %s", async (_case, options) => {
    const test = fixture(options as Parameters<typeof fixture>[0]);
    await checkThreadReplied(test, { threadId: "thread" }, now);
    expect(test.events.sendUserMessage).not.toHaveBeenCalled();
  });
});
