import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  answeredAsk,
  autoContinueMax,
  countTrailingAutoContinues,
  guardRecruitingRoleCreate,
  guardRecruitingTurnEnd,
  intakeAnswers,
  recruitingRoundListText,
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
      recruitingCandidateOccurrence: {
        findMany: vi.fn(async () =>
          (options.round?.candidateKeys ?? []).map((candidateKey, index) => ({
            candidateKey,
            name: `Person ${index}`,
            title: "Warehouse Manager",
            company: "Example Co",
            location: "Atlanta",
          })),
        ),
      },
    },
    events: { sendUserMessage },
    jobs: { enqueue },
  } as unknown as Parameters<typeof guardRecruitingTurnEnd>[0];
  return { deps, sendUserMessage, enqueue, postAssistant };
}

/** A recorded round of ten the recruiter has answered. */
const shownRound = {
  effectId: "effect-1",
  candidateKeys: Array.from({ length: 10 }, (_, i) => `person-${i}`),
  approvedAt: null,
};
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
    const f = fixture({
      stage: "feedback",
      savedRows: 1,
      savedCandidates: 10,
      round: shownRound,
      roundAnswered: true,
    });
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

  it("lists the ten with the profile passage each saved search returned", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `person-${i}`);
    const searches = vi.fn(async () => [
      {
        result: {
          candidateRows: [
            { candidateKey: "person-0", name: "Person 0", snippet: "Built warehouse ops" },
          ],
        },
      },
    ]);
    const text = await recruitingRoundListText(
      {
        externalEffect: { findMany: searches },
        recruitingCandidateOccurrence: {
          findMany: vi.fn(async () =>
            keys.map((candidateKey, i) => ({
              candidateKey,
              name: `Person ${i}`,
              title: "Warehouse Manager",
              company: "Example Co",
              location: "Atlanta",
            })),
          ),
        },
      } as never,
      { threadId: "thread-1", spaceId: "space-1", roleId: "role-1", candidateKeys: keys },
    );
    expect(searches).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ run: { threadId: "thread-1" } }),
      }),
    );
    expect(text).toContain(
      "1. **Person 0** · Warehouse Manager · Example Co · Atlanta\n   > Built warehouse ops",
    );
    expect(text).toContain("10. **Person 9** · Warehouse Manager · Example Co · Atlanta");
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
    const f = fixture({
      stage: "intake",
      savedCandidates: 49,
      round: shownRound,
      roundAnswered: true,
    });
    const result = await guardRecruitingTurnEnd(f.deps, {
      run,
      roleId: "role-1",
      blocks: statusNote,
      handedOff: false,
      pendingApproval: false,
      postAssistant: f.postAssistant,
    });
    expect(result).toMatchObject({ action: "continued", stage: "feedback", label: "收集校准反馈" });
  });

  it("presents the first ten from saved people before asking for feedback", async () => {
    // Saves used to move a role to feedback before any round was shown.
    for (const stage of ["intake", "feedback"]) {
      const f = fixture({ stage, savedRows: 62, savedCandidates: 62 });
      const result = await guardRecruitingTurnEnd(f.deps, {
        run,
        roleId: "role-1",
        blocks: statusNote,
        handedOff: false,
        pendingApproval: false,
        postAssistant: f.postAssistant,
      });
      expect(result).toMatchObject({
        action: "continued",
        stage: "calibration_10",
        label: "展示 10 人校准名单",
      });
    }
  });

  it("scales a role whose round was accepted", async () => {
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

describe("guardRecruitingRoleCreate", () => {
  function roleFixture(result: unknown, priorAutoContinues = 0) {
    const sendUserMessage = vi.fn(async () => ({ messageId: "m-2", seq: 9, runId: "run-2" }));
    const enqueue = vi.fn(async () => undefined);
    const recent = Array.from({ length: priorAutoContinues }, (_, i) => ({
      clientNonce: `autocontinue:run-0:${i + 1}`,
    }));
    recent.push({ clientNonce: "send:human" });
    const deps = {
      prisma: {
        message: { findMany: vi.fn(async () => recent) },
        externalEffect: { findFirst: vi.fn(async () => (result ? { result } : null)) },
      },
      events: { sendUserMessage },
      jobs: { enqueue },
    } as unknown as Parameters<typeof guardRecruitingRoleCreate>[0];
    return { deps, sendUserMessage, enqueue };
  }
  // The 2026-10-26 03:39 link role: the create was refused and Main ended on an apology.
  const apology: MessageBlock[] = [
    { kind: "text", text: "岗位保存功能仍不可用，因此这份岗位尚未建立，也还不能开始找人。" },
  ];
  const input = { run, blocks: apology, handedOff: false, pendingApproval: false };

  it("pushes one retry when a refused create left the conversation without a role", async () => {
    const f = roleFixture({ error: 'Source "jd": locator must be "text" for a file.' });
    const result = await guardRecruitingRoleCreate(f.deps, input);
    expect(result).toMatchObject({ action: "continued", runId: "run-2" });
    expect(f.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        internal: true,
        clientNonce: "autocontinue:run-1:1",
        prompt: expect.stringContaining("recruiting_role create"),
      }),
    );
    expect(f.enqueue).toHaveBeenCalledOnce();
  });

  it("does not push after a saved create, a question, or a push it already made", async () => {
    const refused = { error: "refused" };
    expect(await guardRecruitingRoleCreate(roleFixture(null).deps, input)).toMatchObject({
      action: "ended",
    });
    expect(
      await guardRecruitingRoleCreate(roleFixture({ status: "saved" }).deps, input),
    ).toMatchObject({ action: "ended" });
    const asked = { ...input, blocks: [{ kind: "ask", text: "地点？", status: "pending" }] };
    expect(
      await guardRecruitingRoleCreate(roleFixture(refused).deps, asked as typeof input),
    ).toMatchObject({ action: "ended", classification: "question" });
    const again = roleFixture(refused, 1);
    expect(await guardRecruitingRoleCreate(again.deps, input)).toMatchObject({ action: "ended" });
    expect(again.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("intakeAnswers", () => {
  const ask = (text: string) => ({ role: "bot", blocks: [{ kind: "ask", text }] });
  const say = (role: string, text: string) => ({ role, blocks: [{ kind: "text", text }] });

  it("pairs each question card with the recruiter's answer and skips the JD itself", () => {
    expect(
      intakeAnswers([
        say("user", "Research Scientist, Simulation — full JD"),
        ask("语言要求？"),
        say("user", "英语必需"),
        say("bot", "本轮 10 位人选"),
        say("user", "找 100 个"),
        ask("地点？"),
        say("user", "Redwood City 现场"),
        ask("语言要求？"),
        say("user", " 英语必需，中文不要求 "),
      ]),
    ).toEqual([
      { key: "地点？", value: "Redwood City 现场" },
      { key: "语言要求？", value: "英语必需，中文不要求" },
    ]);
  });
});

describe("answeredAsk", () => {
  const answers = [
    {
      key: "这个岗位的语言要求如何设定？建议以英语为必需。",
      value: "英语工作沟通必需，中文不要求",
    },
    { key: "Where must candidates be based?", value: "Redwood City, on site" },
  ];

  it("finds a question asked again with or without its suggestion", () => {
    expect(answeredAsk("这个岗位的语言要求如何设定？", answers)?.value).toBe(
      "英语工作沟通必需，中文不要求",
    );
    expect(answeredAsk("where must candidates be based? Options below.", answers)?.value).toBe(
      "Redwood City, on site",
    );
  });

  it("leaves a different question alone", () => {
    expect(answeredAsk("这个岗位的地点要求如何设定？", answers)).toBeUndefined();
    expect(answeredAsk("这个岗位的语言要求怎么定？", answers)).toBeUndefined();
    expect(answeredAsk("Why?", answers)).toBeUndefined();
  });
});
