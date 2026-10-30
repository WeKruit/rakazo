import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
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
      create: runCreate,
    },
    chatGroupMember: { findFirst: vi.fn(async () => ({ botId: "bot-a" })) },
    message: {
      findFirst: vi.fn(async () => ({ blocks: sourceBlocks })),
      findUnique: vi.fn(async () => existing ?? null),
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
              text: expect.stringContaining("Want an email when this finishes?"),
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
