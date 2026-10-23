import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { classifyTurnEnd, type TurnEndClass } from "@rakazo/core";
import { type PrismaClient, readRecruitingPlaybookStep } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";

export const AUTOCONTINUE_NONCE_PREFIX = "autocontinue:";

/** RAKAZO_AUTOCONTINUE_MAX: auto-continues per human turn; 0 disables. Default 3. */
export function autoContinueMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RAKAZO_AUTOCONTINUE_MAX ?? 3);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3;
}

/** Continuations since the last human message: trailing user messages carrying the nonce prefix. */
export function countTrailingAutoContinues(
  messages: readonly { clientNonce: string | null }[],
): number {
  let count = 0;
  for (const message of messages) {
    if (!message.clientNonce?.startsWith(AUTOCONTINUE_NONCE_PREFIX)) break;
    count += 1;
  }
  return count;
}

export type TurnEndGuardDeps = {
  prisma: Pick<PrismaClient, "message" | "recruitingCandidatePage"> & {
    recruitingRole: PrismaClient["recruitingRole"];
    recruitingRoleRevision: PrismaClient["recruitingRoleRevision"];
    recruitingCandidate: PrismaClient["recruitingCandidate"];
  };
  events: Pick<ExecutorDeps["events"], "sendUserMessage">;
  jobs: Pick<ExecutorDeps["jobs"], "enqueue">;
};

export type TurnEndGuardInput = {
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    trigger: string;
  };
  roleId: string;
  blocks: readonly MessageBlock[];
  handedOff: boolean;
  pendingApproval: boolean;
  /** Posts a final assistant message when the cap is reached. */
  postAssistant: (text: string) => Promise<unknown>;
  max?: number;
};

export type TurnEndGuardResult =
  | { action: "ended"; classification: TurnEndClass }
  | { action: "continued"; runId: string | null; stage: string; label: string; count: number }
  | { action: "capped"; stage: string; label: string; count: number };

/**
 * Turn-end guard for threads with an active recruiting role: a turn that ends with neither a
 * deliverable, a question, a card nor a handoff is pushed into the next playbook step instead
 * of stopping at "saved, not started yet".
 */
export async function guardRecruitingTurnEnd(
  deps: TurnEndGuardDeps,
  input: TurnEndGuardInput,
): Promise<TurnEndGuardResult> {
  const max = input.max ?? autoContinueMax();
  const { run } = input;
  if (max === 0 || !["user", "follow_up"].includes(run.trigger))
    return { action: "ended", classification: "none" };
  const savedRows = await deps.prisma.recruitingCandidatePage.aggregate({
    where: { roleId: input.roleId, effect: { runId: run.id } },
    _sum: { rowCount: true },
  });
  const playbook = await readRecruitingPlaybookStep(deps.prisma, input.roleId);
  const classification = classifyTurnEnd(
    { blocks: input.blocks },
    {
      handedOff: input.handedOff,
      pendingApproval: input.pendingApproval,
      savedRows:
        playbook?.stage === "calibration_10"
          ? (savedRows._sum.rowCount ?? 0) > 0
            ? playbook.savedCandidates
            : 0
          : (savedRows._sum.rowCount ?? 0),
      deliverableRows: playbook?.stage === "calibration_10" ? 10 : 1,
    },
  );
  if (classification !== "none") return { action: "ended", classification };
  if (!playbook?.step) return { action: "ended", classification };
  const { stage, step } = playbook;
  const recent = await deps.prisma.message.findMany({
    where: {
      threadId: run.threadId,
      OR: [
        { role: "user" },
        { role: "system", clientNonce: { startsWith: AUTOCONTINUE_NONCE_PREFIX } },
      ],
    },
    orderBy: { seq: "desc" },
    take: max + 1,
    select: { clientNonce: true },
  });
  const count = countTrailingAutoContinues(recent) + 1;
  const reason = step.label.includes("待确认问题") ? "open_clarifications" : "no_deliverable";
  if (count > max) {
    getLogger().warn("run.autocontinue.capped", {
      runId: run.id,
      roleId: input.roleId,
      stage,
      reason,
      count: count - 1,
    });
    await input.postAssistant(
      `我先停在这里：已连续自动推进 ${max} 次仍没有产出可交付结果。下一步是「${step.label}」；回复一句「继续」我就接着做。`,
    );
    return { action: "capped", stage, label: step.label, count: count - 1 };
  }
  getLogger().info("run.autocontinue", {
    runId: run.id,
    roleId: input.roleId,
    stage,
    reason,
    count,
  });
  const text = `继续下一步：${step.label}。${step.prompt}`;
  const sent = await deps.events.sendUserMessage({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    userId: run.userId,
    blocks: [{ kind: "text", text }],
    prompt: text,
    trigger: "follow_up",
    internal: true,
    clientNonce: `${AUTOCONTINUE_NONCE_PREFIX}${run.id}:${count}`,
  });
  if (sent.runId)
    await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
      getLogger().error("run.autocontinue enqueue", error);
    });
  return { action: "continued", runId: sent.runId ?? null, stage, label: step.label, count };
}
