import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  handoffToGroupBot,
  isQuietStageReport,
  NO_ROLE_HANDOFF,
  reportGroupHandoffOutcome,
  reportGroupStageOutcome,
} from "./group-handoff.js";

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
  crew?: { spawnKeys: Record<string, string>; activeRecruitingRoleId: string | null },
  waitingCardMessages: { blocks: unknown }[] = [],
) {
  const runCreate = vi.fn(async () => ({ id: "run-b" }));
  const messageCreate = vi.fn(async () => ({ id: "message-1" }));
  const tx = {
    $queryRaw: vi.fn(async () => [
      { id: "group-1", seq: 1, threadId: "thread-1", botId: "bot-2", leaseFence: 0 },
    ]),
    conversationSession: { createMany: vi.fn(async () => ({ count: 1 })) },
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        members: ["bot-a", "bot-b", "bot-c", "bot-d"].map((id) => ({
          bot: { id, name: id.toUpperCase(), spawnKey: crew?.spawnKeys[id] ?? null },
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
      findMany: vi.fn(async () => [{ id: "run-waiting" }]),
      create: runCreate,
    },
    chatGroupMember: { findFirst: vi.fn(async () => ({ botId: "bot-a" })) },
    message: {
      findFirst: vi.fn(async (query?: { where?: { blocks?: unknown } }) =>
        query?.where?.blocks ? null : { blocks: sourceBlocks },
      ),
      findUnique: vi.fn(async () => existing ?? null),
      findMany: vi.fn(async () => waitingCardMessages),
      create: messageCreate,
    },
    thread: {
      findUnique: vi.fn(async () => ({
        activeRecruitingRoleId: crew ? crew.activeRecruitingRoleId : null,
      })),
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
      events: { notify: vi.fn(async () => undefined), wakeSessions: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
    messageCreate,
    runCreate,
    eventCreate: tx.event.create,
    taskCreate: tx.task.create,
    tx,
  };
}

describe("group handoff ownership", () => {
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
        "Not handed off: this stage came from that teammate, and a stage is not handed back to its sender.",
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

describe("approval state on a handoff", () => {
  const bookingCard = {
    kind: "ask",
    text: "Confirm interview booking → Adam Test\nTime: Tue 10:00",
    approvalEffectId: "11111111-1111-4111-8111-111111111111",
    status: "pending",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  };

  it("leaves the brief as written when no approval card waits", async () => {
    const { deps, messageCreate } = harness(
      [{ kind: "text", text: "user request" }],
      undefined,
      undefined,
      [{ blocks: [{ kind: "ask", text: "Which city?", status: "pending" }] }],
    );

    await handoffToGroupBot(deps as never, run, "group-1", {
      bot_id: "bot-b",
      message: "Do the distinct next stage",
    });

    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [expect.objectContaining({ text: "Do the distinct next stage" })],
        }),
      }),
    );
  });
});

describe("handoff target", () => {
  it("falls back to a member's exact name when the id is stale or a name", async () => {
    const stale = harness([{ kind: "text", text: "find them" }]);
    await expect(
      handoffToGroupBot(stale.deps as never, run, "group-1", {
        bot_id: "bot-old",
        confirm_name: "bot-b",
        message: "Find",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });
    const named = harness([{ kind: "text", text: "find them" }]);
    await expect(
      handoffToGroupBot(named.deps as never, run, "group-1", { bot_id: "BOT-C", message: "Find" }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-c" });
  });

  it("still refuses a target outside the group", async () => {
    const { deps, runCreate } = harness([{ kind: "text", text: "find them" }]);
    await expect(
      handoffToGroupBot(deps as never, run, "group-1", { bot_id: "bot-x", message: "Find" }),
    ).resolves.toEqual({ error: "handoff target is not a group member" });
    expect(runCreate).not.toHaveBeenCalled();
  });
});

describe("coordinator search handoff", () => {
  const spawnKeys = { "bot-a": "recruiting:user-1:main", "bot-b": "recruiting:user-1:sourcer" };

  it("sends the brief back to the coordinator when the conversation has no role", async () => {
    const { deps, runCreate } = harness([{ kind: "text", text: "find them all" }], undefined, {
      spawnKeys,
      activeRecruitingRoleId: null,
    });
    await expect(
      handoffToGroupBot(deps as never, run, "group-1", { bot_id: "bot-b", message: "Find all" }),
    ).resolves.toEqual({ error: NO_ROLE_HANDOFF });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("hands the search over once the role is saved", async () => {
    const { deps } = harness([{ kind: "text", text: "find them all" }], undefined, {
      spawnKeys,
      activeRecruitingRoleId: "role-1",
    });
    await expect(
      handoffToGroupBot(deps as never, run, "group-1", { bot_id: "bot-b", message: "Find all" }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });
  });

  it("leaves other teammates' handoffs alone", async () => {
    const { deps } = harness([{ kind: "text", text: "draft it" }], undefined, {
      spawnKeys: { "bot-a": "recruiting:user-1:main", "bot-b": "recruiting:user-1:outreach" },
      activeRecruitingRoleId: null,
    });
    await expect(
      handoffToGroupBot(deps as never, run, "group-1", { bot_id: "bot-b", message: "Draft" }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });
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

  it("tells the sender a stage that ended with no message or card is not done", async () => {
    // Staging: Outreach read a skill and ended silently; the report said its result was above,
    // so Main accepted nothing and the recruiter never got the reply card.
    const { deps, messageCreate } = harness([asked], undefined, undefined, [
      { blocks: [{ kind: "steps", steps: [] }] },
    ]);
    await reportGroupHandoffOutcome(deps as never, worker, "group-1", { status: "completed" });
    const text = (
      messageCreate.mock.calls[0] as unknown as [{ data: { blocks: { text: string }[] } }]
    )[0].data.blocks[0]!.text;
    expect(text).toContain("no message and no card");
    expect(text).not.toMatch(/its result is my last message|NO_RESPONSE/);
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

  it.each([
    ["typed in the chat", true, true, false],
    ["picked on the card", false, false, false],
    // Staging 11-10: the sender already acted on the typed answer, then a report back told it to
    // act on it again, and it restated the recruiter's feedback a second time.
    ["typed in the chat and already replied to", true, false, true],
  ])(
    "reminds the sender of a question closed by a message %s",
    async (_, typed, reminds, replied) => {
      const question = "语言要求按哪种处理？";
      const reply = "我们外联用哪些发件邮箱？";
      const { deps, messageCreate, tx } = harness([asked]);
      tx.message.findFirst.mockImplementation((async (query?: {
        where?: { botId?: string; seq?: unknown };
      }) =>
        query?.where?.botId === "bot-a"
          ? query.where.seq
            ? replied
              ? { id: "reply-1" }
              : null
            : {
                seq: 5,
                blocks: [
                  {
                    kind: "ask",
                    text: question,
                    status: "answered",
                    answer: reply,
                    ...(typed ? { answeredInChat: true } : {}),
                  },
                ],
              }
          : { blocks: [asked] }) as never);
      await reportGroupHandoffOutcome(deps as never, worker, "group-1", { status: "completed" });
      const text = (
        messageCreate.mock.calls[0] as unknown as [{ data: { blocks: [{ text: string }] } }]
      )[0].data.blocks[0].text;
      expect(text.includes(`Your question "${question}" was closed when the recruiter typed`)).toBe(
        reminds,
      );
    },
  );

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

describe("stage end report", () => {
  const asked = {
    kind: "handoff",
    fromBotId: "bot-a",
    toBotId: "bot-b",
    text: "Scale the search to 100 people for this role.",
    hop: 1,
    reportBack: true,
  };
  const stage = { ...run, id: "run-b", botId: "bot-b", sourceMessageId: "message-0" };
  const handedIn = { ...stage, trigger: "follow_up" };
  const wake = (clientNonce: string) => ({
    ...stage,
    id: "wake-1",
    sourceMessageId: null,
    trigger: "recruiting_research",
    clientNonce,
  });

  function stageHarness(existing?: { sourceRuns: [] }, sourceNonce: string | null = null) {
    const h = harness([asked], existing);
    const stageLookup = vi.fn(async () => stage);
    Object.assign(h.deps.prisma, {
      thread: {
        findUnique: vi.fn(async () => ({ activeRecruitingRoleId: "role-1" })),
        findFirst: vi.fn(async () => ({ groupId: "group-1" })),
      },
      run: { findFirst: stageLookup },
      message: { findFirst: vi.fn(async () => ({ clientNonce: sourceNonce })) },
    });
    return { ...h, stageLookup };
  }

  function reported(messageCreate: ReturnType<typeof vi.fn>) {
    return messageCreate.mock.calls.map(
      ([args]) => (args as { data: { clientNonce: string } }).data.clientNonce,
    );
  }

  it("ignores turns that are neither a handed-in stage nor its search", async () => {
    const { deps, messageCreate } = stageHarness();
    await expect(
      reportGroupStageOutcome(deps as never, { ...handedIn, trigger: "user" }, "group-1", {
        status: "completed",
      }),
    ).resolves.toBeUndefined();
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("lets only reading a finished stage end silently", () => {
    const done = [{ ...asked, fromBotId: "bot-b", toBotId: "bot-a", report: "completed" }];
    expect(isQuietStageReport("follow_up", done as never, "bot-a")).toBe(true);
    expect(isQuietStageReport("follow_up", done as never, "bot-b")).toBe(false);
    expect(
      isQuietStageReport("follow_up", [{ ...done[0], report: "failed" }] as never, "bot-a"),
    ).toBe(false);
    expect(isQuietStageReport("user", done as never, "bot-a")).toBe(false);
  });
});
