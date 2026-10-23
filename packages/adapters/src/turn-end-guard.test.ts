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

function fixture(options: { priorAutoContinues?: number; savedRows?: number } = {}) {
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
      message: { findMany: vi.fn(async () => recent) },
      recruitingCandidatePage: {
        aggregate: vi.fn(async () => ({ _sum: { rowCount: options.savedRows ?? null } })),
      },
      recruitingRole: {
        findUnique: vi.fn(async () => ({
          title: "后端工程师",
          playbookStage: "intake",
          currentRevisionId: "rev-1",
          archivedAt: null,
        })),
      },
      recruitingRoleRevision: { findUnique: vi.fn(async () => ({ brief: null })) },
      recruitingCandidate: { count: vi.fn(async () => 0) },
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
        clientNonce: "autocontinue:run-1:1",
        prompt: expect.stringContaining("继续下一步："),
      }),
    );
    expect(f.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(f.postAssistant).not.toHaveBeenCalled();
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
    const f = fixture({ savedRows: 10 });
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
});
