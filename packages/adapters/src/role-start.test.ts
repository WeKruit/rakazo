import { describe, expect, it, vi } from "vitest";
import { startRoleFromRecruiterMessage } from "./role-start.js";

vi.mock("@rakazo/db", () => ({
  withTransactionRetry: (fn: () => unknown) => fn(),
  createThreadMessageInTransaction: vi.fn(async (_tx: unknown, input: { blocks: unknown }) => ({
    id: "msg-role",
    ...input,
  })),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));

function deps(source: unknown, already: unknown = null) {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    message: { findUnique: vi.fn(async () => already) },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
    run: { create: vi.fn(async () => ({ id: "run-1" })) },
  };
  return {
    tx,
    deps: {
      prisma: {
        message: { findMany: vi.fn(async () => (source ? [source] : [])) },
        $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
      },
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
  };
}

const run = { spaceId: "s", userId: "u", threadId: "t-global", sourceMessageId: "m-1" };
const role = { threadId: "t-role", botId: "bot-main", deliveryKey: "k" };

describe("startRoleFromRecruiterMessage", () => {
  it("copies the recruiter's own words into the role and starts the lead's turn", async () => {
    const { deps: d, tx } = deps({
      role: "user",
      botId: null,
      clientNonce: null,
      externalTranscriptFor: null,
      blocks: [
        {
          kind: "text",
          text: "Open an agent engineer role",
          recruitingContext: { roleTitle: "Kruit" },
        },
      ],
    });
    expect(await startRoleFromRecruiterMessage(d as never, run, role)).toBe(true);
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-main",
          trigger: "user",
          sourceMessageId: "msg-role",
        }),
      }),
    );
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ prompt: "Open an agent engineer role" }),
      }),
    );
    expect(d.jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not start twice for the same call", async () => {
    const { deps: d, tx } = deps(
      {
        role: "user",
        botId: null,
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "x" }],
      },
      { id: "msg-role" },
    );
    expect(await startRoleFromRecruiterMessage(d as never, run, role)).toBe(true);
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(d.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("uses the recruiter's latest message, skipping teammates' messages", async () => {
    const { deps: d, tx } = deps(null);
    d.prisma.message.findMany = vi.fn(async () => [
      {
        role: "user",
        botId: null,
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "bot_message_received", text: "x" }],
      },
      {
        role: "user",
        botId: null,
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "Open role 5" }],
      },
      {
        role: "user",
        botId: null,
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "Open role 4" }],
      },
    ]) as never;
    expect(await startRoleFromRecruiterMessage(d as never, run, role)).toBe(true);
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ prompt: "Open role 5" }) }),
    );
  });

  it("refuses a source the recruiter did not write", async () => {
    for (const source of [
      {
        role: "user",
        botId: null,
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "bot_message_received", text: "x" }],
      },
      {
        role: "bot",
        botId: "b",
        clientNonce: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "x" }],
      },
      {
        role: "user",
        botId: null,
        clientNonce: "autocontinue:1",
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "x" }],
      },
      null,
    ]) {
      const { deps: d } = deps(source);
      expect(await startRoleFromRecruiterMessage(d as never, run, role)).toBe(false);
    }
  });
});
