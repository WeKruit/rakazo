import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import * as recruiting from "./recruiting.js";
import { IsolationError } from "./scope.js";

const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

function fixture(count = 4, answered = false) {
  const queries: string[] = [];
  const thread = {
    id: "thread",
    ...actor,
    botId: null as string | null,
    groupId: "group" as string | null,
    externalConversationId: null as string | null,
    activeRecruitingRoleId: "role",
  };
  const role = {
    id: "role",
    spaceId: actor.spaceId,
    userId: actor.userId,
    sourceThreadId: thread.id,
    title: "Engineer",
    revision: 1,
    currentRevisionId: "revision",
  };
  const revision = {
    id: "revision",
    roleId: role.id,
    revision: 1,
    sourceRefs: [
      {
        id: "source",
        kind: "original_material",
        anchor: { kind: "message", messageId: "source-message", locator: "blocks[0].text" },
        readState: "read",
        readAt: "2026-10-16T00:00:00Z",
      },
    ],
    criteria: [],
    preferences: [],
    definitionQuestions: [],
    brief: null,
    createdAt: new Date(0),
  };
  const runs = Array.from({ length: count }, (_, index) => ({
    id: `run-${index}`,
    ...actor,
    threadId: thread.id,
    botId: "bot",
    bot: actor,
    status: answered ? "completed" : "waiting_input",
    sourceMessageId: null,
  }));
  const requests = runs.map(() => ({
    operation: "ask",
    roleId: role.id,
    roleRevisionId: revision.id,
    target: { kind: "role", criterionIds: [] },
    question: "Which source?",
    options: ["Original", "Other"],
  }));
  const receipts = runs.map((_, index) => ({
    roleId: role.id,
    roleRevisionId: revision.id,
    target: requests[index]!.target,
    effectId: `effect-${index}`,
    messageId: `card-${index}`,
    askIndex: 0,
  }));
  const effects = runs.map((run, index) => ({
    id: receipts[index]!.effectId,
    spaceId: actor.spaceId,
    runId: run.id,
    kind: "recruiting_assess",
    status: "completed",
    request: requests[index],
    result: structuredClone(receipts[index]),
  }));
  const blocks = [
    {
      kind: "ask",
      text: "Which source?",
      status: "pending",
      actions: [
        { id: "original", label: "Original" },
        { id: "other", label: "Other" },
      ],
    },
  ];
  const cards = runs.map((run, index) => ({
    id: receipts[index]!.messageId,
    threadId: thread.id,
    runId: run.id,
    botId: run.botId,
    role: "bot",
    clientNonce: `recruiting-question:${effects[index]!.id}`,
    seq: index * 2 + 1,
    externalTranscriptFor: null,
    blocks: answered
      ? [{ ...blocks[0], status: "answered", answer: "original" }]
      : structuredClone(blocks),
  }));
  const answers = runs.map((_, index) => ({
    id: `answer-${index}`,
    threadId: thread.id,
    runId: "shared-primary-run",
    botId: null,
    role: "user",
    clientNonce: null,
    seq: index * 2 + 2,
    externalTranscriptFor: null as object | null,
    blocks: [{ kind: "text", text: " original " }],
  }));
  const event = (runIndex: number, type: string, payload: unknown, offset: number) => ({
    id: `${type}-${runIndex}`,
    spaceId: actor.spaceId,
    threadId: thread.id,
    botId: "bot",
    runId: runs[runIndex]!.id,
    seq: runIndex * 10 + offset,
    type,
    payload,
    createdAt: new Date(0),
  });
  const asked = receipts.map((receipt, index) =>
    event(index, "recruiting.question.asked", receipt, 2),
  );
  const created = cards.map((card, index) =>
    event(
      index,
      "thread.message.created",
      { messageId: card.id, blocks: structuredClone(blocks) },
      1,
    ),
  );
  const choices = answered
    ? cards.map((card, index) =>
        event(
          index,
          "thread.choice",
          {
            messageId: card.id,
            askIndex: 0,
            answerMessageId: answers[index]!.id,
            answeredByUserId: actor.userId,
          },
          4,
        ),
      )
    : [];
  const events = [
    ...asked,
    ...created,
    ...choices,
    ...(answered ? runs.map((_, index) => event(index, "run.waiting_input", {}, 3)) : []),
  ].sort((a, b) => a.seq - b.seq);
  function matches(row: Record<string, any>, where: Record<string, any> = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true;
      if (key === "AND") return value.every((clause: Record<string, any>) => matches(row, clause));
      if (key === "OR") return value.some((clause: Record<string, any>) => matches(row, clause));
      if (key === "payload")
        return (
          value.path.reduce((current: any, part: string) => current?.[part], row.payload) ===
          value.equals
        );
      if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
      return row[key] === value;
    });
  }
  function model(name: string, rows: Record<string, any>[]) {
    const findMany = vi.fn(async ({ where = {} }: { where?: Record<string, any> } = {}) => {
      queries.push(`${name}.findMany`);
      return rows.filter((row) => matches(row, where));
    });
    const findFirst = vi.fn(async ({ where = {} }: { where?: Record<string, any> } = {}) => {
      queries.push(`${name}.findFirst`);
      return rows.find((row) => matches(row, where)) ?? null;
    });
    const findUniqueOrThrow = vi.fn(
      async ({ where = {} }: { where?: Record<string, any> } = {}) => {
        queries.push(`${name}.findUniqueOrThrow`);
        const row = rows.find((row) => matches(row, where));
        if (!row) throw new IsolationError();
        return row;
      },
    );
    return { findMany, findFirst, findUniqueOrThrow, findFirstOrThrow: findUniqueOrThrow };
  }
  const members = [{ groupId: "group", botId: "bot" }];
  const conversations = [{ id: "external", ...actor, botId: "bot", bot: actor }];
  const assessments: Record<string, any>[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: thread.id }]),
    thread: model("thread", [thread]),
    chatGroup: model("group", [{ id: "group", ...actor }]),
    chatGroupMember: model("member", members),
    bot: model("bot", [{ id: "bot", ...actor }]),
    externalConversation: model("conversation", conversations),
    run: model("run", runs),
    recruitingRole: model("role", [role]),
    recruitingRoleRevision: model("revision", [revision]),
    recruitingAssessment: model("assessment", assessments),
    externalEffect: model("effect", effects),
    message: model("message", [
      ...cards,
      ...answers,
      {
        id: "source-message",
        threadId: thread.id,
        role: "user",
        botId: null,
        externalTranscriptFor: null,
        blocks: [{ kind: "text", text: "Original role" }],
      },
    ]),
    event: model("event", events),
    steeringMessage: model("steering", []),
  };
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  const input = { threadId: thread.id, roleId: role.id };
  const lookup = { ...input, effectId: effects[0]!.id };
  return {
    prisma,
    tx,
    queries,
    thread,
    role,
    revision,
    runs,
    requests,
    receipts,
    effects,
    cards,
    answers,
    asked,
    created,
    choices,
    events,
    members,
    conversations,
    assessments,
    input,
    lookup,
  };
}

function candidateTarget(f: ReturnType<typeof fixture>, index: number, candidateKey: string) {
  const target = { kind: "candidate", candidateKey, assessmentVersion: 1, criterionIds: [] };
  f.requests[index]!.target = target as never;
  f.receipts[index]!.target = target as never;
  f.effects[index]!.result = structuredClone(f.receipts[index]!);
}

describe("native recruiting question proof reads (mocked DB)", () => {
  it.each([4, 80])(
    "uses bounded proof queries for %i pending questions across distinct runs",
    async (count) => {
      const f = fixture(count);
      const result = await recruiting.listRecruitingQuestions(f.prisma, actor, f.input);
      expect(result).toHaveLength(count);
      expect(result.every((question) => question.isCurrent && question.canAnswer)).toBe(true);
      expect(f.queries.length).toBeLessThanOrEqual(18);
      expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "RepeatableRead",
      });
    },
  );

  it("reuses one current assessment proof for repeated candidate targets and retains assessment staleness", async () => {
    const f = fixture(80, true);
    f.assessments.push({
      roleId: f.role.id,
      candidateKey: "candidate",
      roleRevisionId: f.revision.id,
      version: 1,
      basedOnVersion: null,
      facts: [],
      sourceRefs: [],
      questions: [],
      judgments: { atoms: [], employment: [], criteria: [], hardGate: "unknown" },
      createdByRunId: f.runs[0]!.id,
      createdAt: new Date(0),
    });
    for (let index = 0; index < f.requests.length; index++) candidateTarget(f, index, "candidate");
    const questions = await recruiting.listRecruitingQuestions(f.prisma, actor, f.input);
    expect(questions).toHaveLength(80);
    expect(questions.every((question) => question.isCurrent && !question.canAnswer)).toBe(true);
    expect(f.tx.recruitingAssessment.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { roleId: f.role.id, candidateKey: { in: ["candidate"] } },
      distinct: ["candidateKey"],
      orderBy: [{ candidateKey: "asc" }, { version: "desc" }],
    });
    expect(f.tx.run.findFirst).toHaveBeenCalledOnce();
    expect(f.queries.length).toBeLessThanOrEqual(24);
    f.assessments[0]!.version = 2;
    expect(
      (await recruiting.listRecruitingQuestions(f.prisma, actor, f.input)).every(
        (question) => !question.isCurrent && !question.canAnswer,
      ),
    ).toBe(true);
    f.assessments[0]!.version = 1;
    f.assessments[0]!.createdByRunId = "foreign-run";
    await expect(recruiting.listRecruitingQuestions(f.prisma, actor, f.input)).rejects.toThrow(
      IsolationError,
    );
  });

  it("keeps role questions while excluding unrelated candidate proofs before batched reads", async () => {
    const f = fixture(3);
    candidateTarget(f, 1, "candidate-a");
    candidateTarget(f, 2, "candidate-b");
    f.effects[2]!.status = "executing";
    expect(
      (
        await recruiting.listRecruitingQuestions(f.prisma, actor, {
          ...f.input,
          candidateKey: "candidate-a",
        })
      ).map((question) => question.effectId),
    ).toEqual(["effect-0", "effect-1"]);
    expect(f.tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["run-0", "run-1"] }, spaceId: actor.spaceId, userId: actor.userId },
      }),
    );
  });

  it("shares the current revision and source authorization across distinct assessment targets", async () => {
    const f = fixture(80, true);
    for (let index = 0; index < 80; index++) {
      const candidateKey = `candidate-${index}`;
      candidateTarget(f, index, candidateKey);
      f.assessments.push({
        roleId: f.role.id,
        candidateKey,
        roleRevisionId: f.revision.id,
        version: 1,
        basedOnVersion: null,
        facts: [],
        sourceRefs: [],
        questions: [],
        judgments: { atoms: [], employment: [], criteria: [], hardGate: "unknown" },
        createdByRunId: f.runs[0]!.id,
        createdAt: new Date(0),
      });
    }
    expect(
      (await recruiting.listRecruitingQuestions(f.prisma, actor, f.input)).every(
        (question) => question.isCurrent,
      ),
    ).toBe(true);
    expect(f.tx.recruitingRoleRevision.findFirst).toHaveBeenCalledOnce();
    expect(f.tx.recruitingAssessment.findMany).toHaveBeenCalledOnce();
    expect(f.tx.run.findFirst).toHaveBeenCalledOnce();
    expect(f.queries.length).toBeLessThanOrEqual(24);
  });

  it.each(["created", "choice"])(
    "does not mix another bot's %s proof across a batched run set",
    async (boundary) => {
      const f = fixture(2, true);
      for (let index = 0; index < 2; index++) {
        const botId = `bot-${index}`;
        f.runs[index]!.botId = botId;
        f.cards[index]!.botId = botId;
        for (const event of f.events.filter((event) => event.runId === f.runs[index]!.id))
          event.botId = botId;
      }
      (boundary === "created" ? f.created : f.choices)[0]!.botId = "bot-1";
      await expect(recruiting.listRecruitingQuestions(f.prisma, actor, f.input)).rejects.toThrow(
        IsolationError,
      );
    },
  );

  it.each([4, 80])(
    "uses the same bounded reads and exact human answer proofs for %i answered questions",
    async (count) => {
      const f = fixture(count, true);
      const result = await recruiting.listRecruitingQuestions(f.prisma, actor, f.input);
      expect(result).toHaveLength(count);
      expect(
        result.every(
          (question) =>
            question.isCurrent && !question.canAnswer && question.block.status === "answered",
        ),
      ).toBe(true);
      expect(f.queries.length).toBeLessThanOrEqual(18);
    },
  );

  it("returns the same single question through get and list and keeps removed group bots readable", async () => {
    const f = fixture(1);
    const original = await recruiting.getRecruitingQuestion(f.prisma, actor, f.lookup);
    expect(await recruiting.listRecruitingQuestions(f.prisma, actor, f.input)).toEqual([original]);
    f.members.length = 0;
    expect(await recruiting.getRecruitingQuestion(f.prisma, actor, f.lookup)).toMatchObject({
      isCurrent: true,
      canAnswer: false,
      block: original!.block,
    });
    f.role.currentRevisionId = "later-revision";
    expect(await recruiting.getRecruitingQuestion(f.prisma, actor, f.lookup)).toMatchObject({
      isCurrent: false,
      canAnswer: false,
    });
  });

  it("retains external-conversation bot targeting without hiding the original card", async () => {
    const f = fixture(1);
    f.thread.groupId = null;
    f.thread.externalConversationId = "external";
    expect(await recruiting.getRecruitingQuestion(f.prisma, actor, f.lookup)).toMatchObject({
      isCurrent: true,
      canAnswer: true,
      groupId: null,
    });
    f.conversations[0]!.botId = "another-bot";
    expect(await recruiting.getRecruitingQuestion(f.prisma, actor, f.lookup)).toMatchObject({
      isCurrent: true,
      canAnswer: false,
      groupId: null,
    });
  });

  it.each([false, true])(
    "preserves malformed unrelated native-choice handling for answered=%s",
    async (answered) => {
      const f = fixture(1, answered);
      f.events.push({ ...f.asked[0]!, type: "thread.choice", seq: 99, payload: null });
      const loaded = recruiting.getRecruitingQuestion(f.prisma, actor, f.lookup);
      if (answered) await expect(loaded).rejects.toThrow(IsolationError);
      else await expect(loaded).resolves.toMatchObject({ isCurrent: true, canAnswer: true });
    },
  );

  it.each([
    "actor",
    "run-owner",
    "run-bot-owner",
    "run-thread",
    "event-bot",
    "effect-kind",
    "effect-status",
    "effect-result",
    "request-role",
    "request-revision",
    "request-target",
    "card-run",
    "card-bot",
    "card-role",
    "card-nonce",
    "card-display",
    "created-missing",
    "created-answered",
    "pending-choice",
  ])("rejects a mismatched %s proof through both get and list", async (boundary) => {
    const f = fixture(1);
    let reader = actor;
    if (boundary === "actor") reader = { ...actor, userId: "foreign" };
    if (boundary === "run-owner") f.runs[0]!.userId = "foreign";
    if (boundary === "run-bot-owner") f.runs[0]!.bot = { ...actor, userId: "foreign" };
    if (boundary === "run-thread") f.runs[0]!.threadId = "foreign-thread";
    if (boundary === "event-bot") f.asked[0]!.botId = "foreign-bot";
    if (boundary === "effect-kind") f.effects[0]!.kind = "other";
    if (boundary === "effect-status") f.effects[0]!.status = "executing";
    if (boundary === "effect-result")
      f.effects[0]!.result = { ...f.receipts[0]!, messageId: "other" };
    if (boundary === "request-role") f.requests[0]!.roleId = "other-role";
    if (boundary === "request-revision") f.requests[0]!.roleRevisionId = "other-revision";
    if (boundary === "request-target")
      f.requests[0]!.target = { kind: "role", criterionIds: ["other"] } as never;
    if (boundary === "card-run") f.cards[0]!.runId = "foreign-run";
    if (boundary === "card-bot") f.cards[0]!.botId = "foreign-bot";
    if (boundary === "card-role") f.cards[0]!.role = "user";
    if (boundary === "card-nonce") f.cards[0]!.clientNonce = "other";
    if (boundary === "card-display") f.cards[0]!.blocks[0]!.text = "Changed card";
    if (boundary === "created-missing") f.events.splice(f.events.indexOf(f.created[0]!), 1);
    if (boundary === "created-answered")
      Object.assign((f.created[0]!.payload as { blocks: object[] }).blocks[0]!, {
        status: "answered",
        answer: "original",
      });
    if (boundary === "pending-choice")
      f.events.push({
        ...f.asked[0]!,
        type: "thread.choice",
        payload: {
          messageId: f.cards[0]!.id,
          askIndex: 0,
          answerMessageId: f.answers[0]!.id,
          answeredByUserId: actor.userId,
        },
      });
    await expect(recruiting.getRecruitingQuestion(f.prisma, reader, f.lookup)).rejects.toThrow(
      IsolationError,
    );
    await expect(recruiting.listRecruitingQuestions(f.prisma, reader, f.input)).rejects.toThrow(
      IsolationError,
    );
  });

  it.each([
    "answer-owner",
    "answer-transcript",
    "answer-body",
    "answer-order",
    "answer-missing",
    "choice-missing",
  ])("rejects an invalid answered %s proof in a batch", async (boundary) => {
    const f = fixture(4, true);
    if (boundary === "answer-owner")
      (f.choices[3]!.payload as { answeredByUserId: string }).answeredByUserId = "foreign";
    if (boundary === "answer-transcript") f.answers[3]!.externalTranscriptFor = {};
    if (boundary === "answer-body") f.answers[3]!.blocks[0]!.text = "different";
    if (boundary === "answer-order") f.answers[3]!.seq = 0;
    if (boundary === "answer-missing") f.answers[3]!.id = "removed-answer";
    if (boundary === "choice-missing") f.events.splice(f.events.indexOf(f.choices[3]!), 1);
    await expect(recruiting.listRecruitingQuestions(f.prisma, actor, f.input)).rejects.toThrow(
      IsolationError,
    );
  });

  it("preserves the shared reader in completed-question recovery and native answer authorization", async () => {
    const f = fixture(1);
    expect(
      await recruiting.prepareRecruitingQuestionInTransaction(
        f.tx as never,
        {
          spaceId: actor.spaceId,
          runId: f.runs[0]!.id,
          threadId: f.thread.id,
          botId: "bot",
          recruitingQuestion: {
            actor,
            effectId: f.effects[0]!.id,
            effectRequest: f.requests[0]!,
            artifacts: [],
          },
        } as never,
      ),
    ).toEqual({ kind: "completed", eventSeq: f.asked[0]!.seq });
    expect(
      await recruiting.authorizeRecruitingQuestionAnswerInTransaction(
        f.tx as never,
        {
          spaceId: actor.spaceId,
          runId: f.runs[0]!.id,
          threadId: f.thread.id,
          messageId: f.cards[0]!.id,
          answeredByUserId: actor.userId,
        } as never,
        f.cards[0]!,
        0,
      ),
    ).toBe(true);
  });
});
