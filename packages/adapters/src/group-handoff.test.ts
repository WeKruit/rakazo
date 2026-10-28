import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { handoffToGroupBot, reportGroupHandoffOutcome } from "./group-handoff.js";

const run = {
  id: "run-a",
  spaceId: "workspace-1",
  threadId: "thread-1",
  botId: "bot-a",
  userId: "user-1",
};

function harness(
  sourceBlocks: unknown,
  existing?: { sourceRuns: { id: string; botId: string }[] },
) {
  const runCreate = vi.fn(async () => ({ id: "run-b" }));
  const messageCreate = vi.fn(async () => ({ id: "message-1" }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "group-1" }]),
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        members: ["bot-a", "bot-b", "bot-c"].map((id) => ({
          bot: { id, name: id.toUpperCase() },
        })),
      })),
      update: vi.fn(async () => ({ id: "group-1" })),
    },
    run: {
      findFirst: vi.fn(async () => ({
        id: run.id,
        sourceMessage: { blocks: sourceBlocks },
      })),
      findUnique: vi.fn(async () => ({ status: "running" })),
      create: runCreate,
    },
    chatGroupMember: { findFirst: vi.fn(async () => ({ botId: "bot-a" })) },
    message: {
      findFirst: vi.fn(async () => ({ blocks: sourceBlocks })),
      findUnique: vi.fn(async () => existing ?? null),
      create: messageCreate,
    },
    thread: {
      update: vi.fn(async (args: { select: { nextMessageSeq?: boolean } }) =>
        args.select.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 2 },
      ),
    },
    task: { create: vi.fn(async () => ({ id: "task-b" })) },
    event: {
      findFirst: vi.fn(async () => ({ seq: 1 })),
      create: vi.fn(async () => ({ seq: 1 })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
    messageCreate,
    runCreate,
    eventCreate: tx.event.create,
  };
}

describe("group handoff ownership", () => {
  it("retries a transaction conflict before creating one child and notifying once", async () => {
    const { deps, messageCreate, runCreate, eventCreate } = harness([
      { kind: "text", text: "user request" },
    ]);
    messageCreate.mockRejectedValueOnce(
      Object.assign(new Error("write conflict or a deadlock"), { code: "P2034" }),
    );

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Do the distinct next stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b", runId: "run-b" });

    expect(deps.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(messageCreate).toHaveBeenCalledTimes(2);
    expect(runCreate).toHaveBeenCalledOnce();
    expect(eventCreate).toHaveBeenCalledOnce();
    expect(deps.events.notify).toHaveBeenCalledExactlyOnceWith(run.threadId, 1);
    expect(deps.jobs.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-b" } }),
    );
  });

  it("marks a new ownership transfer as a follow-up with a chain hop", async () => {
    const { deps, messageCreate, runCreate } = harness([{ kind: "text", text: "user request" }]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Do the distinct next stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });

    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              kind: "handoff",
              fromBotId: "bot-a",
              toBotId: "bot-b",
              hop: 1,
            }),
          ],
        }),
      }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "follow_up" }) }),
    );
  });

  it("refuses to bounce a handed-off stage straight back to its sender", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Investigate", hop: 1 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "You investigate it",
      }),
    ).resolves.toEqual({
      error:
        "do not hand this stage back to its sender; post the result in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("caps longer multi-agent handoff chains", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Stage six", hop: 6 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "Stage seven",
      }),
    ).resolves.toEqual({
      error:
        "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("reuses the recorded transfer when a source run is retried", async () => {
    const { deps, messageCreate, runCreate } = harness([], {
      sourceRuns: [{ id: "run-b", botId: "bot-b" }],
    });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "A duplicate stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b", runId: "run-b" });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed source ancestry instead of restarting its hop count", async () => {
    const { deps, runCreate } = harness({ kind: "not-an-array" });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Continue",
      }),
    ).resolves.toEqual({ error: "cannot verify the group handoff chain" });
    expect(runCreate).not.toHaveBeenCalled();
  });
});

describe("group handoff report back", () => {
  const worker = { ...run, id: "run-b", botId: "bot-b", sourceMessageId: "message-0" };
  const asked = {
    kind: "handoff",
    fromBotId: "bot-a",
    toBotId: "bot-b",
    text: "Goal: find ten people. Done when: ten saved profiles.",
    hop: 1,
    reportBack: true,
  };

  it("records report_back on the brief and tells the sender the result returns", async () => {
    const { deps, messageCreate } = harness([{ kind: "text", text: "user request" }]);
    const result = await handoffToGroupBot(deps as never, run, "group-1", {
      bot_id: "bot-b",
      message: asked.text,
      report_back: true,
    });
    expect(result).toMatchObject({ ok: true, note: expect.stringContaining("comes back to you") });
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [expect.objectContaining({ reportBack: true })],
        }),
      }),
    );
  });

  it.each([
    ["completed", undefined, "Finished the stage"],
    ["failed", "provider down", "Could not finish the stage you handed me: provider down"],
  ] as const)("wakes the sender when the stage %s", async (status, error, text) => {
    const { deps, messageCreate, runCreate } = harness([asked]);
    await expect(
      reportGroupHandoffOutcome(deps as never, worker, "group-1", { status, error }),
    ).resolves.toEqual({ runId: "run-b" });
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientNonce: "group-report:run-b",
          blocks: [
            expect.objectContaining({
              fromBotId: "bot-b",
              toBotId: "bot-a",
              hop: 2,
              report: status,
              text: expect.stringContaining(text),
            }),
          ],
        }),
      }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "bot-a", trigger: "follow_up" }),
      }),
    );
  });

  it("stays quiet when the sender did not ask, or already got the report", async () => {
    const plain = harness([{ ...asked, reportBack: undefined }]);
    await expect(
      reportGroupHandoffOutcome(plain.deps as never, worker, "group-1", { status: "completed" }),
    ).resolves.toBeUndefined();
    expect(plain.runCreate).not.toHaveBeenCalled();
    const again = harness([asked], { sourceRuns: [] });
    await expect(
      reportGroupHandoffOutcome(again.deps as never, worker, "group-1", { status: "completed" }),
    ).resolves.toBeUndefined();
    expect(again.runCreate).not.toHaveBeenCalled();
  });

  it("lets the sender hand a correction back after a report", async () => {
    const { deps } = harness([
      { ...asked, fromBotId: "bot-b", toBotId: "bot-a", hop: 2, report: "completed" },
    ]);
    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Two of the ten are outside the area; replace them.",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });
  });
});
