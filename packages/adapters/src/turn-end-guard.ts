import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { classifyTurnEnd, type TurnEndClass, turnEndPromise, turnEndText } from "@rakazo/core";
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
    /** The message that started the run: a teammate's handoff when the stage was handed to it. */
    sourceMessageId?: string | null;
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

/** The recruiter's answers to the bot's question cards, keyed by question; a later answer wins. */
export function intakeAnswers(messages: readonly { role: string; blocks: unknown }[]) {
  const answers = new Map<string, string>();
  let question: string | undefined;
  for (const message of messages) {
    const blocks = message.blocks as MessageBlock[];
    if (message.role !== "user") {
      const ask = blocks.find((block) => block.kind === "ask");
      question = ask?.kind === "ask" ? ask.text.trim().slice(0, 200) : undefined;
      continue;
    }
    const answer = blocks
      .flatMap((block) => (block.kind === "text" ? [block.text.trim()] : []))
      .filter(Boolean)
      .join("\n");
    if (question && answer) {
      answers.delete(question);
      answers.set(question, answer);
    }
    question = undefined;
  }
  return [...answers].map(([key, value]) => ({ key, value }));
}
/** A question's topic: its first sentence without spaces or punctuation. */
function askTopic(text: string) {
  return (text.trim().split(/[？?。\n]/)[0] ?? "").replace(/[\s\p{P}]/gu, "").toLowerCase();
}
/**
 * The earlier answer to a question this conversation already asked: same first sentence, or one
 * first sentence contains the other. Wording that differs further is not treated as a repeat.
 */
export function answeredAsk(question: string, answers: readonly { key: string; value: string }[]) {
  const topic = askTopic(question);
  if (topic.length < 4) return undefined;
  return answers.findLast(({ key }) => {
    const asked = askTopic(key);
    if (asked === topic) return true;
    const [short, long] = asked.length < topic.length ? [asked, topic] : [topic, asked];
    return short.length >= 8 && long.includes(short);
  });
}
type RoundPrisma = Pick<PrismaClient, "externalEffect"> & {
  recruitingCandidateOccurrence: Pick<PrismaClient["recruitingCandidateOccurrence"], "findMany">;
};
type RoundPerson = {
  name?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  snippet?: string | null;
};

/** The saved people behind round keys, each with the profile passage its search returned. */
export async function recruitingRoundPeople(
  prisma: RoundPrisma,
  input: { threadId: string; spaceId: string; roleId: string; candidateKeys: readonly string[] },
) {
  // Any saved search in this conversation: the round is often recorded by a later run.
  const [searches, occurrences] = await Promise.all([
    prisma.externalEffect.findMany({
      where: {
        spaceId: input.spaceId,
        run: { threadId: input.threadId },
        kind: "recruiting_research",
        status: "completed",
        request: { path: ["operation"], equals: "save_search" },
      },
      select: { result: true },
    }),
    prisma.recruitingCandidateOccurrence.findMany({
      where: { roleId: input.roleId, candidateKey: { in: [...input.candidateKeys] } },
      select: { candidateKey: true, name: true, title: true, company: true, location: true },
      orderBy: [{ page: { observedAt: "desc" } }, { rowIndex: "asc" }],
    }),
  ]);
  const people = new Map<string, RoundPerson>();
  for (const row of occurrences)
    if (!people.has(row.candidateKey)) people.set(row.candidateKey, row);
  for (const search of searches) {
    const rows = (search.result as { candidateRows?: unknown } | null)?.candidateRows;
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Array<RoundPerson & { candidateKey?: unknown }>)
      if (typeof row.candidateKey === "string" && row.snippet)
        people.set(row.candidateKey, { ...people.get(row.candidateKey), ...row });
  }
  return people;
}

/**
 * The ten of a recorded round as the chat lists them: name, title, company, location and the
 * profile passage the people search returned for each, read from this run's saved searches.
 */
export async function recruitingRoundListText(
  prisma: RoundPrisma,
  input: {
    threadId: string;
    spaceId: string;
    roleId: string;
    candidateKeys: readonly string[];
    /** Leave out keys that name no saved person (a list still being written). */
    knownOnly?: boolean;
    /** The last key may be cut mid-word: leave it out while it is the start of another person's. */
    lastMayBeCut?: boolean;
  },
) {
  const people = await recruitingRoundPeople(prisma, input);
  const last = input.candidateKeys.length - 1;
  const cut = (key: string, index: number) =>
    !!input.lastMayBeCut &&
    index === last &&
    [...people.keys()].some((other) => other !== key && other.startsWith(key));
  const keys = input.knownOnly
    ? input.candidateKeys.filter((key, index) => people.has(key) && !cut(key, index))
    : input.candidateKeys;
  if (input.knownOnly && !keys.length) return "";
  const lines = keys.map((key, index) => {
    const person = people.get(key);
    const head = [
      person?.name ? `**${person.name}**` : null,
      person?.title,
      person?.company,
      person?.location,
    ]
      .filter(Boolean)
      .join(" · ");
    const passage = person?.snippet?.trim();
    return `${index + 1}. ${head}${passage ? `\n   > ${passage.length > 220 ? `${passage.slice(0, 220)}…` : passage}` : ""}`;
  });
  return `本轮 ${lines.length} 位人选：\n\n${lines.join("\n")}`;
}

const PROMISE_LABEL = "完成上一条说要做的事";
const AUTO_NOTE = "（这是自动继续，不是招聘者的话，引用时用招聘者自己的消息。）";

/**
 * The internal follow-up a pushed turn starts from. A turn that ended on a promise is told so,
 * and the last push before the cap must end on a result or one concrete question, so the
 * recruiter never sees a turn that just stops.
 */
export function continuationText(input: {
  step?: { label: string; prompt: string };
  promise?: string;
  last?: boolean;
}) {
  const parts = [
    input.promise
      ? `你上一条以「${input.promise.slice(0, 160)}」结束，但这一轮没有去做，后台也没有在跑的工作。现在就做，不要再许诺时间。`
      : "",
    input.step ? `继续下一步：${input.step.label}。${input.step.prompt}` : "",
    input.last
      ? "这是最后一次自动继续：本轮要交付结果；确实做不到（工具失败或缺信息），先换一种做法再试一次，仍不行就用一张问题卡（ask_user）问招聘者一个具体决定，说清卡在哪并给出可选做法。不要只汇报状态，也不要说之后再做。"
      : "",
  ];
  return `${parts.filter(Boolean).join("")}${AUTO_NOTE}`;
}

/** True when the run was started by a teammate's handoff to this bot. */
async function handedInStage(deps: TurnEndGuardDeps, run: TurnEndGuardInput["run"]) {
  if (!run.sourceMessageId || run.trigger !== "follow_up") return false;
  const source = await deps.prisma.message.findUnique({
    where: { id: run.sourceMessageId },
    select: { blocks: true },
  });
  const blocks = (source?.blocks ?? []) as MessageBlock[];
  return blocks.some((block) => block.kind === "handoff" && block.toBotId === run.botId);
}

/**
 * A turn whose last recruiting_feedback call was rejected left the recruiter's feedback unsaved,
 * whatever its reply said. Push one retry with the reason, once per recruiter message.
 */
async function unsavedFeedback(
  deps: TurnEndGuardDeps,
  input: TurnEndGuardInput,
): Promise<TurnEndGuardResult | undefined> {
  const { run } = input;
  const last = await deps.prisma.externalEffect.findFirst({
    where: { runId: run.id, spaceId: run.spaceId, kind: "recruiting_feedback" },
    orderBy: { createdAt: "desc" },
    select: { result: true },
  });
  const error = (last?.result as { error?: unknown } | null)?.error;
  if (typeof error !== "string") return undefined;
  const classification = classifyTurnEnd(
    { blocks: input.blocks },
    { handedOff: input.handedOff, pendingApproval: input.pendingApproval },
  );
  if (classification === "card" || classification === "handoff") return undefined;
  const recent = await deps.prisma.message.findMany({
    where: {
      threadId: run.threadId,
      OR: [
        { role: "user" },
        { role: "system", clientNonce: { startsWith: AUTOCONTINUE_NONCE_PREFIX } },
      ],
    },
    orderBy: { seq: "desc" },
    take: 2,
    select: { clientNonce: true },
  });
  if (countTrailingAutoContinues(recent) > 0) return undefined;
  getLogger().info("run.autocontinue", {
    runId: run.id,
    roleId: input.roleId,
    stage: "feedback",
    reason: "feedback_refused",
  });
  const text = `继续：刚才保存招聘者的反馈没有成功，这条反馈还没有记下。原因：${error.slice(0, 600)} 按原因改正后立即用 recruiting_feedback 重新保存，成功后接着做下一步；保存成功之前不要说已记录。${AUTO_NOTE}`;
  const sent = await deps.events.sendUserMessage({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    userId: run.userId,
    blocks: [{ kind: "text", text }],
    prompt: text,
    trigger: "follow_up",
    internal: true,
    clientNonce: `${AUTOCONTINUE_NONCE_PREFIX}${run.id}:1`,
  });
  if (sent.runId)
    await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
      getLogger().error("run.autocontinue enqueue", error);
    });
  return {
    action: "continued",
    runId: sent.runId ?? null,
    stage: "feedback",
    label: "保存反馈",
    count: 1,
  };
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
  const unsaved = await unsavedFeedback(deps, input);
  if (unsaved) return unsaved;
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
      if (!answered) return { action: "ended", classification: "question" };
      // The recruiter's message after the round reached this run (an answer to its next-step card
      // resumes it; anything left unread would have started a continuation instead of this
      // guard), so a turn that ends here without a new round or a scale-out left it unanswered.
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
  const promise = turnEndPromise(turnEndText(input.blocks));
  // A teammate handed this bot one task (an email draft, a deeper search). Finishing that task
  // ends its turn; the role's next step stays with the coordinator, so only a promise is pushed.
  const handedIn = await handedInStage(deps, run);
  const nextStep = handedIn ? undefined : (playbook?.step ?? undefined);
  if (!nextStep && !promise) return { action: "ended", classification };
  // Waiting on a running search is not a stall: its wake brings the results.
  if (await recruitingResearchInFlight(deps.prisma, input.roleId)) {
    getLogger().info("run.autocontinue.waiting_research", { runId: run.id, roleId: input.roleId });
    return { action: "ended", classification };
  }
  const stage = playbook?.stage ?? "intake";
  const step = nextStep ?? { label: PROMISE_LABEL, prompt: "" };
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
  const reason = promise
    ? "promise"
    : step.label.includes("待确认问题")
      ? "open_clarifications"
      : "no_deliverable";
  if (count > max) {
    getLogger().warn("run.autocontinue.capped", {
      runId: run.id,
      roleId: input.roleId,
      stage,
      reason,
      count: count - 1,
    });
    // Saved results are a real outcome even when this step is not finished yet.
    const saved = Math.max(playbook?.savedCandidates ?? 0, savedRows._sum.rowCount ?? 0);
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
  const text = continuationText({
    step: nextStep,
    promise,
    last: count === max,
  });
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

/**
 * A turn that tried to create the role, was refused and ended without asking anything leaves
 * no role, so the guard above never runs. Push one retry instead of stopping on an apology.
 */
export async function guardRecruitingRoleCreate(
  deps: Pick<TurnEndGuardDeps, "events" | "jobs"> & {
    prisma: Pick<PrismaClient, "message" | "externalEffect">;
  },
  input: Pick<TurnEndGuardInput, "blocks" | "handedOff" | "pendingApproval"> & {
    run: TurnEndGuardInput["run"];
  },
): Promise<TurnEndGuardResult> {
  const { run } = input;
  const classification = classifyTurnEnd(
    { blocks: input.blocks },
    { handedOff: input.handedOff, pendingApproval: input.pendingApproval },
  );
  if (!GUARDED_TRIGGERS.has(run.trigger) || run.trigger === "bot_message")
    return { action: "ended", classification: "none" };
  if (classification === "question" || classification === "card" || classification === "handoff")
    return { action: "ended", classification };
  const refused = await deps.prisma.externalEffect.findFirst({
    where: {
      runId: run.id,
      spaceId: run.spaceId,
      kind: "recruiting_role",
      status: "completed",
      request: { path: ["operation"], equals: "create" },
    },
    orderBy: { createdAt: "desc" },
    select: { result: true },
  });
  const error = (refused?.result as { error?: unknown } | null)?.error;
  const promise = classification === "none" ? turnEndPromise(turnEndText(input.blocks)) : undefined;
  if (typeof error !== "string" && !promise) return { action: "ended", classification };
  const recent = await deps.prisma.message.findMany({
    where: {
      threadId: run.threadId,
      OR: [
        { role: "user" },
        { role: "system", clientNonce: { startsWith: AUTOCONTINUE_NONCE_PREFIX } },
      ],
    },
    orderBy: { seq: "desc" },
    take: 2,
    select: { clientNonce: true },
  });
  // One push per recruiter message.
  if (countTrailingAutoContinues(recent) > 0) return { action: "ended", classification };
  getLogger().info("run.autocontinue", {
    runId: run.id,
    stage: "intake",
    reason: typeof error === "string" ? "role_refused" : "promise",
  });
  const text =
    typeof error === "string"
      ? `继续：刚才保存岗位被拒，原因：${error.slice(0, 600)} 这不是故障。按原因改正后立即用 recruiting_role create 重新保存，然后继续下一步。${AUTO_NOTE}`
      : continuationText({ promise, last: true });
  const sent = await deps.events.sendUserMessage({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    userId: run.userId,
    blocks: [{ kind: "text", text }],
    prompt: text,
    trigger: "follow_up",
    internal: true,
    clientNonce: `${AUTOCONTINUE_NONCE_PREFIX}${run.id}:1`,
  });
  if (sent.runId)
    await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
      getLogger().error("run.autocontinue enqueue", error);
    });
  return {
    action: "continued",
    runId: sent.runId ?? null,
    stage: "intake",
    label: typeof error === "string" ? "保存岗位" : PROMISE_LABEL,
    count: 1,
  };
}
