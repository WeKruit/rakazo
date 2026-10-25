import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  autoContinueMax,
  countTrailingAutoContinues,
  guardRecruitingTurnEnd,
} from "./turn-end-guard.js";

const run = {
  id: "run-1",
  spaceId: "ws-1",
  threadId: "thread-1",
  botId: "bot-1",
  userId: "user-1",
  trigger: "user",
};

function fixture(
  options: {
    priorAutoContinues?: number;
    savedRows?: number;
    savedCandidates?: number;
    stage?: string;
    round?: { effectId: string; candidateKeys: string[]; approvedAt: Date | null };
    completedRoundEffect?: boolean;
    /** The recruiter wrote after the round was recorded. */
    roundAnswered?: boolean;
    /** clientNonce of the newest recruiter or continuation message. */
    latestNonce?: string;
    researchTasks?: { id: string; providerTaskId: string; mcpServerId: string; startedAt: Date }[];
    wokenNonces?: string[];
    acceptedRound?: boolean;
    brief?: unknown;
  } = {},
) {
  const sendUserMessage = vi.fn(async () => ({
    messageId: "m-2",
    seq: 9,
    taskId: "task-2",
    runId: "run-2",
  }));
  const enqueue = vi.fn(async () => undefined);
  const postAssistant = vi.fn(async () => undefined);
  const recent = Array.from({ length: options.priorAutoContinues ?? 0 }, (_, i) => ({
    clientNonce: `autocontinue:run-0:${i + 1}`,
  }));
  recent.push({ clientNonce: "send:human" });
  const deps = {
    prisma: {
      message: {
        findMany: vi.fn(async () => recent),
        findFirst: vi.fn(async () =>
          options.roundAnswered
            ? { id: "feedback", clientNonce: options.latestNonce ?? null }
            : null,
        ),
      },
      recruitingCandidatePage: {
        aggregate: vi.fn(async () => ({ _sum: { rowCount: options.savedRows ?? null } })),
      },
      recruitingCalibrationRound: {
        findFirst: vi.fn(async (args: { where: { approvedAt?: unknown } }) =>
          args.where.approvedAt
            ? options.acceptedRound
              ? { id: "round-0" }
              : null
            : (options.round ?? null),
        ),
      },
      externalEffect: {
        findFirst: vi.fn(async (args: { where: { kind?: string } }) =>
          args.where.kind === "recruiting_research" && options.completedRoundEffect
            ? { id: "effect-1" }
            : null,
        ),
      },
      recruitingResearchTask: {
        findMany: vi.fn(async () =>
          (options.researchTasks ?? []).map(({ startedAt, ...task }) => ({
            ...task,
            createdByRun: { spaceId: "ws-1", createdAt: startedAt },
          })),
        ),
      },
      run: {
        findFirst: vi.fn(async (args: { where: { clientNonce: string } }) =>
          options.wokenNonces?.includes(args.where.clientNonce) ? { id: "wake-1" } : null,
        ),
      },
      recruitingRole: {
        findUnique: vi.fn(async () => ({
          title: "后端工程师",
          playbookStage: options.stage ?? "intake",
          currentRevisionId: "rev-1",
          archivedAt: null,
        })),
      },
      recruitingRoleRevision: { findUnique: vi.fn(async () => ({ brief: options.brief ?? null })) },
      recruitingCandidate: {
        count: vi.fn(async () => options.savedCandidates ?? options.savedRows ?? 0),
      },
    },
    events: { sendUserMessage },
    jobs: { enqueue },
  } as unknown as Parameters<typeof guardRecruitingTurnEnd>[0];
  return { deps, sendUserMessage, enqueue, postAssistant };
}

const statusNote: MessageBlock[] = [
  { kind: "text", text: "已将公司暂用名保存为 X。尚未启动搜寻。" },
];

describe("guardRecruitingTurnEnd", () => {
  it("injects a continuation when the turn ends with no deliverable", async () => {
    const f = fixture();
    const result = await guardRecruitingTurnEnd(f.deps, {
      run,
      roleId: "role-1",
      blocks: statusNote,
      handedOff: false,
      pendingApproval: false,
      postAssistant: f.postAssistant,
      max: 3,
    });
    expect(result).toMatchObject({ action: "continued", runId: "run-2", count: 1 });
    expect(f.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "follow_up",
        internal: true,
        clientNonce: "autocontinue:run-1:1",
        prompt: expect.stringContaining("继续下一步："),
      }),
    );
    expect(f.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(f.postAssistant).not.toHaveBeenCalled();
  });

  it.each([
    [1, 1, "continued"],
    [9, 9, "continued"],
    [1, 10, "continued"],
    [10, 1, "continued"],
  ])(
    "calibration needs ten distinct cumulative candidates (%s writes, %s saved)",
    async (savedRows, savedCandidates, action) => {
      const f = fixture({
        savedRows: Number(savedRows),
        savedCandidates: Number(savedCandidates),
        stage: "calibration_10",
      });
      const result = await guardRecruitingTurnEnd(f.deps, {
        run,
        roleId: "role-1",
        blocks: statusNote,
        handedOff: false,
        pendingApproval: false,
        postAssistant: f.postAssistant,
      });
      expect(result.action).toBe(action);
    },
  );

  it("does not treat feedback-stage saves or a prose question as a delivered review", async () => {
    const f = fixture({ stage: "feedback", savedRows: 1, savedCandidates: 10 });
    const base = {
      run,
      roleId: "role-1",
      handedOff: false,
      pendingApproval: false,
      postAssistant: f.postAssistant,
    };
    expect(await guardRecruitingTurnEnd(f.deps, { ...base, blocks: statusNote })).toMatchObject({
      action: "continued",
      stage: "feedback",
    });
    expect(
      await guardRecruitingTurnEnd(f.deps, {
        ...base,
        blocks: [
          { kind: "text", text: "- Saved ten profiles\n- Updated stage\n- Ready for feedback?" },
        ],
      }),
    ).toMatchObject({ action: "continued" });
    expect(
      await guardRecruitingTurnEnd(f.deps, {
        ...base,
        blocks: [
          {
            kind: "ask",
            text: "What feedback do you have on these ten profiles?",
            status: "pending",
          },
        ],
      }),
    ).toEqual({ action: "ended", classification: "question" });
  });

  it.each([
    [10, false, true, false, "ended"],
    [9, false, true, false, "continued"],
    [10, true, true, false, "continued"],
    [10, false, false, false, "ended"],
    [10, false, false, true, "continued"],
  ])(
    "waits on a complete unapproved round until the recruiter writes (%s, %s, %s, %s)",
    async (count, approved, completed, answered, action) => {
      const f = fixture({
        stage: "feedback",
        round: {
          effectId: "effect-1",
          candidateKeys: Array.from({ length: count }, (_, i) => `person-${i}`),
          approvedAt: approved ? new Date() : null,
        },
        completedRoundEffect: completed,
        roundAnswered: answered,
      });
      const result = await guardRecruitingTurnEnd(f.deps, {
        run,
        roleId: "role-1",
        blocks: statusNote,
        handedOff: false,
        pendingApproval: false,
        postAssistant: f.postAssistant,
      });
      expect(result.action).toBe(action);
      expect(f.deps.prisma.recruitingCalibrationRound.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { roleId: "role-1" }, orderBy: { round: "desc" } }),
      );
      if (count === 10 && !approved && answered)
        expect(f.deps.prisma.externalEffect.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: "effect-1",
              runId: run.id,
              spaceId: run.spaceId,
              kind: "recruiting_research",
              status: "completed",
              request: { path: ["operation"], equals: "calibration_round" },
            },
          }),
        );
    },
  );

  it("pushes a presented round at most once per recruiter message", async () => {
    const f = fixture({
      stage: "feedback",
      round: {
        effectId: "effect-1",
        candidateKeys: Array.from({ length: 10 }, (_, i) => `person-${i}`),
        approvedAt: null,
      },
      roundAnswered: true,
      latestNonce: "autocontinue:run-0:1",
    });
    const result = await guardRecruitingTurnEnd(f.deps, {
      run: { ...run, trigger: "follow_up" },
      roleId: "role-1",
      blocks: statusNote,
      handedOff: false,
      pendingApproval: false,
      postAssistant: f.postAssistant,
    });
    expect(result).toEqual({ action: "ended", classification: "question" });
    expect(f.sendUserMessage).not.toHaveBeenCalled();
  });

  it("lets a question end the turn", async () => {
    const f = fixture();
    const result = await guardRecruitingTurnEnd(f.deps, {
      run,
      roleId: "role-1",
      blocks: [{ kind: "text", text: "可以告诉我薪资范围吗？" }],
      handedOff: false,
      pendingApproval: false,
      postAssistant: f.postAssistant,
      max: 3,
    });
    expect(result).toEqual({ action: "ended", classification: "question" });
    expect(f.sendUserMessage).not.toHaveBeenCalled();
  });

  it("treats a save receipt of enough rows as a deliverable", async () => {
    const f = fixture({ savedRows: 5, savedCandidates: 5 });
    const result = await guardRecruitingTurnEnd(f.deps, {
      run,
      roleId: "role-1",
      blocks: statusNote,
      handedOff: false,
      pendingApproval: false,
      postAssistant: f.postAssistant,
    });
    expect(result).toEqual({ action: "ended", classification: "deliverable" });
  });

  it("posts a final message once the cap is reached", async () => {
    const f = fixture({ priorAutoContinues: 3 });
    const result = await guardRecruitingTurnEnd(f.deps, {
      run,
      roleId: "role-1",
      blocks: statusNote,
      handedOff: false,
      pendingApproval: false,
      postAssistant: f.postAssistant,
      max: 3,
    });
    expect(result).toMatchObject({ action: "capped", count: 3 });
    expect(f.sendUserMessage).not.toHaveBeenCalled();
    expect(f.postAssistant).toHaveBeenCalledWith(expect.stringContaining("完成岗位信息"));
  });

  it("says what was saved when the cap is reached after results were saved", async () => {
    const f = fixture({ priorAutoContinues: 3, savedCandidates: 4, stage: "calibration_10" });
    const result = await guardRecruitingTurnEnd(f.deps, {
      run,
      roleId: "role-1",
      blocks: statusNote,
      handedOff: false,
      pendingApproval: false,
      postAssistant: f.postAssistant,
      max: 3,
    });
    expect(result).toMatchObject({ action: "capped" });
    expect(f.postAssistant).toHaveBeenCalledWith(expect.stringContaining("已保存 4 位候选人"));
    expect(f.postAssistant).not.toHaveBeenCalledWith(expect.stringContaining("没有产出"));
  });

  it("is disabled by RAKAZO_AUTOCONTINUE_MAX=0 and skips non-human triggers", async () => {
    expect(autoContinueMax({ RAKAZO_AUTOCONTINUE_MAX: "0" })).toBe(0);
    expect(autoContinueMax({})).toBe(3);
    expect(autoContinueMax({ RAKAZO_AUTOCONTINUE_MAX: "nope" })).toBe(3);
    const f = fixture();
    await expect(
      guardRecruitingTurnEnd(f.deps, {
        run: { ...run, trigger: "routine" },
        roleId: "role-1",
        blocks: statusNote,
        handedOff: false,
        pendingApproval: false,
        postAssistant: f.postAssistant,
      }),
    ).resolves.toEqual({ action: "ended", classification: "none" });
    expect(
      countTrailingAutoContinues([{ clientNonce: "autocontinue:a:1" }, { clientNonce: null }]),
    ).toBe(1);
  });

  it("guards the research wake and a coordinator woken by a specialist reply", async () => {
    for (const trigger of ["recruiting_research", "bot_message"]) {
      const f = fixture();
      const result = await guardRecruitingTurnEnd(f.deps, {
        run: { ...run, trigger },
        roleId: "role-1",
        blocks: statusNote,
        handedOff: false,
        pendingApproval: false,
        postAssistant: f.postAssistant,
      });
      expect(result.action).toBe("continued");
    }
  });

  it("leaves a delegated specialist turn to the bot that asked for it", async () => {
    const f = fixture();
    const result = await guardRecruitingTurnEnd(f.deps, {
      run: { ...run, trigger: "bot_message" },
      roleId: "role-1",
      blocks: statusNote,
      handedOff: false,
      pendingApproval: false,
      returnsToRequester: true,
      postAssistant: f.postAssistant,
    });
    expect(result).toEqual({ action: "ended", classification: "none" });
    expect(f.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not push while a search round is still running", async () => {
    const task = {
      id: "task-1",
      providerTaskId: "p-1",
      mcpServerId: "mcp-1",
      startedAt: new Date(),
    };
    const waiting = fixture({ researchTasks: [task] });
    await expect(
      guardRecruitingTurnEnd(waiting.deps, {
        run,
        roleId: "role-1",
        blocks: statusNote,
        handedOff: false,
        pendingApproval: false,
        postAssistant: waiting.postAssistant,
      }),
    ).resolves.toEqual({ action: "ended", classification: "none" });
    expect(waiting.sendUserMessage).not.toHaveBeenCalled();

    // Once the round has woken the thread, or it is older than the poll window, the guard pushes.
    for (const options of [
      { researchTasks: [task], wokenNonces: ["recruiting-research-wake:task-1:p-1"] },
      { researchTasks: [{ ...task, startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }] },
    ]) {
      const f = fixture(options);
      const result = await guardRecruitingTurnEnd(f.deps, {
        run,
        roleId: "role-1",
        blocks: statusNote,
        handedOff: false,
        pendingApproval: false,
        postAssistant: f.postAssistant,
      });
      expect(result.action).toBe("continued");
    }
  });

  it("never sends a role that already has saved people back to a fresh search", async () => {
    // Roles created before the stage column existed still read "intake".
    const f = fixture({ stage: "intake", savedCandidates: 49 });
    const result = await guardRecruitingTurnEnd(f.deps, {
      run,
      roleId: "role-1",
      blocks: statusNote,
      handedOff: false,
      pendingApproval: false,
      postAssistant: f.postAssistant,
    });
    expect(result).toMatchObject({ action: "continued", stage: "feedback", label: "收集校准反馈" });

    const accepted = fixture({ stage: "intake", savedCandidates: 49, acceptedRound: true });
    await expect(
      guardRecruitingTurnEnd(accepted.deps, {
        run,
        roleId: "role-1",
        blocks: statusNote,
        handedOff: false,
        pendingApproval: false,
        postAssistant: accepted.postAssistant,
      }),
    ).resolves.toMatchObject({ stage: "scale" });
  });
});
