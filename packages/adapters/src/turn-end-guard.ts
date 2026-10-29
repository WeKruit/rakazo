import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  classifyTurnEnd,
  type TurnEndClass,
  turnEndPromise,
  turnEndStarted,
  turnEndStuck,
  turnEndText,
} from "@rakazo/core";
import { type PrismaClient, readRecruitingPlaybookStep } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";
import { recruitingResearchInFlight } from "./recruiting-research-poll.js";
import type { DeclineRetry } from "./turn-report.js";
import { declineRetry, draftVariables, questionCard, retryReason } from "./turn-report.js";

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
    /** Per person, the must-haves their row does not show. */
    unverified?: Readonly<Record<string, string>>;
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
  // The same open must-haves under every person say nothing about any one of them: say them once.
  const notes = keys.map((key) => input.unverified?.[key]?.trim() ?? "");
  const shared =
    keys.length > 1 && notes[0] && notes.every((note) => note === notes[0]) ? notes[0] : undefined;
  const lines = keys.map((key, index) => {
    const person = people.get(key);
    // The saved key is the profile link, so the name opens the person's LinkedIn profile.
    const slug = /^linkedin:(\/in\/[^\s/?#]+)\/?$/i.exec(key)?.[1];
    const name =
      person?.name && slug ? `[${person.name}](https://www.linkedin.com${slug})` : person?.name;
    const head = [name ? `**${name}**` : null, person?.title, person?.company, person?.location]
      .filter(Boolean)
      .join(" · ");
    const passage = roundPassage(person?.snippet);
    const unknown = shared ? undefined : input.unverified?.[key]?.trim();
    return `${index + 1}. ${head}${passage ? `\n   > ${passage}` : ""}${unknown ? `\n   Not verified: ${unknown}` : ""}`;
  });
  return `${lines.length} ${lines.length === 1 ? "person" : "people"} this round:${shared ? `\nNot verified for anyone yet: ${shared}` : ""}\n\n${lines.join("\n")}`;
}

const PASSAGE_MAX = 220;

/**
 * A profile passage as the recruiter reads it: without the search's field scaffolding
 * ("Department: … • Level: …", "(US)", "...") and, when long, cut at a word, never mid-word.
 */
export function roundPassage(snippet: string | null | undefined): string | undefined {
  const text = (snippet ?? "")
    .replace(
      /(?:Department|Level|Seniority|Function):\s*[^•\n]*?(?=\s*(?:•|$|\n|Department:|Level:|Seniority:|Function:))/gi,
      " ",
    )
    .replace(/\s*•\s*/g, " ")
    .replace(/\s*\((?:US|USA)\)/g, "")
    .replace(/\s*\.{3,}\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  if (text.length <= PASSAGE_MAX) return text;
  const cut = text.slice(0, PASSAGE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > PASSAGE_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

const PROMISE_LABEL = "Finish what the last message said it would do";
const AUTO_NOTE =
  " (This is an automatic continuation, not the recruiter's words. When quoting, use the recruiter's own messages.)";

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
      ? `Your last message ended with "${input.promise.slice(0, 160)}", but this turn did not do it and no background work is running. Do it now, and do not promise a time again. `
      : "",
    input.step ? `Continue with the next step: ${input.step.label}. ${input.step.prompt}` : "",
    input.last
      ? " This is the last automatic continuation: this turn must deliver a result. If you truly cannot (a tool failed or information is missing), try another way once; if that still fails, use one question card (ask_user) to ask the recruiter for one concrete decision, saying where it is stuck and offering options. Do not just report status, and do not say you will do it later."
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

/** Effects that move a role through its playbook: brief, searches, rounds, feedback, approvals. */
const PLAYBOOK_EFFECTS = new Set([
  "recruiting_role",
  "recruiting_research",
  "recruiting_feedback",
  "recruiting_shortlist",
  "recruiting_assess",
  "recruiting_request_approval",
]);

/**
 * Since the recruiter's last message the role did other work (looked up saved people's profiles,
 * contacts) and nothing in its playbook. That answered what they asked; the role's next step
 * waits for them instead of starting on its own, however the lookups turned out.
 */
async function answeredOtherRequest(deps: TurnEndGuardDeps, run: TurnEndGuardInput["run"]) {
  const asked = await deps.prisma.message.findFirst({
    where: { threadId: run.threadId, role: "user" },
    orderBy: { seq: "desc" },
    select: { createdAt: true },
  });
  if (!asked) return false;
  const effects = await deps.prisma.externalEffect.findMany({
    where: {
      spaceId: run.spaceId,
      run: { threadId: run.threadId },
      createdAt: { gt: asked.createdAt },
    },
    select: { id: true, kind: true },
  });
  if (!effects.length || effects.some((effect) => PLAYBOOK_EFFECTS.has(effect.kind))) return false;
  // A people search saves new people to the role: that is playbook work too.
  const pages = await deps.prisma.recruitingCandidatePage.count({
    where: { effectId: { in: effects.map((effect) => effect.id) } },
  });
  return pages === 0;
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
  const text = `Continue: saving the recruiter's feedback just failed, so this feedback is not recorded yet. Reason: ${error.slice(0, 600)} Fix it from the reason and save it again with recruiting_feedback right away, then continue with the next step. Do not say it is recorded until the save succeeds.${AUTO_NOTE}`;
  const sent = await deps.events.sendUserMessage({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    userId: run.userId,
    blocks: [{ kind: "text", text }],
    prompt: text,
    trigger: "follow_up",
    internal: true,
    skipWaitingRuns: true,
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
    label: "Save feedback",
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
  const endText = turnEndText(input.blocks);
  // "已开始扩展搜索" with nothing running is a promise too; a running search is checked below.
  const promise = turnEndPromise(endText) ?? turnEndStarted(endText);
  // A teammate handed this bot one task (an email draft, a deeper search). Finishing that task
  // ends its turn; the role's next step stays with the coordinator, so only a promise is pushed.
  const handedIn = await handedInStage(deps, run);
  const nextStep =
    handedIn || (playbook?.step && (await answeredOtherRequest(deps, run)))
      ? undefined
      : (playbook?.step ?? undefined);
  if (!nextStep && !promise) return { action: "ended", classification };
  // Waiting on a running search is not a stall: its wake brings the results.
  if (await recruitingResearchInFlight(deps.prisma, input.roleId)) {
    getLogger().info("run.autocontinue.waiting_research", { runId: run.id, roleId: input.roleId });
    return { action: "ended", classification };
  }
  const stage = playbook?.stage ?? "intake";
  const step: { label: string; prompt: string; openClarifications?: number } = nextStep ?? {
    label: PROMISE_LABEL,
    prompt: "",
  };
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
    : step.openClarifications
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
        ? `I've paused here: ${saved} ${saved === 1 ? "candidate is" : "candidates are"} saved, and "${step.label}" isn't finished yet. Reply "continue" and I'll pick it up.`
        : `I've paused here: ${max} automatic attempts in a row did not produce a result. The next step is "${step.label}". Reply "continue" and I'll pick it up.`,
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
    skipWaitingRuns: true,
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
    prisma: Pick<PrismaClient, "message" | "externalEffect" | "event">;
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
  // A save refused before it reached the server (its arguments failed the tool's format check)
  // leaves only the tool event.
  const failedCall = refused
    ? undefined
    : (
        await deps.prisma.event.findMany({
          where: {
            runId: run.id,
            spaceId: run.spaceId,
            type: "agent.tool.completed",
            payload: { path: ["name"], equals: "recruiting_role" },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { payload: true },
        })
      )
        .map((event) => (event.payload as { error?: unknown } | null)?.error)
        .find((value) => typeof value === "string");
  const error = (refused?.result as { error?: unknown } | null)?.error ?? failedCall;
  const text = turnEndText(input.blocks);
  const promise = classification === "none" ? turnEndPromise(text) : undefined;
  // Ending on "sorry, it is stuck" without a question or a result has not done the work either.
  const stuck = classification === "none" ? turnEndStuck(text) : undefined;
  if (typeof error !== "string" && !promise && !stuck) return { action: "ended", classification };
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
    reason: typeof error === "string" ? "role_refused" : promise ? "promise" : "stuck",
  });
  const prompt =
    typeof error === "string"
      ? `Continue: saving the role was just refused. Reason: ${error.slice(0, 600)} This is not an outage. Fix it from the reason and save again right away with recruiting_role create (if a quote cannot be exact, give only the source location without the quote), then keep finding people until ten are shown.${AUTO_NOTE}`
      : promise
        ? continuationText({ promise, last: true })
        : `Continue: the last message ended on an error or got stuck, but the work is not done. The role is not saved yet: save it now with recruiting_role create (if a quote cannot be exact, give only the source location without the quote), then keep finding people until ten are shown. Do not apologize to the recruiter again or say saving is unavailable.${AUTO_NOTE}`;
  const sent = await deps.events.sendUserMessage({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    userId: run.userId,
    blocks: [{ kind: "text", text: prompt }],
    prompt,
    trigger: "follow_up",
    internal: true,
    skipWaitingRuns: true,
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
    label: typeof error !== "string" && promise ? PROMISE_LABEL : "Save the role",
    count: 1,
  };
}

const CARD_KINDS = new Set(["ask", "approval", "mcp_approval", "connect", "app_connect", "choice"]);

/**
 * The request a turn answers: the person's message, or for a stage a teammate handed in, the
 * handoff's brief (a returned stage report is not a request).
 */
export function turnRequestText(
  message: { blocks: readonly MessageBlock[] } | undefined,
  handoff: { blocks: readonly MessageBlock[] } | undefined,
  botId: string,
) {
  if (message)
    return message.blocks
      .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
      .join("\n");
  return (handoff?.blocks ?? [])
    .flatMap((block) =>
      block.kind === "handoff" && block.toBotId === botId && !block.report ? [block.text] : [],
    )
    .join("\n");
}

/** Stages whose own questions and lists are the turn's deliverable: an offer there is not a deferral. */
const QUESTION_STAGES = new Set(["intake", "calibration_10"]);

/**
 * A final reply that declines, defers or hands back a pick, once per human message: the retry
 * note (naming the tool or teammate for the asked work when there is one), else undefined and
 * the reply stands. A card or question card already shown is the turn's real boundary, and a
 * turn that presented the ten is the first-ten deliverable, so neither is ever retried; nor is
 * an offer or pick question while the role is still in intake or its first calibration.
 */
export async function planDeclineRetry(
  deps: { prisma: Pick<PrismaClient, "message" | "chatGroupMember"> },
  input: {
    run: { threadId: string; botId: string };
    groupId?: string | null;
    reply: string;
    blocks: readonly MessageBlock[];
    request: string;
    tools: readonly { name: string }[];
    /** The turn did consequential work. */
    worked?: boolean;
    /** The turn showed or recorded the round's ten. */
    presentedRound?: boolean;
    /** A teammate handed this turn the request. */
    handedIn?: boolean;
    /** The role's playbook stage, read only when an offer or pick question needs it. */
    stage?: () => Promise<string | undefined>;
  },
): Promise<DeclineRetry | undefined> {
  const variables = draftVariables(input.reply);
  const declined = input.request.trim() ? retryReason(input.reply, input.request) : undefined;
  if (!(variables || declined) || input.presentedRound) return undefined;
  if (input.blocks.some((block) => CARD_KINDS.has(block.kind))) return undefined;
  if (!variables && declined?.kind !== "decline" && input.worked) return undefined;
  const recent = await deps.prisma.message.findMany({
    where: {
      threadId: input.run.threadId,
      OR: [
        { role: "user" },
        { role: "system", clientNonce: { startsWith: AUTOCONTINUE_NONCE_PREFIX } },
      ],
    },
    orderBy: { seq: "desc" },
    take: 2,
    select: { clientNonce: true },
  });
  // Already retried: a question still typed into the reply goes on a card instead.
  if (countTrailingAutoContinues(recent) > 0)
    return declined && !variables ? questionCard(input.reply, declined) : undefined;
  if (variables) return variables;
  if (!declined) return undefined;
  const members = input.groupId
    ? await deps.prisma.chatGroupMember.findMany({
        where: {
          groupId: input.groupId,
          botId: { not: input.run.botId },
          bot: { archivedAt: null },
        },
        select: {
          bot: {
            select: {
              id: true,
              name: true,
              title: true,
              description: true,
              mcpServers: {
                where: { server: { enabled: true } },
                select: { server: { select: { name: true, description: true } } },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      })
    : [];
  // Intake and calibration questions are the coordinator's own playbook steps; a teammate
  // handed one request asks its question on a card.
  if (
    declined.kind !== "decline" &&
    !input.handedIn &&
    QUESTION_STAGES.has((await input.stage?.()) ?? "")
  )
    return undefined;
  return declineRetry({
    reply: input.reply,
    request: input.request,
    tools: input.tools,
    worked: input.worked,
    teammates: members.map(({ bot }) => ({
      id: bot.id,
      name: bot.name,
      about: [
        bot.title,
        bot.description,
        ...bot.mcpServers.map(({ server }) => `${server.name} ${server.description}`),
      ]
        .filter(Boolean)
        .join(" "),
    })),
  });
}

/** Starts the one retry of a declined turn as an internal continuation of the same bot. */
/** The nonce of the retry message for a declined turn; its run continues that turn's stage. */
export function declineRetryNonce(runId: string): string {
  return `${AUTOCONTINUE_NONCE_PREFIX}${runId}:decline`;
}

/** The declined turn a retry message was sent for, from that message's nonce. */
export function declinedRunId(clientNonce: string | null | undefined): string | undefined {
  if (!clientNonce?.startsWith(AUTOCONTINUE_NONCE_PREFIX) || !clientNonce.endsWith(":decline"))
    return undefined;
  return clientNonce.slice(AUTOCONTINUE_NONCE_PREFIX.length, -":decline".length) || undefined;
}

export async function sendDeclineRetry(
  deps: Pick<TurnEndGuardDeps, "events" | "jobs">,
  run: TurnEndGuardInput["run"],
  retry: DeclineRetry,
) {
  getLogger().info("run.autocontinue", { runId: run.id, stage: "decline", reason: "declined" });
  const text = `${retry.note}${AUTO_NOTE}`;
  const sent = await deps.events.sendUserMessage({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    userId: run.userId,
    blocks: [{ kind: "text", text }],
    prompt: text,
    trigger: "follow_up",
    internal: true,
    skipWaitingRuns: true,
    clientNonce: declineRetryNonce(run.id),
  });
  if (sent.runId)
    await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
      getLogger().error("run.autocontinue enqueue", error);
    });
  return sent.runId ?? null;
}
