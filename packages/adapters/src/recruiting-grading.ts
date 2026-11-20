import { createHash } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { recruitingGradeStartJob, runContinueJob } from "@rakazo/adapter-kit";
import type { RunTrigger } from "@rakazo/contracts";
import { recruitingBotKey } from "@rakazo/core";
import type { CalibrationRoundStatus, PrismaClient } from "@rakazo/db";
import {
  calibrationRoundStatus,
  createThreadMessageInTransaction,
  listRecruitingCandidates,
  markCalibrationRoundChecked,
  RECRUITING_GRADE_NONCE_PREFIX,
  RECRUITING_ROUND_REVIEW_NONCE_PREFIX,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { handedInRecruiterWords } from "./global-role-writes.js";
import { requestedPeopleTarget } from "./people-target.js";
import { recruiterWordsSinceFirstRound, roundCriteria } from "./recruiting-round-check.js";

export { RECRUITING_GRADE_NONCE_PREFIX };
/** Newly saved searches settle this long before grading starts, so one request covers them. */
export const RECRUITING_GRADE_SETTLE_MS = 30_000;
/** A busy conversation is checked again this often, for at most this many tries (about 1 hour). */
const BUSY_RETRY_MS = 30_000;
/** A round held for the Reviewer is checked the moment its conversation is free. */
const HELD_RETRY_MS = 3_000;
/** How soon the next batch is tried while the batch before it is still grading. */
const NEXT_BATCH_RETRY_MS = 5_000;
const MAX_ATTEMPTS = 120;
/** People per grading request. */
export const GRADE_BATCH = 50;
/** People per batch the quality check grades itself, since it reads each full profile. */
export const SELF_GRADE_BATCH = 10;
/** Grading requests the research service works on at once for one conversation. */
export const GRADE_IN_FLIGHT = 4;
/** A grading request whose grades never came back stops holding up the next batch after this. */
const IN_FLIGHT_MS = 2 * 60 * 60_000;
/** After a grading request that never started research, the next batch waits this long. */
const NOT_STARTED_HOLD_MS = 30 * 60_000;
/** Recent grading requests in a row that ended unsaved, after which grading stops retrying. */
const GRADE_FAILURES_STOP = 4;
const RESEARCH_MCP = "https://api.autumn.ai/mcp";
const PEOPLE_SEARCH_MCP = "https://mcp.exa.ai/";
const RESEARCH_WAKE_PREFIX = "recruiting-research-wake:";
const BUSY_STATUSES = ["queued", "leased", "running"];

/** Queue (or push back) the grading start for a conversation whose search just saved people. */
export async function scheduleRecruitingGrading(
  jobs: Pick<JobPublisher, "enqueue">,
  threadId: string,
  now = Date.now(),
  settleMs = RECRUITING_GRADE_SETTLE_MS,
): Promise<void> {
  const job = recruitingGradeStartJob({ threadId }, new Date(now + settleMs));
  // A start with no settle wait (a held round's check) replaces a later one already waiting.
  await jobs.enqueue(settleMs > 0 ? job : { ...job, keepExisting: false });
}

/**
 * The grading start's own next check. It must replace, not keep, the pending start: the job
 * that is running holds the same key until it ends, so a kept job would be dropped with it.
 */
function laterGradingStart(payload: { threadId: string; attempt?: number }, at: number) {
  return { ...recruitingGradeStartJob(payload, new Date(at)), keepExisting: false };
}

/** Tools a grading turn may use: read the role's people, run the grading research, save its rows. */
const GRADING_BUILTIN_TOOLS = new Set([
  "artifact_read",
  // The quality check reads each person's full public profile before grading them itself.
  "web_fetch",
  "recruiting_candidates",
  "search_history",
  "read_history",
  "skill_read",
  "task_catalog",
]);
const GRADING_RESEARCH_OPERATIONS = new Set(["status", "rows", "save_results", "save_grades"]);
/** The saves that record grades: a search's grading rows, or the quality check's own. */
const GRADE_SAVE_OPERATIONS = ["save_results", "save_grades"];
/** The request turn only starts research; the turn its finish wakes reads and saves the grades. */
// A people-search agent run grades the batch within the turn; a research request finishes later.
const START_PROVIDER_TOOLS = new Set(["research", "credits", "agent_run"]);
/** A status read after starting is harmless, so the request turn may make one. */
const START_READ_TOOLS = new Set(["get_task"]);
const SAVE_PROVIDER_TOOLS = new Set(["get_task", "get_rows"]);
/** Tool calls one grading turn may make; a batch needs far fewer, so more means it is looping. */
export const GRADE_TOOL_CALL_LIMIT = 60;
/** Past this many calls a grading turn that keeps calling after being told to end is stopped. */
export const GRADE_TOOL_CALL_STOP = 3 * GRADE_TOOL_CALL_LIMIT;
/** The connector catalog that lists and runs tools beyond the directly loaded ones. */
const CATALOG_READ_TOOLS = new Set(["connectors_search_tools", "connectors_load_tool"]);
const CATALOG_EXECUTE_TOOL = "connectors_execute_tool";

/** A research provider call this grading turn may make. */
function gradingProviderCall(tool: string, args: Record<string, unknown>, start: boolean): boolean {
  return start
    ? (START_PROVIDER_TOOLS.has(tool) && args.task_id === undefined) || START_READ_TOOLS.has(tool)
    : SAVE_PROVIDER_TOOLS.has(tool);
}

/**
 * The tools a grading turn is given, like a named agent's fixed tool list: only what its step
 * can use, so it never reaches for a search, a connection or a role change. The connector
 * catalog stays only when the research service is not loaded directly.
 */
export function gradingTools<T extends { name: string }>(
  tools: readonly T[],
  clientNonce: string | null,
): T[] {
  const start = Boolean(clientNonce?.startsWith(RECRUITING_GRADE_NONCE_PREFIX));
  const provider = (name: string) => {
    const tool = /^mcp__.+__([^_].*)$/.exec(name)?.[1];
    return tool !== undefined && gradingProviderCall(tool, {}, start);
  };
  const direct = tools.some((tool) => provider(tool.name));
  return tools.filter(
    (tool) =>
      GRADING_BUILTIN_TOOLS.has(tool.name) ||
      tool.name === "recruiting_research" ||
      provider(tool.name) ||
      (!direct && (CATALOG_READ_TOOLS.has(tool.name) || tool.name === CATALOG_EXECUTE_TOOL)),
  );
}

/** The provider tool name in a direct name (`mcp__server__tool`) or a catalog id (`server:tool`). */
function providerToolName(id: string): string | undefined {
  const direct = /^mcp__.+__([^_].*)$/.exec(id)?.[1];
  if (direct) return direct;
  const separator = id.lastIndexOf(":");
  if (separator < 0) return undefined;
  try {
    return decodeURIComponent(id.slice(separator + 1));
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Why a grading turn may not call this tool, or undefined when it may. A grading turn only grades
 * people already in Results: it never changes the role, its brief or stage, the people's status,
 * or messages anyone, whatever the model decides. The request turn (`clientNonce` with the grading
 * prefix) only starts the research; the background follow-up wakes another grading turn when it
 * finishes, and that turn only reads and saves its rows.
 */
export function gradingToolRefusal(
  name: string,
  args: Record<string, unknown>,
  clientNonce: string | null,
  calls = 0,
): string | undefined {
  if (calls >= GRADE_TOOL_CALL_LIMIT)
    return "Not run: this grading turn has used all its tool calls. End the turn now with an empty reply; anything left is picked up later.";
  const start = Boolean(clientNonce?.startsWith(RECRUITING_GRADE_NONCE_PREFIX));
  const direct = /^mcp__.+__([^_].*)$/.exec(name)?.[1];
  const executed =
    name === CATALOG_EXECUTE_TOOL ? providerToolName(String(args.id ?? "")) : undefined;
  const allowed =
    GRADING_BUILTIN_TOOLS.has(name) ||
    CATALOG_READ_TOOLS.has(name) ||
    (name === "recruiting_research" && GRADING_RESEARCH_OPERATIONS.has(String(args.operation))) ||
    (direct !== undefined && gradingProviderCall(direct, args, start)) ||
    (executed !== undefined && gradingProviderCall(executed, record(args.arguments), start));
  if (allowed) return undefined;
  return start
    ? "Not run: this turn only grades the batch: read each listed person's profile with web_fetch and save your grades with recruiting_research save_grades (or the people-search agent run then save_results with its run id, or the research request, whose grades are saved when it finishes). End the turn with an empty reply."
    : "Not run: this turn only reads the grading research's rows and saves them with recruiting_research save_results; nothing else.";
}

/** Reply guidance for a grading turn, which nobody reads in the chat. */
export const GRADING_REPLY_GUIDANCE =
  "Grades are saved to Results, not reported in chat. Leave the final reply empty.";

/** Filter for research tasks a conversation's own turns started, leaving grading requests out. */
export const NOT_GRADING_TASK = {
  createdByRun: {
    OR: [
      { clientNonce: null },
      { NOT: { clientNonce: { startsWith: RECRUITING_GRADE_NONCE_PREFIX } } },
    ],
  },
};

export function recruitingGradePrompt(
  people: readonly { name: string; url: string }[],
  service: GradingService,
  asked: readonly string[] = [],
) {
  // What the recruiter said for the round they are reviewing are hard requirements too.
  const list = [
    ...(asked.length
      ? [
          "The recruiter also asked for these; grade each as a hard requirement (someone like the people they turned down is not_met), except the job's own terms (pay, office days, benefits), which are about the job, not the person:",
          ...asked.map((statement) => `* ${statement}`),
          "",
        ]
      : []),
    ...people.map((person) => `- ${person.name}: ${person.url}`),
  ];
  if (service.tool === "self")
    return [
      `Grade these ${people.length} people who are already saved in Results for this role, against the role's requirements. You grade them yourself, from each person's full public profile.`,
      `First, in one step, read every person's full profile: one web_fetch per person below with maxChars ${SELF_GRADE_PAGE_CHARS}, all in parallel. Judge only from what each page shows; when a page can't be read, use the person's saved profile from recruiting_candidates.`,
      SELF_GRADE_RUBRIC,
      "Then save every person's grade with one recruiting_research save_grades call (expectedRoleRevision is the role's current revision): name and linkedin_url exactly as listed below, current title, company, location, education (each degree with school, degree and dates), match_score 0 to 100, match_tier, fit_reasons naming the evidence, concerns, and requirements_assessment with every hard requirement and every preference by name as met, not_met or unknown and the profile words that show it. Keep every grade short, since the recruiter is waiting: the evidence is the few profile words that show it, one short fit reason, a concern only for what is not met. Between the reads and the save, call nothing else. End the turn with an empty reply. Grading only: don't look for anyone new, don't contact anyone and don't ask the recruiter anything.",
      "",
      ...list,
    ].join("\n");
  if (service.tool === "agent_run")
    return [
      `Grade these ${people.length} people who are already saved in Results for this role, against the role's requirements.`,
      `Call the people-search agent run once: mcp__${service.slug}__agent_run when it is listed, otherwise connectors_execute_tool with id "${service.serverId}:agent_run". Pass effort "auto", input.data with one {name, linkedin_url} per person below, and a query that names the role and lists every hard requirement and every preference by name, asking for each person: current title, company, location, education (each degree with school, degree and dates), evidence links, match_score 0 to 100, match_tier Strong, Promising, Partial or Uncertain, fit_reasons naming the evidence, concerns, and requirements_assessment with each requirement as met, not_met or unknown and the profile text that shows it. When the role is a job opening, the query also says that match_score and match_tier grade the fit for the job as a whole: the person's current role, experience and seniority against the job description count with the listed requirements, so someone who meets a listed condition but whose current work doesn't fit the job is Partial at most, and Strong needs current work that fits the job and every hard requirement met. A list of people that is not a job opening is graded on its listed requirements alone. When the brief names reference people, the query lists each with the details that make them a fit and asks how closely every person matches them on those details; wrong-fit profiles and companies to avoid are listed the same way. A requirement the public profile does not show is unknown, never met; the job's own terms (pay, office days, benefits) are not requirements on the person and are left out; never judge ethnicity, race or background from a name or photo. The server adds the output format.`,
      "While it reports running, call it again with its runId. When it has finished, call recruiting_research save_results with providerTaskId set to the run's id, then end the turn with an empty reply. Grading only: don't look for anyone new, don't contact anyone and don't ask the recruiter anything.",
      "",
      ...list,
    ].join("\n");
  return [
    `Have the research service grade these ${people.length} people who are already saved in Results for this role: a grade and a short reason for each against the role's requirements, saved to Results like its other results.`,
    `Start new research for this with the research service's research tool: mcp__${service.slug}__research when it is listed, otherwise connectors_execute_tool with id "${service.serverId}:research". Put the request and the people below in its prompt. Don't reply on the role's earlier research.`,
    "Grading only: don't look for anyone new, don't contact anyone and don't ask the recruiter anything. Start the research and end the turn; the grades are saved when they come back.",
    "",
    ...list,
  ].join("\n");
}

/** Characters of each profile the quality check reads; the education section must fit. */
const SELF_GRADE_PAGE_CHARS = 15_000;

/** How the quality check decides each requirement, so every grade follows the same rules. */
export const SELF_GRADE_RUBRIC = [
  "How to grade each requirement:",
  "- met: the profile clearly shows it; quote its words as evidence.",
  "- not_met: the profile shows the opposite (located elsewhere, clearly fewer years, only worked at the school, a different field).",
  "- unknown: the profile is silent or too vague. Never assume, and never judge ethnicity, race or background from a name or photo: only what the profile states counts.",
  "- The job's own terms (pay range, office days or hybrid schedule, benefits) are what the job offers, not something a profile shows: leave them out of requirements_assessment, and they never lower a tier. The person's side of them still counts: a hybrid job needs someone living within a commute.",
  "- Years of experience: add up the dated roles that match the requirement, counting overlapping roles once; a stated total in the person's own summary counts too.",
  "- Location: the current location; a nearby commuting area counts.",
  "Score and tier: Strong needs every hard requirement met, and a preference never keeps anyone from Strong (note a missed one in concerns); any hard requirement not_met is Partial at most; unknown hard requirements make Promising or Uncertain, never Strong. When the role is a job opening, the score and tier grade the fit for the job as a whole: the person's current role, experience and seniority against the job description count with the listed requirements, so someone who meets a listed condition but whose current work doesn't fit the job is Partial at most. A list of people that is not a job opening is graded on its listed requirements alone. When the brief names reference people, say how closely each person matches them on those details; wrong-fit profiles and companies to avoid count against.",
].join("\n");

/** The profile links one grading request sent. */
function sentUrls(prompt: string): Set<string> {
  const urls = new Set<string>();
  for (const line of prompt.split("\n")) {
    const url = /^- .*: (https?:\/\/\S+)$/.exec(line)?.[1];
    if (url) urls.add(url);
  }
  return urls;
}

/** A person whose grade did not come back from two requests is not sent again. */
const GRADE_SEND_LIMIT = 2;

/**
 * Every person in a role gets the research service's grade, as people the research service finds
 * already do; people a quick people search found have none. Once the conversation is idle (a
 * pending question card is fine), up to GRADE_BATCH people without a research grade go to the
 * conversation's research teammate in one request, newest first, through the same research tool
 * and background follow-up as any other research. When those grades are saved the next batch
 * follows. Each person is sent once.
 */
export async function startRecruitingGrading(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  payload: { threadId: string; attempt?: number },
  now = Date.now(),
): Promise<void> {
  const attempt = payload.attempt ?? 0;
  const thread = await deps.prisma.thread.findUnique({
    where: { id: payload.threadId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      groupId: true,
      activeRecruitingRole: { select: { id: true, userId: true, archivedAt: true } },
    },
  });
  const role = thread?.activeRecruitingRole;
  const skipped = (reason: string) =>
    getLogger().info("recruiting.grade.skipped", { threadId: payload.threadId, reason });
  if (!thread || !role || role.archivedAt || role.userId !== thread.userId)
    return skipped("no role");
  // The check is the grader's own work: it waits only on the grader's turns, while teammates keep
  // working in the same conversation (reliability plan S3, one lane per agent).
  const grader = await researchTeammate(deps.prisma, thread);
  const busy = await deps.prisma.run.findFirst({
    where: {
      threadId: thread.id,
      ...(grader ? { botId: grader.botId } : {}),
      status: { in: BUSY_STATUSES },
    },
    select: { id: true, trigger: true },
  });
  if (busy) {
    // The recruiter waits on a held round, so its check starts within seconds of the turn ending,
    // and the next batch starts within seconds of the batch before it (staging 11-15: half of a
    // search's 20 people were still unscored when the recruiter looked, with 30 s between batches).
    const held = (await roundUnderReview(deps.prisma, role.id, thread.id, true, now))?.held;
    const retry = held
      ? HELD_RETRY_MS
      : busy.trigger === ("recruiting_grade" satisfies RunTrigger)
        ? NEXT_BATCH_RETRY_MS
        : BUSY_RETRY_MS;
    // A held round's check keeps trying while the round waits for it (staging 11-15: it gave up
    // after six minutes behind other turns and the round was never shown).
    if (
      attempt + 1 < MAX_ATTEMPTS ||
      (held &&
        (await roundAwaitingReview(deps.prisma, { threadId: thread.id, roleId: role.id }, now)) !==
          null)
    )
      await deps.jobs.enqueue(
        laterGradingStart({ threadId: thread.id, attempt: attempt + 1 }, now + retry),
      );
    return skipped("busy");
  }
  const requests = await deps.prisma.run.findMany({
    where: { threadId: thread.id, clientNonce: { startsWith: RECRUITING_GRADE_NONCE_PREFIX } },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, task: { select: { prompt: true } } },
  });
  const research = requests.length
    ? await deps.prisma.recruitingResearchTask.findMany({
        where: { createdByRunId: { in: requests.map((request) => request.id) } },
        select: { id: true, createdByRunId: true },
      })
    : [];
  const researchByRun = new Map(research.map((task) => [task.createdByRunId, task.id]));
  // A request graded by an agent run saved its grades in its own turn.
  const savedRuns = new Set(
    requests.length
      ? (
          await deps.prisma.externalEffect.findMany({
            where: {
              runId: { in: requests.map((request) => request.id) },
              kind: "recruiting_research",
              status: "completed",
              OR: GRADE_SAVE_OPERATIONS.map((operation) => ({
                request: { path: ["operation"], equals: operation },
              })),
            },
            select: { runId: true },
          })
        ).map((effect) => effect.runId)
      : [],
  );
  const started = (id: string) => researchByRun.has(id) || savedRuns.has(id);
  // Up to GRADE_IN_FLIGHT batches at once, since one batch takes the research service about half
  // an hour; the wake that saves a batch's grades schedules the next one. A request that never
  // started research holds the next batch for half an hour, so a failing grading turn can't
  // repeat every few minutes, and this check comes back when the hold ends. The Reviewer grades
  // within its own turn, so its first turn in a row that ended unsaved is retried at once.
  // Staging 11-15: one unsaved Reviewer turn left all 19 people of a search unscored for good.
  const latest = requests[0];
  const latestAge = latest ? now - latest.createdAt.getTime() : Number.POSITIVE_INFINITY;
  const lastStarted = requests.findIndex(
    (request) => started(request.id) || now - request.createdAt.getTime() >= IN_FLIGHT_MS,
  );
  const failedInARow = lastStarted === -1 ? requests.length : lastStarted;
  if (failedInARow >= GRADE_FAILURES_STOP) return skipped("failing");
  if (
    latest &&
    !started(latest.id) &&
    latestAge < NOT_STARTED_HOLD_MS &&
    !(grader?.tool === "self" && failedInARow === 1)
  ) {
    await deps.jobs
      .enqueue(
        laterGradingStart(
          { threadId: thread.id },
          latest.createdAt.getTime() + NOT_STARTED_HOLD_MS,
        ),
      )
      .catch(() => undefined);
    return skipped("hold");
  }
  const recent = requests.flatMap((request) => {
    const task = researchByRun.get(request.id);
    return task && now - request.createdAt.getTime() < IN_FLIGHT_MS ? [task] : [];
  });
  // An agent run grades its batch within its own turn, so earlier research requests that are
  // still out never hold it up.
  if (grader?.tool === "research" && recent.length >= GRADE_IN_FLIGHT) {
    const saved = await deps.prisma.run.findMany({
      where: {
        threadId: thread.id,
        OR: recent.map((task) => ({
          clientNonce: { startsWith: `${RESEARCH_WAKE_PREFIX}${task}:` },
        })),
      },
      select: { clientNonce: true },
    });
    const done = recent.filter((task) =>
      saved.some((run) => run.clientNonce?.startsWith(`${RESEARCH_WAKE_PREFIX}${task}:`)),
    );
    if (recent.length - done.length >= GRADE_IN_FLIGHT) return skipped("in flight");
  }
  // People whose request never reached the research service are sent again. A person whose
  // request finished (or expired) without their grade is sent once more; one still waiting is not.
  const wakes = await deps.prisma.run.findMany({
    where: { threadId: thread.id, clientNonce: { startsWith: RESEARCH_WAKE_PREFIX } },
    select: { clientNonce: true },
  });
  const finished = (id: string) => {
    const task = researchByRun.get(id);
    return (
      savedRuns.has(id) ||
      (task !== undefined &&
        wakes.some((run) => run.clientNonce?.startsWith(`${RESEARCH_WAKE_PREFIX}${task}:`)))
    );
  };
  const waiting = new Set<string>();
  const sends = new Map<string, number>();
  for (const request of requests) {
    if (!started(request.id)) continue;
    const pending = !finished(request.id) && now - request.createdAt.getTime() < IN_FLIGHT_MS;
    for (const url of sentUrls(request.task?.prompt ?? "")) {
      if (pending) waiting.add(url);
      sends.set(url, (sends.get(url) ?? 0) + 1);
    }
  }
  const sent = new Set(
    [...sends].flatMap(([url, count]) => (count >= GRADE_SEND_LIMIT ? [url] : [])),
  );
  for (const url of waiting) sent.add(url);
  const [graded, found] = await Promise.all([
    // Rows the research service returned carry its grade, whatever it concluded.
    deps.prisma.recruitingCandidateOccurrence.findMany({
      where: {
        roleId: role.id,
        page: {
          effect: {
            OR: GRADE_SAVE_OPERATIONS.map((operation) => ({
              request: { path: ["operation"], equals: operation },
            })),
          },
        },
      },
      distinct: ["candidateKey"],
      select: { candidateKey: true },
    }),
    deps.prisma.recruitingCandidateOccurrence.findMany({
      where: { roleId: role.id, linkedinUrl: { not: null } },
      orderBy: [{ page: { observedAt: "desc" } }, { rowIndex: "asc" }],
      select: { candidateKey: true, name: true, linkedinUrl: true },
    }),
  ]);
  // The round the recruiter is reviewing is graded first, against what they said since the last one.
  const review = await roundUnderReview(
    deps.prisma,
    role.id,
    thread.id,
    grader?.tool === "self",
    now,
  );
  const unreviewed = new Set(
    review?.round.candidateKeys.filter((key) => !review.grades.has(key)) ?? [],
  );
  const skip = new Set(
    graded.flatMap((row) => (unreviewed.has(row.candidateKey) ? [] : [row.candidateKey])),
  );
  const people = new Map<string, { name: string; url: string }>();
  const batchSize = grader?.tool === "self" ? SELF_GRADE_BATCH : GRADE_BATCH;
  const ordered = [
    ...found.filter((row) => unreviewed.has(row.candidateKey)),
    ...found.filter((row) => !unreviewed.has(row.candidateKey)),
  ];
  const roundUrls = new Set(
    ordered.flatMap((row) =>
      unreviewed.has(row.candidateKey) && row.linkedinUrl ? [row.linkedinUrl] : [],
    ),
  );
  if (review && ![...roundUrls].some((url) => waiting.has(url) || !sent.has(url))) {
    const misfits = review.round.candidateKeys.flatMap((key) => {
      const grade = review.grades.get(key);
      return grade && grade.tier !== FIT_TIER ? [{ key, ...grade }] : [];
    });
    // A round held for the Reviewer is shown once it is checked, swapped or not: the check's end is
    // stored, so its owner's turn that shows it is the only one that may record it.
    if (review.held) {
      const latest = await deps.prisma.message.findFirst({
        where: { threadId: thread.id, role: "user" },
        orderBy: { seq: "desc" },
        select: { id: true },
      });
      const size = await askedRoundSize(deps.prisma, role.id, review.round.round, thread.id);
      const open = Math.max(0, size - (review.round.candidateKeys.length - misfits.length));
      const shownPeople = checkedRoundPeople(
        review.round.candidateKeys,
        review.grades,
        await roundReplacements(deps.prisma, role.id, open, review.since),
        size,
      );
      // fosp 11-20 (4eb42c98): "再来5个" came back with 2 while ten saved people no round had shown
      // were never graded, so none could fill a place. A short round first has those people
      // checked, once each, then shows.
      const unshown =
        shownPeople.length < size && grader?.tool === "self"
          ? await unshownUngraded(deps.prisma, role.id, found, review.since)
          : [];
      if (unshown.some((row) => waiting.has(row.linkedinUrl))) return skipped("filling round");
      // One batch per round, so a role with eighty unchecked saved people never checks them all first.
      const roundPeople = new Set(
        found.flatMap((row) =>
          review.round.candidateKeys.includes(row.candidateKey) && row.linkedinUrl
            ? [row.linkedinUrl]
            : [],
        ),
      );
      const filled = requests.some(
        (request) =>
          request.createdAt >= review.round.createdAt &&
          [...sentUrls(request.task?.prompt ?? "")].some((url) => !roundPeople.has(url)),
      );
      const fill = filled ? [] : unshown.filter((row) => !sent.has(row.linkedinUrl));
      if (fill.length) {
        for (const row of fill.slice(0, SELF_GRADE_BATCH)) {
          skip.add(row.candidateKey);
          people.set(row.candidateKey, { name: row.name || row.linkedinUrl, url: row.linkedinUrl });
        }
      } else {
        if (!review.checked && !(await markCalibrationRoundChecked(deps.prisma, review.round)))
          return skipped("round changed");
        // Once per recruiter message, so the corrected round is never corrected again on its own.
        const clientNonce = `${RECRUITING_ROUND_REVIEW_NONCE_PREFIX}${thread.id}:${latest?.id ?? review.round.id}`;
        const runId = await startLeadRun(
          deps,
          thread,
          clientNonce,
          async () => roundReviewPrompt(review.round.round, shownPeople),
          grader?.botId,
        );
        if (runId) {
          getLogger().info("recruiting.round.review", {
            runId,
            roleId: role.id,
            round: review.round.round,
            misfits: misfits.length,
          });
          return;
        }
      }
    }
  }
  // While the recruiter waits on a held round, a batch holds only that round's people: padding it
  // with the pool made the check of one regraded person take a whole batch (staging 11-15).
  const roundOnly = review?.held === true;
  for (const row of ordered) {
    if (people.size >= batchSize) break;
    if (roundOnly && !unreviewed.has(row.candidateKey)) break;
    if (!row.linkedinUrl || skip.has(row.candidateKey) || sent.has(row.linkedinUrl)) continue;
    skip.add(row.candidateKey);
    people.set(row.candidateKey, { name: row.name || row.linkedinUrl, url: row.linkedinUrl });
  }
  if (!people.size) {
    // Only a round that just finished is reported, never one from before this change.
    const lastBatch = requests.find((request) => started(request.id));
    // Grades still on their way would be missing from the report, so it waits for them.
    if (lastBatch && !waiting.size && now - lastBatch.createdAt.getTime() < IN_FLIGHT_MS)
      await reportGradedRole(deps, thread, role.id, lastBatch);
    return skipped("nobody to grade");
  }
  if (!grader) return skipped("no research teammate");
  // Staging 11-16 (9e15e896): after feedback on a shown round, a batch of other saved people
  // started while the lead was still picking the next round, and that round's check then waited
  // 2.5 minutes behind it. While the lead works on the next round, the pool waits for it, and so
  // do the shown round's own people: the recruiter has already answered that round.
  if (
    grader.tool === "self" &&
    review &&
    !review.held &&
    (await nextRoundComing(deps.prisma, thread.id, review.round.createdAt, grader.botId))
  ) {
    if (attempt + 1 < MAX_ATTEMPTS)
      await deps.jobs.enqueue(
        laterGradingStart({ threadId: thread.id, attempt: attempt + 1 }, now + BUSY_RETRY_MS),
      );
    return skipped("next round coming");
  }
  const asked = review
    ? [
        ...(await roundCriteria(deps.prisma, { roleId: role.id, spaceId: thread.spaceId })).map(
          (criterion) => criterion.statement,
        ),
        ...(
          await recruiterWordsSinceFirstRound(deps.prisma, { threadId: thread.id, roleId: role.id })
        ).map((words) => `In their words: "${words}"`),
      ]
    : [];
  const prompt = recruitingGradePrompt([...people.values()], grader, asked);
  // A retry of the same people after a request that never started research is a new request.
  const batch = createHash("sha256")
    .update([String(requests.length), ...people.keys()].join("\n"))
    .digest("hex")
    .slice(0, 24);
  const clientNonce = `${RECRUITING_GRADE_NONCE_PREFIX}${thread.id}:${batch}`;
  const runId = await deps.prisma.$transaction(async (tx) => {
    // The thread row serializes this with research wakes and other grading starts.
    const locked = await tx.thread.updateMany({
      where: { id: thread.id, spaceId: thread.spaceId },
      data: { nextEventSeq: { increment: 0 } },
    });
    if (!locked.count) return null;
    const [existing, running] = await Promise.all([
      tx.run.findFirst({ where: { spaceId: thread.spaceId, clientNonce }, select: { id: true } }),
      // Only the grader's own turn holds the check, as above: a lead turn that recorded the
      // round is still running when its check starts (staging 11-16: no retry, 4 min unchecked).
      tx.run.findFirst({
        where: { threadId: thread.id, botId: grader.botId, status: { in: BUSY_STATUSES } },
        select: { id: true },
      }),
    ]);
    if (existing || running) return null;
    const task = await tx.task.create({
      data: {
        spaceId: thread.spaceId,
        botId: grader.botId,
        threadId: thread.id,
        userId: thread.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: thread.spaceId,
        botId: grader.botId,
        threadId: thread.id,
        userId: thread.userId,
        taskId: task.id,
        status: "queued",
        trigger: "recruiting_grade" satisfies RunTrigger,
        clientNonce,
      },
    });
    return run.id;
  });
  if (!runId) return skipped("already requested");
  getLogger().info("recruiting.grade.started", { runId, roleId: role.id, people: people.size });
  // The next batch starts once this request has reached the research service; after the last
  // batch the same check finds nobody left and reports the ranked grades.
  await deps.jobs
    .enqueue(laterGradingStart({ threadId: thread.id }, now + RECRUITING_GRADE_SETTLE_MS))
    .catch(() => undefined);
  // The existing run reconciler recovers a queued run after an enqueue failure.
  await deps.jobs.enqueue(runContinueJob(runId)).catch(() => {
    getLogger().warn("recruiting grade start deferred to reconciliation");
  });
}

/** Run nonce of the ranked report after a role's grading finishes; one per last grading batch. */
export const RECRUITING_GRADE_REPORT_NONCE_PREFIX = "recruiting-grade-report:";
/** Only a scaled-out role gets the ranked report; calibration rounds are reviewed person by person. */
const GRADE_REPORT_MIN_PEOPLE = 100;
const TIERS = ["Strong", "Promising", "Partial", "Uncertain"] as const;
const REPORT_TOP = 10;

/**
 * The role's grades as Results shows them, read by the server so the message counts every
 * person: a model paging through hundreds of rows miscounts.
 */
async function gradedSummary(
  prisma: PrismaClient,
  thread: { spaceId: string; userId: string },
  roleId: string,
): Promise<{ counts: Map<string, number>; top: string[] }> {
  const actor = {
    spaceId: thread.spaceId,
    userId: thread.userId,
    email: "",
    isDeploymentOwner: false,
  };
  const counts = new Map<string, number>(TIERS.map((tier) => [tier, 0]));
  const top: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listRecruitingCandidates(prisma, actor, {
      roleId,
      sort: "score",
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) {
      const tier = item.match?.tier;
      if (tier) counts.set(tier, (counts.get(tier) ?? 0) + 1);
      if (top.length < REPORT_TOP && typeof item.match?.score === "number") {
        const role = [item.title, item.company].filter(Boolean).join(" at ");
        top.push(
          `${top.length + 1}. ${item.name ?? item.linkedinUrl ?? item.candidateKey}${role ? `, ${role}` : ""}: score ${item.match.score}${tier ? `, ${tier}` : ""} (candidateKey ${item.candidateKey})`,
        );
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { counts, top };
}

export function gradeReportPrompt(summary: { counts: Map<string, number>; top: string[] }) {
  return [
    `Every person saved for this role now has a grade. As saved in Results: ${TIERS.map((tier) => `${tier} ${summary.counts.get(tier) ?? 0}`).join(", ")}. The highest scores:`,
    ...summary.top,
    "",
    "Read each of these people's fit reasons with recruiting_candidates sources (by candidateKey), then post one short message to the recruiter: the counts above exactly as given, then these people in this order, each as name, current role, score and tier with one line from their fit reasons. Report the grades as given; never grade, rank, recount or judge anyone yourself. Do not search, grade, save or contact anyone, and ask no question. End the turn.",
  ].join("\n");
}

/**
 * When grading has nobody left to grade, the lead posts the role's people ranked by grade with
 * their reasons, once per finished grading round, in the conversation the recruiter reads.
 */
async function reportGradedRole(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  thread: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string | null;
    groupId: string | null;
  },
  roleId: string,
  lastBatch: { id: string },
): Promise<void> {
  const people = await deps.prisma.recruitingCandidate.count({ where: { roleId } });
  if (people < GRADE_REPORT_MIN_PEOPLE) return;
  const clientNonce = `${RECRUITING_GRADE_REPORT_NONCE_PREFIX}${thread.id}:${lastBatch.id}`;
  const prompt = async () => gradeReportPrompt(await gradedSummary(deps.prisma, thread, roleId));
  const runId = await startLeadRun(deps, thread, clientNonce, prompt);
  if (runId) getLogger().info("recruiting.grade.report", { runId, roleId, people });
}

/**
 * Starts one turn of the conversation's lead with this prompt, once per nonce, only while the
 * conversation is idle. Returns the run id, or null when it was already started or is busy.
 */
async function startLeadRun(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  thread: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string | null;
    groupId: string | null;
  },
  clientNonce: string,
  prompt: () => Promise<string>,
  /** The teammate whose result this is: it joins the lead's running turn instead of waiting. */
  from?: string,
): Promise<string | null> {
  const lead = thread.groupId
    ? (
        await deps.prisma.chatGroupMember.findMany({
          where: { groupId: thread.groupId },
          orderBy: { createdAt: "asc" },
          select: { botId: true, bot: { select: { name: true, spawnKey: true } } },
        })
      ).find((member) => member.bot && recruitingBotKey(member.bot) === "main")?.botId
    : thread.botId;
  if (!lead) return null;
  const started = await deps.prisma.run.findFirst({
    where: { spaceId: thread.spaceId, clientNonce },
    select: { id: true },
  });
  if (started) return null;
  const text = await prompt();
  const runId = await deps.prisma.$transaction(async (tx) => {
    const locked = await tx.thread.updateMany({
      where: { id: thread.id, spaceId: thread.spaceId },
      data: { nextEventSeq: { increment: 0 } },
    });
    if (!locked.count) return null;
    // Staging 11-16: the check ended while the lead answered "where's round 2?", and the checked
    // round waited minutes for a free moment. As a teammate's report joins the lead's running
    // turn (reliability plan S4, as Workloop steers a child's result), so does this one; a turn
    // that ends before reading it is continued with it.
    const working = from
      ? await tx.run.findFirst({
          where: { threadId: thread.id, botId: lead, status: { in: ["leased", "running"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        })
      : null;
    if (from && working) {
      if (
        await tx.message.findFirst({
          where: { threadId: thread.id, clientNonce },
          select: { id: true },
        })
      )
        return null;
      const message = await createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "bot",
        botId: from,
        blocks: [{ kind: "handoff", fromBotId: from, toBotId: lead, text }],
        clientNonce,
      });
      await tx.steeringMessage.create({
        data: { messageId: message.id, botId: lead, userId: thread.userId, runId: working.id },
      });
      return { id: working.id, steered: true };
    }
    const [existing, running] = await Promise.all([
      tx.run.findFirst({ where: { spaceId: thread.spaceId, clientNonce }, select: { id: true } }),
      tx.run.findFirst({
        where: { threadId: thread.id, status: { in: BUSY_STATUSES } },
        select: { id: true },
      }),
    ]);
    if (existing || running) return null;
    const task = await tx.task.create({
      data: {
        spaceId: thread.spaceId,
        botId: lead,
        threadId: thread.id,
        userId: thread.userId,
        prompt: text,
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: thread.spaceId,
        botId: lead,
        threadId: thread.id,
        userId: thread.userId,
        taskId: task.id,
        status: "queued",
        trigger: "recruiting_research" satisfies RunTrigger,
        clientNonce,
      },
    });
    return { id: run.id, steered: false };
  });
  if (!runId) return null;
  if (runId.steered) return runId.id;
  await deps.jobs.enqueue(runContinueJob(runId.id)).catch(() => {
    getLogger().warn("recruiting lead run deferred to reconciliation");
  });
  return runId.id;
}

export { RECRUITING_ROUND_REVIEW_NONCE_PREFIX };

/**
 * The tier the Reviewer gives only someone whose profile shows every hard requirement. Staging
 * 11-16: a checked round kept people whose profiles never showed Kafka, so only 4 of its 10 met
 * every requirement on a blind full-profile judge.
 */
const FIT_TIER = "Strong";

type RoundGrade = {
  name: string | null;
  title: string | null;
  company: string | null;
  tier: unknown;
};

/**
 * The latest calibration round while the recruiter has not approved it, with each of its people's
 * newest grade saved after the recruiter's feedback on the previous round, i.e. made with it.
 * fr 11-20 (e9551761): the pool kept being graded between round 1 and the feedback, so an Amazon
 * engineer graded a second before "#4 is at Amazon with no Kafka. out" counted as checked.
 */
async function roundUnderReview(
  prisma: PrismaClient,
  roleId: string,
  threadId: string,
  reviewer: boolean,
  now = Date.now(),
): Promise<{
  round: { id: string; round: number; candidateKeys: string[]; version: number; createdAt: Date };
  grades: Map<string, RoundGrade>;
  /** Not shown yet: it waits for the Reviewer's check, or for its owner to show it. */
  held: boolean;
  /** The Reviewer's grades are all in and the owner has not shown it yet. */
  checked: boolean;
  /** The recruiter's feedback on the round before: grades made since then had it. */
  since: Date | undefined;
} | null> {
  const [round, previous] = await prisma.recruitingCalibrationRound.findMany({
    where: { roleId },
    orderBy: { round: "desc" },
    take: 2,
    select: {
      id: true,
      round: true,
      candidateKeys: true,
      createdAt: true,
      approvedAt: true,
      status: true,
      statusAt: true,
      version: true,
    },
  });
  if (!round || round.approvedAt) return null;
  const status = calibrationRoundStatus(round, now);
  const feedback = previous
    ? await prisma.message.findFirst({
        where: { threadId, role: "user", createdAt: { gt: previous.createdAt } },
        orderBy: { seq: "asc" },
        select: { createdAt: true },
      })
    : null;
  const since = feedback?.createdAt ?? previous?.createdAt;
  const held = reviewer && status !== "shown";
  const rows = await prisma.recruitingCandidateOccurrence.findMany({
    where: {
      roleId,
      candidateKey: { in: round.candidateKeys },
      page: {
        ...(since ? { observedAt: { gt: since } } : {}),
        effect: {
          OR: GRADE_SAVE_OPERATIONS.map((operation) => ({
            request: { path: ["operation"], equals: operation },
          })),
        },
      },
    },
    orderBy: [{ page: { observedAt: "desc" } }, { rowIndex: "asc" }],
    select: {
      candidateKey: true,
      name: true,
      title: true,
      company: true,
      matchFields: true,
    },
  });
  const grades = new Map<string, RoundGrade>();
  for (const row of rows)
    if (!grades.has(row.candidateKey))
      grades.set(row.candidateKey, {
        name: row.name,
        title: row.title,
        company: row.company,
        tier: (row.matchFields as { match_tier?: unknown } | null)?.match_tier,
      });
  return { round, grades, held, checked: held && status === "checked", since };
}

/** The recruiter wrote since the shown round and a teammate's turn is working on it. */
async function nextRoundComing(
  prisma: PrismaClient,
  threadId: string,
  shownAt: Date,
  graderBotId: string,
): Promise<boolean> {
  const [said, working] = await Promise.all([
    prisma.message.findFirst({
      where: { threadId, role: "user", createdAt: { gt: shownAt } },
      select: { id: true },
    }),
    prisma.run.findFirst({
      where: { threadId, botId: { not: graderBotId }, status: { in: BUSY_STATUSES } },
      select: { id: true },
    }),
  ]);
  return Boolean(said && working);
}

export type RoundState = {
  id: string;
  round: number;
  status: CalibrationRoundStatus;
  ownerBotId: string | null;
  version: number;
  candidateKeys: string[];
};

/**
 * The role's latest calibration round and its stored state, while the recruiter has not approved
 * the calibration. A round after feedback is held (checking) until the Reviewer has graded it
 * (checked), and only its owner shows it.
 */
export async function roundState(
  prisma: PrismaClient,
  roleId: string,
  now = Date.now(),
): Promise<RoundState | null> {
  const latest = await prisma.recruitingCalibrationRound.findFirst({
    where: { roleId },
    orderBy: { round: "desc" },
    select: {
      id: true,
      round: true,
      candidateKeys: true,
      approvedAt: true,
      status: true,
      statusAt: true,
      ownerBotId: true,
      version: true,
    },
  });
  if (!latest || latest.approvedAt) return null;
  return {
    id: latest.id,
    round: latest.round,
    status: calibrationRoundStatus(latest, now),
    ownerBotId: latest.ownerBotId,
    version: latest.version,
    candidateKeys: latest.candidateKeys,
  };
}

/**
 * Whether the round this run would record waits for the Reviewer: a shown round exists, so the
 * next one follows feedback, and the team has the Reviewer. Nothing of such a round is shown in
 * chat before the check.
 */
export async function nextRoundHeld(
  prisma: PrismaClient,
  input: { threadId: string; roleId: string },
): Promise<boolean> {
  return (
    (await roundState(prisma, input.roleId))?.status === "shown" &&
    (await hasRoundReviewer(prisma, input.threadId))
  );
}

/**
 * Whether a round this run lists must stay out of chat: it would be held for the check, or the
 * round before it is still unshown, so recording it is refused. Staging 11-16: six such refused
 * attempts streamed their lists, and the recruiter saw the same people again and again.
 */
export async function roundListHeld(
  prisma: PrismaClient,
  input: { threadId: string; roleId: string },
): Promise<boolean> {
  const state = await roundState(prisma, input.roleId);
  if (state && state.status !== "shown") return true;
  return !!state && (await hasRoundReviewer(prisma, input.threadId));
}

/**
 * The round waiting for the Reviewer's check right now, if any. Staging 11-15: asked "where's the
 * rest of the round?" while round 2 was held, Kruit listed eight unchecked people from Results and
 * then said only two were in the round.
 */
export async function roundAwaitingReview(
  prisma: PrismaClient,
  input: { threadId: string; roleId: string },
  now = Date.now(),
): Promise<number | null> {
  const state = await roundState(prisma, input.roleId, now);
  return state && state.status !== "shown" ? state.round : null;
}

/** Whether this conversation's team has the Reviewer, who checks a held round. */
export async function hasRoundReviewer(prisma: PrismaClient, threadId: string): Promise<boolean> {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { spaceId: true, userId: true, botId: true, groupId: true },
  });
  return !!thread && (await researchTeammate(prisma, thread))?.tool === "self";
}

/** The lead's turn that shows a held round once the Reviewer has checked it, swapping misfits first. */
type Replacement = {
  key: string;
  tier: string;
  name: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
};

/** Grade rows saved after `since` (all of them without it): only these had the recruiter's feedback. */
function gradedSince(roleId: string, since: Date | undefined) {
  return {
    roleId,
    page: {
      ...(since ? { observedAt: { gt: since } } : {}),
      effect: {
        OR: GRADE_SAVE_OPERATIONS.map((operation) => ({
          request: { path: ["operation"], equals: operation },
        })),
      },
    },
  };
}

/**
 * Saved people with a profile link whom no round has shown and nobody has graded since `since`,
 * newest first. fosp 11-20: a grade from before the recruiter's feedback ("要真正做过Spark或Flink的")
 * still counted, so round 2 was filled with people checked against the JD alone.
 */
async function unshownUngraded(
  prisma: PrismaClient,
  roleId: string,
  found: readonly { candidateKey: string; name: string | null; linkedinUrl: string | null }[],
  since: Date | undefined,
): Promise<{ candidateKey: string; name: string | null; linkedinUrl: string }[]> {
  const [rounds, graded] = await Promise.all([
    prisma.recruitingCalibrationRound.findMany({
      where: { roleId },
      select: { candidateKeys: true },
    }),
    prisma.recruitingCandidateOccurrence.findMany({
      where: gradedSince(roleId, since),
      distinct: ["candidateKey"],
      select: { candidateKey: true },
    }),
  ]);
  const done = new Set([
    ...rounds.flatMap((round) => round.candidateKeys),
    ...graded.map((row) => row.candidateKey),
  ]);
  const people = new Map<
    string,
    { candidateKey: string; name: string | null; linkedinUrl: string }
  >();
  for (const row of found)
    if (row.linkedinUrl && !done.has(row.candidateKey) && !people.has(row.candidateKey))
      people.set(row.candidateKey, { ...row, linkedinUrl: row.linkedinUrl });
  return [...people.values()];
}

/**
 * Saved people no round has shown whom the Reviewer graded Strong, then Promising since `since`
 * (with the recruiter's feedback), for the lead to fill a checked round's open places. Only checked people: staging 11-16 swapped seven checked
 * Promising people for unchecked ones in a 2–3 minute turn. Promising too: Strong is rare (1–5 of
 * up to 84 saved on a branch run 2026-11-20), and with Strong only, round 2 came back with 5.
 */
async function roundReplacements(
  prisma: PrismaClient,
  roleId: string,
  open: number,
  since: Date | undefined,
): Promise<Replacement[]> {
  if (!open) return [];
  const [rounds, graded, rows] = await Promise.all([
    prisma.recruitingCalibrationRound.findMany({
      where: { roleId },
      select: { candidateKeys: true },
    }),
    prisma.recruitingCandidateOccurrence.findMany({
      where: gradedSince(roleId, since),
      orderBy: [{ page: { observedAt: "desc" } }, { rowIndex: "asc" }],
      select: { candidateKey: true, matchFields: true },
    }),
    prisma.recruitingCandidateOccurrence.findMany({
      where: { roleId, linkedinUrl: { not: null } },
      orderBy: [{ page: { observedAt: "desc" } }, { rowIndex: "asc" }],
      take: 300,
      select: { candidateKey: true, name: true, title: true, company: true, location: true },
    }),
  ]);
  const shown = new Set(rounds.flatMap((round) => round.candidateKeys));
  const tiers = new Map<string, unknown>();
  for (const row of graded)
    if (!tiers.has(row.candidateKey))
      tiers.set(row.candidateKey, (row.matchFields as { match_tier?: unknown } | null)?.match_tier);
  const people = new Map<string, Replacement>();
  for (const tier of REPLACEMENT_TIERS)
    for (const row of rows) {
      if (shown.has(row.candidateKey) || people.has(row.candidateKey)) continue;
      if (tiers.get(row.candidateKey) !== tier) continue;
      people.set(row.candidateKey, { ...row, key: row.candidateKey, tier });
    }
  return [...people.values()].slice(0, open + 5);
}

/**
 * How many people a checked round shows: the few the recruiter last asked for since the round
 * before ("再来5个"), else ten. `messages` are the recruiter's messages' blocks, newest first.
 * fosp 11-20: "再来5个" was filled to 6; capping at the recorded size instead left "the next ten"
 * rounds short when the lead recorded fewer; and reading only the newest message ("那5个出来了吗？")
 * filled a round asked as 5 to 8; "你说的7个和23个到底哪个对，再来5个" read 23 and showed ten.
 */
export function roundSize(messages: readonly unknown[]): number {
  for (const blocks of messages) {
    const text = (Array.isArray(blocks) ? (blocks as { kind?: string; text?: unknown }[]) : [])
      .flatMap((block) =>
        (block.kind === "text" || block.kind === "bot_message_received") &&
        typeof block.text === "string"
          ? [handedInRecruiterWords(block.text) ?? block.text]
          : [],
      )
      .join("\n");
    const asked = requestedPeopleTarget(text);
    if (asked) return asked < 10 ? asked : 10;
  }
  return 10;
}

/** roundSize for `round` of a role, from the recruiter's messages in `threadId` since the round before. */
export async function askedRoundSize(
  prisma: PrismaClient,
  roleId: string,
  round: number,
  threadId: string,
): Promise<number> {
  const before = await prisma.recruitingCalibrationRound.findFirst({
    where: { roleId, round: { lt: round } },
    orderBy: { round: "desc" },
    select: { createdAt: true },
  });
  const asked = await prisma.message.findMany({
    where: { threadId, role: "user", ...(before ? { createdAt: { gt: before.createdAt } } : {}) },
    orderBy: { seq: "desc" },
    take: 10,
    select: { blocks: true },
  });
  return roundSize(asked.map((message) => message.blocks));
}

/** How close a misfit the Reviewer checked is: kept in a place no Strong person can fill. */
const KEPT_MISFIT_TIERS = ["Promising", "Uncertain"];
/** Checked people from Results who may fill a round's open places, best first. */
const REPLACEMENT_TIERS = [FIT_TIER, "Promising"];

/**
 * The checked round to show, in order: the round's people who fit, then the Strong people from
 * Results in the misfits' places, then the round's Promising people, then Promising people from
 * Results, then the round's Uncertain people (never Partial) in any place still open, up to
 * `size` (roundSize). Staging 11-16 (982a0ac9): told to "keep the round's
 * other people" without being given them, the lead asked the recruiter which three to keep.
 */
export function checkedRoundPeople(
  candidateKeys: readonly string[],
  grades: ReadonlyMap<string, Pick<RoundGrade, "name" | "tier">>,
  replacements: readonly (Pick<Replacement, "key" | "name"> & { tier?: string })[] = [],
  size = 10,
): { key: string; name: string }[] {
  const misfit = (key: string) => {
    const tier = grades.get(key)?.tier;
    return tier !== undefined && tier !== FIT_TIER;
  };
  const named = (key: string, name?: string | null) => ({ key, name: name || key });
  const kept = candidateKeys.filter((key) => !misfit(key));
  const closest = (tier: string) =>
    candidateKeys
      .filter((key) => misfit(key) && grades.get(key)?.tier === tier)
      .map((key) => named(key, grades.get(key)?.name));
  const fromResults = (strong: boolean) =>
    replacements
      .filter(
        (person) =>
          !candidateKeys.includes(person.key) &&
          ((person.tier ?? FIT_TIER) === FIT_TIER) === strong,
      )
      .map((person) => named(person.key, person.name));
  const [promising, uncertain] = KEPT_MISFIT_TIERS.map(closest);
  const people = [
    ...kept.map((key) => named(key, grades.get(key)?.name)),
    ...fromResults(true),
    ...(promising ?? []),
    ...fromResults(false),
    ...(uncertain ?? []),
  ];
  return people.slice(0, size);
}

export function roundReviewPrompt(round: number, people: readonly { key: string; name: string }[]) {
  return [
    `The Reviewer has checked round ${round} from each person's full profile; the recruiter has not seen it yet. Show it now: record calibration_round with corrects: true and exactly these people, in this order:`,
    ...people.map((person, index) => `${index + 1}. ${person.name} (candidateKey ${person.key})`),
    "",
    "The Reviewer's grades stand for them: no checks, no search, and don't read Results or anyone's profile again. Recording it shows the round to the recruiter; then follow its next step. Don't mention the check or anyone replaced.",
  ].join("\n");
}

/** Who grades a batch: the quality check itself, or a teammate's search service. */
type GradingService =
  | { botId: string; tool: "self" }
  | { botId: string; slug: string; serverId: string; tool: "agent_run" | "research" };

/**
 * The conversation's grader: its quality-check teammate, else the thread's own bot or a group
 * member whose research service assignment allows the research tool, not only reads of earlier
 * research.
 */
async function researchTeammate(
  prisma: PrismaClient,
  thread: { spaceId: string; userId: string; botId: string | null; groupId: string | null },
): Promise<GradingService | null> {
  // The quality-check teammate takes grading first and grades itself from full profiles; any
  // research teammate's search grades otherwise.
  const group = thread.groupId
    ? await prisma.chatGroupMember.findMany({
        where: { groupId: thread.groupId },
        orderBy: { createdAt: "asc" },
        select: {
          botId: true,
          bot: { select: { name: true, spawnKey: true, archivedAt: true } },
        },
      })
    : [];
  const reviewer = group.find(
    (member) => member.bot && !member.bot.archivedAt && recruitingBotKey(member.bot) === "reviewer",
  );
  if (reviewer) return { botId: reviewer.botId, tool: "self" };
  const members = thread.groupId
    ? group
        .map((member, index) => ({
          id: member.botId,
          // The coordinator only talks with the recruiter: it grades only when nobody else can.
          rank: !member.bot
            ? index
            : recruitingBotKey(member.bot) === "reviewer"
              ? -1
              : recruitingBotKey(member.bot) === "main"
                ? Number.MAX_SAFE_INTEGER
                : index,
        }))
        .sort((a, b) => a.rank - b.rank)
        .map((member) => member.id)
    : thread.botId
      ? [thread.botId]
      : [];
  if (!members.length) return null;
  const assigned = await prisma.botMcpServer.findMany({
    where: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId: { in: members },
      server: {
        enabled: true,
        OR: [{ endpoint: RESEARCH_MCP }, { endpoint: { startsWith: PEOPLE_SEARCH_MCP } }],
      },
      bot: { archivedAt: null },
    },
    select: {
      botId: true,
      serverId: true,
      allowAllTools: true,
      allowedTools: true,
      server: { select: { slug: true, endpoint: true } },
    },
  });
  // A people-search agent run grades a batch in about two minutes; research takes half an hour.
  for (const tool of ["agent_run", "research"] as const)
    for (const id of members) {
      const row = assigned.find(
        (candidate) =>
          candidate.botId === id &&
          (tool === "agent_run"
            ? candidate.server.endpoint?.startsWith(PEOPLE_SEARCH_MCP)
            : candidate.server.endpoint === RESEARCH_MCP) &&
          (candidate.allowAllTools || (candidate.allowedTools as unknown[] | null)?.includes(tool)),
      );
      if (row) return { botId: row.botId, slug: row.server.slug, serverId: row.serverId, tool };
    }
  return null;
}

/** What the team does after recording a round that waits for the Reviewer. */
export const ROUND_HELD_NEXT_STEP =
  "Recorded, not shown yet: after the recruiter's feedback the Reviewer first checks each of these people's full profile against it (about three minutes), and the checked round is shown in this chat then, with the next-step card. Save the brief as after any round (one recruiting_role update with brief.fields only), then end the turn with one short line in the recruiter's language saying the checked people come in a few minutes. Don't list anyone, ask nothing and show no card.";

/** A people search after this turn recorded a held round: the check starts when the turn ends. */
export const ROUND_HELD_SEARCH_REFUSAL =
  "Not run: this turn recorded the round, and it is shown once the Reviewer has checked it, which starts when this turn ends. A request for more people (“再来5个”, “the next ten”) is answered by that round, at the number they asked, so never say another batch can't start. Save the brief if not saved yet, then end the turn with one short line saying the checked people come in a few minutes.";

/** A people search while an earlier turn's round waits for the check: that round is the answer. */
export const ROUND_AWAITING_SEARCH_REFUSAL =
  "Not run: the round is recorded and the Reviewer is checking it now; the checked round is shown in this chat as soon as the check ends, with the next-step card. A request for more people (“再来5个”, “the next ten”) is answered by that round, at the number they asked, so never say another batch can't start. End the turn with one short line in the recruiter's language saying it comes in a minute or two.";

/**
 * Why a people search must not run now, or null. Staging 11-16 (982a0ac9): the recruiter's "still
 * waiting" started a new lead turn that searched again while round 2 was being checked, and the
 * checked round was then steered into that busy turn and not shown before the recruiter gave up.
 * The owner's turn that shows a checked round may still search to fill its places.
 */
export async function heldRoundSearchRefusal(
  prisma: PrismaClient,
  input: { roleId: string | null | undefined; botId: string; recordedThisTurn: boolean },
): Promise<string | null> {
  if (input.recordedThisTurn) return ROUND_HELD_SEARCH_REFUSAL;
  if (!input.roleId) return null;
  const state = await roundState(prisma, input.roleId);
  if (!state || state.status === "shown") return null;
  if (state.status === "checked" && state.ownerBotId === input.botId) return null;
  return ROUND_AWAITING_SEARCH_REFUSAL;
}

/** The people of the round waiting for the Reviewer's check, or null when no round waits. */
export async function heldRoundPeople(
  prisma: PrismaClient,
  input: { threadId: string; roleId: string },
  now = Date.now(),
): Promise<Array<{ name: string | null; linkedinUrl: string | null }> | null> {
  if ((await roundAwaitingReview(prisma, input, now)) === null) return null;
  const round = await prisma.recruitingCalibrationRound.findFirst({
    where: { roleId: input.roleId },
    orderBy: { round: "desc" },
    select: { candidateKeys: true },
  });
  return prisma.recruitingCandidateOccurrence.findMany({
    where: { roleId: input.roleId, candidateKey: { in: round?.candidateKeys ?? [] } },
    distinct: ["candidateKey"],
    select: { name: true, linkedinUrl: true },
  });
}
