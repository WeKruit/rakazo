import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { classifyTurnEnd, type TurnEndClass } from "@rakazo/core";
import { type PrismaClient, readRecruitingPlaybookStep } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";
import { recruitingResearchInFlight } from "./recruiting-research-poll.js";

export const AUTOCONTINUE_NONCE_PREFIX = "autocontinue:";

/**
 * Turns the guard may push: human turns, its own continuations, the research wake that brings
 * results, and a coordinator woken by a specialist's reply.
 */
const GUARDED_TRIGGERS = new Set(["user", "follow_up", "recruiting_research", "bot_message"]);

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
    recruitingCalibrationRound: PrismaClient["recruitingCalibrationRound"];
    externalEffect: PrismaClient["externalEffect"];
    recruitingRoleRevision: PrismaClient["recruitingRoleRevision"];
    recruitingCandidate: PrismaClient["recruitingCandidate"];
    recruitingCandidateOccurrence: Pick<PrismaClient["recruitingCandidateOccurrence"], "findMany">;
    recruitingResearchTask: PrismaClient["recruitingResearchTask"];
    run: Pick<PrismaClient["run"], "findFirst">;
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
  /** A delegated bot_message run whose outcome returns to the requesting bot, which owns the next step. */
  returnsToRequester?: boolean;
  /** Posts a final assistant message when the cap is reached. */
  postAssistant: (text: string) => Promise<unknown>;
  max?: number;
};

export type TurnEndGuardResult =
  | { action: "ended"; classification: TurnEndClass }
  | { action: "continued"; runId: string | null; stage: string; label: string; count: number }
  | { action: "capped"; stage: string; label: string; count: number };

/**
 * The recruiter reads the ten in chat, not only in the Results panel. When this run recorded the
 * round but its reply did not list the people, post the list.
 */
async function listRoundIfMissing(
  deps: TurnEndGuardDeps,
  input: TurnEndGuardInput,
  round: { effectId: string; candidateKeys: string[] },
) {
  const recorded = await deps.prisma.externalEffect.findFirst({
    where: {
      id: round.effectId,
      runId: input.run.id,
      kind: "recruiting_research",
      status: "completed",
    },
    select: { id: true },
  });
  if (!recorded) return;
  const rows = await deps.prisma.recruitingCandidateOccurrence.findMany({
    where: { roleId: input.roleId, candidateKey: { in: round.candidateKeys } },
    select: { candidateKey: true, name: true, title: true, company: true, location: true },
    orderBy: [{ page: { observedAt: "desc" } }, { rowIndex: "asc" }],
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.candidateKey)) latest.set(row.candidateKey, row);
  const said = input.blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("\n");
  const names = round.candidateKeys.flatMap((key) => latest.get(key)?.name ?? []);
  if (names.filter((name) => said.includes(name)).length >= Math.min(8, names.length)) return;
  const lines = round.candidateKeys.map((key, index) => {
    const row = latest.get(key);
    return `${index + 1}. ${[row?.name, row?.title, row?.company, row?.location].filter(Boolean).join(" · ")}`;
  });
  await input.postAssistant(`本轮 10 位人选：\n\n${lines.join("\n")}`);
}

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
  if (
    max === 0 ||
    !GUARDED_TRIGGERS.has(run.trigger) ||
    (run.trigger === "bot_message" && input.returnsToRequester)
  )
    return { action: "ended", classification: "none" };
  const savedRows = await deps.prisma.recruitingCandidatePage.aggregate({
    where: { roleId: input.roleId, effect: { runId: run.id } },
    _sum: { rowCount: true },
  });
  const playbook = await readRecruitingPlaybookStep(deps.prisma, input.roleId);
  // The Results panel is a real feedback surface. Only the latest unapproved round,
  // recorded by this run's completed native effect, can satisfy this turn.
  if (playbook?.stage === "feedback" || playbook?.stage === "calibration_10") {
    const round = await deps.prisma.recruitingCalibrationRound.findFirst({
      where: { roleId: input.roleId },
      orderBy: { round: "desc" },
      select: { effectId: true, candidateKeys: true, approvedAt: true, createdAt: true },
    });
    if (
      round &&
      !round.approvedAt &&
      round.candidateKeys.length === 10 &&
      new Set(round.candidateKeys).size === 10
    ) {
      // A presented round waits on the recruiter until they write (panel feedback is a message);
      // later turns cannot reopen the panel, so pushing them only repeats the same reply.
      const answered = await deps.prisma.message.findFirst({
        where: { threadId: run.threadId, role: "user", createdAt: { gt: round.createdAt } },
        select: { id: true },
      });
      if (!answered) {
        await listRoundIfMissing(deps, input, round);
        return { action: "ended", classification: "question" };
      }
      const effect = await deps.prisma.externalEffect.findFirst({
        where: {
          id: round.effectId,
          runId: run.id,
          spaceId: run.spaceId,
          kind: "recruiting_research",
          status: "completed",
          request: { path: ["operation"], equals: "calibration_round" },
        },
        select: { id: true },
      });
      if (effect) return { action: "ended", classification: "question" };
      // One push per recruiter message: a second one only re-presents the same round.
      const latest = await deps.prisma.message.findFirst({
        where: {
          threadId: run.threadId,
          OR: [
            { role: "user" },
            { role: "system", clientNonce: { startsWith: AUTOCONTINUE_NONCE_PREFIX } },
          ],
        },
        orderBy: { seq: "desc" },
        select: { clientNonce: true },
      });
      if (latest?.clientNonce?.startsWith(AUTOCONTINUE_NONCE_PREFIX))
        return { action: "ended", classification: "question" };
    }
  }
  const classification = classifyTurnEnd(
    { blocks: input.blocks },
    {
      handedOff: input.handedOff,
      pendingApproval: input.pendingApproval,
      requireBlockingInput: playbook?.stage === "calibration_10" || playbook?.stage === "feedback",
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
  // Waiting on a running search is not a stall: its wake brings the results.
  if (await recruitingResearchInFlight(deps.prisma, input.roleId)) {
    getLogger().info("run.autocontinue.waiting_research", { runId: run.id, roleId: input.roleId });
    return { action: "ended", classification };
  }
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
    // Saved results are a real outcome even when this step is not finished yet.
    const saved = Math.max(playbook.savedCandidates ?? 0, savedRows._sum.rowCount ?? 0);
    await input.postAssistant(
      saved > 0
        ? `我先停在这里：已保存 ${saved} 位候选人，「${step.label}」还没完成。回复一句「继续」我就接着做。`
        : `我先停在这里：已连续自动推进 ${max} 次仍没有产出可交付结果。下一步是「${step.label}」；回复一句「继续」我就接着做。`,
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
  const text = `继续下一步：${step.label}。${step.prompt}（这是自动继续，不是招聘者的话，引用时用招聘者自己的消息。）`;
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
