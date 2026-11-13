import type { PrismaClient } from "@rakazo/db";
import { chatReplyToAsk } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  GLOBAL_HANDOFF_ROLE_WORK,
  handoffToGroupBot,
  isQuietStageReport,
  NO_ROLE_HANDOFF,
  reportGroupHandoffOutcome,
  reportGroupStageOutcome,
  reportStalledGroupStage,
  watchOpenStages,
} from "./group-handoff.js";
import { recruitingResearchInFlight } from "./recruiting-research-poll.js";

vi.mock("./recruiting-research-poll.js", () => ({
  recruitingResearchInFlight: vi.fn(async () => false),
}));

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
    $queryRaw: vi.fn(async () => [{ id: "group-1" }]),
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        members: ["bot-a", "bot-b", "bot-c"].map((id) => ({
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
    externalEffect: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
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
    taskCreate: tx.task.create,
    tx,
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

  it("lets a run resumed by an answer hand off again under that answer's key", async () => {
    const { deps, messageCreate } = harness([]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        turnKey: "answer-2",
        bot_id: "bot-b",
        message: "The recruiter answered: contact them",
      }),
    ).resolves.toMatchObject({ ok: true, runId: "run-b" });
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: "group-handoff:run-a:answer-2" }),
      }),
    );
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

  it("tells the next bot a card is still waiting even when the sender claims it was allowed", async () => {
    const { deps, messageCreate, taskCreate } = harness(
      [{ kind: "text", text: "can you read my calendar?" }],
      undefined,
      undefined,
      [{ blocks: [bookingCard] }, { blocks: [{ ...bookingCard, status: "answered" }] }],
    );

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message:
          "The user just selected Allow once on Confirm interview booking → Adam Test. Book it.",
      }),
    ).resolves.toMatchObject({ ok: true });

    const note =
      'still waiting for the user, nobody has answered: "Confirm interview booking → Adam Test"';
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [expect.objectContaining({ text: expect.stringContaining(note) })],
        }),
      }),
    );
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ prompt: expect.stringContaining(note) }),
      }),
    );
  });

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

describe("account-wide conversation handoff", () => {
  const spawnKeys = {
    "bot-a": "recruiting:user-1:main",
    "bot-b": "recruiting:user-1:outreach",
    "bot-c": "recruiting:user-1:sourcer",
  };
  const global = "recruiting-global-abc";

  // 11-11 staging: "email alex@… about a backend role" from a fresh account hit a dead end
  // because Main could not reach Outreach in the account-wide conversation.
  it("hands a one-off email to Outreach without a role", async () => {
    const { deps, tx } = harness([{ kind: "text", text: "email alex" }], undefined, {
      spawnKeys,
      activeRecruitingRoleId: null,
    });
    Object.assign(tx, {
      recruitingRole: {
        findMany: vi.fn(async () => [{ id: "role-9", title: "Senior Data Engineer" }]),
      },
    });
    await expect(
      handoffToGroupBot(deps as never, run, global, { bot_id: "bot-b", message: "Email Alex" }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });
  });

  it("sends work in a role the recruiter named to that role's team", async () => {
    const { deps, runCreate, tx } = harness(
      [{ kind: "text", text: "在「测试固定 · Agent 工程师 5」里，回复那封邮件" }],
      undefined,
      { spawnKeys, activeRecruitingRoleId: null },
    );
    Object.assign(tx, {
      recruitingRole: {
        findMany: vi.fn(async () => [{ id: "role-9", title: "测试固定 · Agent 工程师 5" }]),
      },
    });
    const result = await handoffToGroupBot(deps as never, run, global, {
      bot_id: "bot-b",
      message: "Reply",
    });
    expect(result).toMatchObject({ error: expect.stringContaining('role_id "role-9"') });
    expect(runCreate).not.toHaveBeenCalled();
  });

  // 11-11 staging: the request was steered into a turn started by another message.
  it("reads the role from the brief when the turn started from another message", async () => {
    const { deps, runCreate, tx } = harness([{ kind: "text", text: "Dallas" }], undefined, {
      spawnKeys,
      activeRecruitingRoleId: null,
    });
    Object.assign(tx, {
      recruitingRole: {
        findMany: vi.fn(async () => [{ id: "role-9", title: "测试固定 · Agent 工程师 5" }]),
      },
    });
    const result = await handoffToGroupBot(deps as never, run, global, {
      bot_id: "bot-b",
      message: "Goal: 在「测试固定 · Agent 工程师 5」里，回复那封邮件",
    });
    expect(result).toMatchObject({ error: expect.stringContaining('role_id "role-9"') });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("keeps role work with the role's team", async () => {
    const { deps, runCreate } = harness([{ kind: "text", text: "find people" }], undefined, {
      spawnKeys,
      activeRecruitingRoleId: null,
    });
    await expect(
      handoffToGroupBot(deps as never, run, global, { bot_id: "bot-c", message: "Find" }),
    ).resolves.toEqual({ error: GLOBAL_HANDOFF_ROLE_WORK });
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

  it("returns a verified discarded card even when the child has no final text", async () => {
    const h = harness([asked]);
    h.tx.run.findFirst.mockResolvedValue({
      id: worker.id,
      botId: worker.botId,
      sourceMessage: {
        id: "request",
        seq: 10,
        threadId: worker.threadId,
        role: "bot",
        botId: "bot-a",
        runId: "run-a",
        blocks: [asked],
      },
    } as never);
    h.tx.message.findMany.mockResolvedValue([
      {
        id: "card",
        runId: worker.id,
        blocks: [
          {
            kind: "ask",
            text: "Draft",
            status: "answered",
            actions: [
              { id: "allow", label: "Send" },
              { id: "deny", label: "Discard" },
            ],
            approvalEffectId: "private-effect",
            mailReply: {
              from: "sender@example.test",
              to: ["candidate@example.test"],
              cc: [],
              bcc: [],
              subject: "Re: Original",
              body: "Draft",
              status: "needs_approval",
              sentAt: null,
              inReplyTo: {
                sourceId: "source",
                emailId: "anchor",
                threadId: "mail-thread",
                subject: "Original",
                sender: "candidate@example.test",
              },
            },
          },
        ],
      } as never,
    ]);
    Object.assign(h.tx, {
      externalEffect: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "private-effect",
            runId: worker.id,
            status: "denied",
            request: {},
            result: null,
            updatedAt: new Date(),
            run: { status: "completed" },
          },
        ]),
      },
    });
    await reportGroupHandoffOutcome(h.deps as never, worker, "group-1", { status: "completed" });
    const message = JSON.stringify(h.messageCreate.mock.calls);
    const task = JSON.stringify(h.taskCreate.mock.calls);
    expect(message).toContain("user explicitly discarded");
    expect(task).toContain("user explicitly discarded");
    expect(message + task).not.toMatch(/private-effect|my result is my last message/);
  });

  it.each([
    ["completed", undefined, "Finished the stage"],
    ["failed", "provider down", "Could not finish the stage you handed me: provider down"],
  ] as const)("wakes the sender when the stage %s", async (status, error, text) => {
    const { deps, messageCreate, runCreate } = harness([asked], undefined, undefined, [
      { blocks: [{ kind: "text", text: "Saved ten people." }] },
    ]);
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

  it.each([
    ["没有发出去的原因是什么？", false],
    ["Find ten more people like these.", true],
  ])("after an answered %s, wakes the sender: %s", async (question, wakes) => {
    // Staging 11-13: the teammate answered the recruiter's question, then the sender restated it
    // and handed it back, so one question got three answers.
    const { deps, runCreate, tx } = harness([asked], undefined, undefined, [
      { blocks: [{ kind: "text", text: "已排队 3 人，周五 9:00 发出。" }] },
    ]);
    tx.message.findFirst.mockImplementation((async (query?: {
      where?: { role?: string; blocks?: unknown };
    }) =>
      query?.where?.blocks
        ? null
        : query?.where?.role === "user"
          ? { blocks: [{ kind: "text", text: question }] }
          : { blocks: [asked] }) as never);
    await reportGroupHandoffOutcome(deps as never, worker, "group-1", { status: "completed" });
    expect(runCreate.mock.calls.length > 0).toBe(wakes);
  });

  it("leaves the next step to the recruiter while a card waits on them", async () => {
    // Staging 11-13: the teammate asked to connect Gmail, and the sender re-handed the send four
    // times, each answer repeating "connect Gmail first".
    const { deps, runCreate, tx } = harness([asked], undefined, undefined, [
      { blocks: [{ kind: "text", text: "Gmail 尚未连接，请先完成连接卡。" }] },
    ]);
    tx.message.findFirst.mockImplementation((async (query?: {
      where?: { role?: string; blocks?: unknown };
    }) =>
      query?.where?.blocks
        ? { id: "connect-card" }
        : query?.where?.role === "user"
          ? { blocks: [{ kind: "text", text: "那你就直接发啊" }] }
          : { blocks: [asked] }) as never);
    await reportGroupHandoffOutcome(deps as never, worker, "group-1", { status: "completed" });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("does not wake the sender after a send the recruiter confirmed", async () => {
    // Staging 11-13: Outreach said the confirmed email went out, then the report woke Main,
    // which listed the account's five roles nobody asked about.
    const { deps, runCreate, tx } = harness([asked], undefined, undefined, [
      { blocks: [{ kind: "text", text: "已发给 Noah 和 Ada。" }] },
    ]);
    tx.externalEffect.findFirst.mockResolvedValue({ id: "effect-sent" });
    await expect(
      reportGroupHandoffOutcome(deps as never, worker, "group-1", { status: "completed" }),
    ).resolves.toBeUndefined();
    expect(runCreate).not.toHaveBeenCalled();
    expect(tx.externalEffect.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ runId: "run-b", status: "completed" }),
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
    expect(text).toContain("without posting any result");
    expect(text).not.toMatch(/my result is my last message|NO_RESPONSE/);
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
    ["typed in the chat", chatReplyToAsk("我们外联用哪些发件邮箱？"), true, false],
    ["picked on the card", "Selected choice choice-1: 不要求", false, false],
    // Staging 11-10: the sender already acted on the typed answer, then a report back told it to
    // act on it again, and it restated the recruiter's feedback a second time.
    ["typed in the chat and already replied to", chatReplyToAsk("仅本轮不合适"), false, true],
  ])(
    "reminds the sender of a question closed by a message %s",
    async (_, answer, reminds, replied) => {
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
                runId: "run-a",
                seq: 5,
                blocks: [{ kind: "ask", text: question, status: "answered", answer: reply }],
              }
          : { blocks: [asked] }) as never);
      tx.run.findFirst.mockImplementation((async () => ({
        task: { prompt: `新岗位\n\n${question}\nAnswer: ${answer}` },
      })) as never);
      await reportGroupHandoffOutcome(deps as never, worker, "group-1", { status: "completed" });
      const text = (
        messageCreate.mock.calls[0] as unknown as [{ data: { blocks: [{ text: string }] } }]
      )[0].data.blocks[0].text;
      expect(text.includes(`Your question "${question}" was closed when the recruiter typed`)).toBe(
        reminds,
      );
      // Staging 11-10: "继续深搜，保留全部硬性要求" answered the card, yet the old wording made the
      // agent ask the same question again. A typed answer is acted on, never asked again.
      if (reminds) expect(text).toContain("act on that answer and never ask it again");
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

describe("long stage check-in", () => {
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
  const inFlight = vi.mocked(recruitingResearchInFlight);

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

  it("reports a declined turn's stage when its retry finishes", async () => {
    inFlight.mockResolvedValueOnce(false);
    const { deps, messageCreate, stageLookup } = stageHarness(
      undefined,
      "autocontinue:run-b:decline",
    );
    const retry = { ...handedIn, id: "retry-1", sourceMessageId: "retry-message" };
    await expect(
      reportGroupStageOutcome(deps as never, retry, "group-1", { status: "completed" }),
    ).resolves.toEqual({ runId: "run-b" });
    expect(stageLookup).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "run-b" }) }),
    );
    expect(reported(messageCreate)).toEqual(["group-report:run-b"]);
  });

  it("holds the report while the worker's own search is still running", async () => {
    inFlight.mockResolvedValueOnce(true);
    const { deps, messageCreate } = stageHarness();
    await expect(
      reportGroupStageOutcome(deps as never, handedIn, "group-1", { status: "completed" }),
    ).resolves.toBeUndefined();
    expect(inFlight).toHaveBeenLastCalledWith(deps.prisma, "role-1", expect.any(Number), {
      botId: "bot-b",
      threadId: "thread-1",
    });
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("checks in once when the search's first partial results are saved", async () => {
    inFlight.mockResolvedValueOnce(true);
    const { deps, messageCreate, runCreate, stageLookup } = stageHarness();
    await expect(
      reportGroupStageOutcome(deps as never, wake("research-wake:task:rows:20"), "group-1", {
        status: "completed",
      }),
    ).resolves.toEqual({ runId: "run-b" });
    expect(stageLookup).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-b",
          threadId: "thread-1",
          trigger: "follow_up",
          status: "completed",
        }),
      }),
    );
    expect(reported(messageCreate)).toEqual(["group-checkin:run-b"]);
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              toBotId: "bot-a",
              report: "progress",
              text: expect.stringContaining("reply exactly NO_RESPONSE"),
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

  it("never checks in twice, after the stage ended, or for a failed partial save", async () => {
    inFlight.mockResolvedValueOnce(true);
    const again = stageHarness({ sourceRuns: [] });
    await expect(
      reportGroupStageOutcome(again.deps as never, wake("n:rows:40"), "group-1", {
        status: "completed",
      }),
    ).resolves.toBeUndefined();
    expect(again.messageCreate).not.toHaveBeenCalled();

    const finished = stageHarness();
    await expect(
      reportGroupStageOutcome(finished.deps as never, wake("n:rows:40"), "group-1", {
        status: "completed",
      }),
    ).resolves.toBeUndefined();
    await expect(
      reportGroupStageOutcome(finished.deps as never, wake("n:rows:40"), "group-1", {
        status: "failed",
        error: "save failed",
      }),
    ).resolves.toBeUndefined();
    expect(finished.messageCreate).not.toHaveBeenCalled();
  });

  it("reports the stage when the search's final wake ends with nothing left running", async () => {
    const { deps, messageCreate } = stageHarness();
    await expect(
      reportGroupStageOutcome(deps as never, wake("research-wake:task:provider"), "group-1", {
        status: "completed",
      }),
    ).resolves.toEqual({ runId: "run-b" });
    expect(reported(messageCreate)).toEqual(["group-report:run-b"]);
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [expect.objectContaining({ report: "completed", toBotId: "bot-a" })],
        }),
      }),
    );
  });

  it("ignores turns that are neither a handed-in stage nor its search", async () => {
    const { deps, messageCreate } = stageHarness();
    await expect(
      reportGroupStageOutcome(deps as never, { ...handedIn, trigger: "user" }, "group-1", {
        status: "completed",
      }),
    ).resolves.toBeUndefined();
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("tells the delegator when the search stopped being followed unfinished", async () => {
    const { deps, messageCreate } = stageHarness();
    await reportStalledGroupStage(deps as never, stage);
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientNonce: "group-report:run-b",
          blocks: [
            expect.objectContaining({
              report: "failed",
              text: expect.stringContaining("still not finished"),
            }),
          ],
        }),
      }),
    );
  });

  it("lets only the check-in answer end silently", () => {
    const checkIn = [{ ...asked, fromBotId: "bot-b", toBotId: "bot-a", report: "progress" }];
    expect(isQuietStageReport("follow_up", checkIn as never, "bot-a")).toBe(true);
    expect(isQuietStageReport("follow_up", checkIn as never, "bot-b")).toBe(false);
    expect(
      isQuietStageReport("follow_up", [{ ...checkIn[0], report: "completed" }] as never, "bot-a"),
    ).toBe(true);
    expect(
      isQuietStageReport("follow_up", [{ ...checkIn[0], report: "failed" }] as never, "bot-a"),
    ).toBe(false);
    expect(isQuietStageReport("user", checkIn as never, "bot-a")).toBe(false);
  });
});

describe("open stage watch", () => {
  const now = new Date("2026-10-30T12:00:00.000Z");
  const asked = {
    kind: "handoff",
    fromBotId: "bot-a",
    toBotId: "bot-b",
    text: "Find everyone in the group.",
    hop: 1,
    reportBack: true,
  };
  const stage = (status: string, minutes: number, blocks: unknown[] = [asked]) => ({
    id: `run-${status}`,
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-b",
    userId: "user-1",
    status,
    createdAt: new Date(now.getTime() - minutes * 60_000),
    sourceMessageId: "handoff-1",
    sourceMessage: { blocks },
    thread: { groupId: "group-1", activeRecruitingRoleId: "role-1" },
  });

  function watchHarness(
    runs: unknown[],
    options: { reported?: string[]; handedOn?: string[]; busy?: number } = {},
  ) {
    const base = harness([asked]);
    const prisma = base.deps.prisma as unknown as Record<string, unknown>;
    prisma.run = {
      findMany: vi.fn(async () => runs),
      count: vi.fn(async () => options.busy ?? 0),
    };
    prisma.message = {
      findMany: vi.fn(async (args: { where: { runId?: unknown } }) =>
        args.where.runId
          ? (options.handedOn ?? []).map((runId) => ({ runId }))
          : (options.reported ?? []).map((clientNonce) => ({ clientNonce })),
      ),
    };
    prisma.recruitingCandidate = { count: vi.fn(async () => 42) };
    return base;
  }

  it("checks in once per ten minutes with how the stage stands", async () => {
    const { deps, messageCreate } = watchHarness([stage("running", 23)]);
    await expect(watchOpenStages(deps as never, now, 100)).resolves.toBe(1);
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientNonce: "group-checkin:run-running:2",
          blocks: [
            expect.objectContaining({
              toBotId: "bot-a",
              report: "progress",
              text: expect.stringContaining(
                "handed me 23 minutes ago is still running; the role's Results hold 42 people.",
              ),
            }),
          ],
        }),
      }),
    );
  });

  it("offers an email at a long stage's first check-in until the recruiter answers", async () => {
    const offered = (answered: boolean, minutes: number) => {
      const watched = watchHarness([stage("running", minutes)]);
      (watched.deps.prisma as unknown as Record<string, unknown>).externalEffect = {
        findFirst: vi.fn(async () => (answered ? { id: "effect-1" } : null)),
      };
      return watched;
    };
    const first = offered(false, 12);
    await watchOpenStages({ ...first.deps, completionEmail: true } as never, now, 100);
    expect(first.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              text: expect.stringContaining("Want an email when it finishes? Just say so."),
            }),
          ],
        }),
      }),
    );
    for (const watched of [offered(true, 12), offered(false, 23)]) {
      await watchOpenStages({ ...watched.deps, completionEmail: true } as never, now, 100);
      expect(watched.messageCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            blocks: [expect.objectContaining({ text: expect.not.stringContaining("an email") })],
          }),
        }),
      );
    }
    const unconfigured = offered(false, 12);
    await watchOpenStages(unconfigured.deps as never, now, 100);
    expect(unconfigured.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [expect.objectContaining({ text: expect.not.stringContaining("an email") })],
        }),
      }),
    );
  });

  it("follows a finished turn only while its research still runs", async () => {
    const idle = watchHarness([stage("completed", 41)]);
    await expect(watchOpenStages(idle.deps as never, now, 100)).resolves.toBe(0);
    vi.mocked(recruitingResearchInFlight).mockResolvedValueOnce(true as never);
    const { deps, messageCreate } = watchHarness([stage("completed", 41)]);
    await watchOpenStages(deps as never, now, 100);
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: "group-checkin:run-completed:4" }),
      }),
    );
  });

  it("skips reported stages, stages nobody asked back, and a busy coordinator", async () => {
    const reported = watchHarness([stage("completed", 30)], {
      reported: ["group-report:run-completed"],
    });
    await expect(watchOpenStages(reported.deps as never, now, 100)).resolves.toBe(0);
    const unasked = watchHarness([stage("running", 30, [{ ...asked, reportBack: undefined }])]);
    await expect(watchOpenStages(unasked.deps as never, now, 100)).resolves.toBe(0);
    const handedOn = watchHarness([stage("running", 30)], { handedOn: ["run-running"] });
    await expect(watchOpenStages(handedOn.deps as never, now, 100)).resolves.toBe(0);
    const busy = watchHarness([stage("running", 30)], { busy: 1 });
    await expect(watchOpenStages(busy.deps as never, now, 100)).resolves.toBe(0);
    for (const { messageCreate } of [reported, unasked, handedOn, busy])
      expect(messageCreate).not.toHaveBeenCalled();
  });
});
