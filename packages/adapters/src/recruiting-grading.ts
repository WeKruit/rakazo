import { createHash } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { recruitingGradeStartJob, runContinueJob } from "@rakazo/adapter-kit";
import type { RunTrigger } from "@rakazo/contracts";
import { recruitingBotKey } from "@rakazo/core";
import type { CalibrationRoundStatus, PrismaClient } from "@rakazo/db";
import {
  BRIEF_CONFIRMATION_TEXT,
  calibrationRoundStatus,
  createThreadMessageInTransaction,
  listRecruitingCandidates,
  markCalibrationRoundChecked,
  RECRUITING_GRADE_NONCE_PREFIX,
  RECRUITING_ROUND_REVIEW_NONCE_PREFIX,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { sleep } from "./background-wait.js";
import { languageFindings } from "./recruiting-language.js";
import { recruiterWordsSinceFirstRound, roundCriteria } from "./recruiting-round-check.js";
import { recruitingRoundPeople } from "./turn-end-guard.js";

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
export const SELF_GRADE_BATCH = 5;
/**
 * The Reviewer's batches that run at once. One at a time, 20 people took about two minutes while
 * the recruiter waited (s45/s46 11-24: one batch of five every ~25 s); a parent agent runs its
 * subagents in parallel (Claude Code, Pi), so the check takes about one batch's time.
 */
export const SELF_GRADE_PARALLEL = 4;
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
    ? "Not run: this turn only grades the batch: judge each listed person from the saved profile in the request and save your grades with recruiting_research save_grades (or the people-search agent run then save_results with its run id, or the research request, whose grades are saved when it finishes). End the turn with an empty reply."
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

/**
 * What the search returned for someone, for the check: the Reviewer judges from this saved text and
 * opens no page (LinkedIn refused 86 of 107 page reads in s50, 11-24).
 */
function searchSnippet(
  rows: readonly { candidateKey: string; report?: unknown }[],
  key: string,
): string | undefined {
  const best = new Map<string, string>();
  for (const row of rows) {
    if (row.candidateKey !== key) continue;
    const fields = (row.report as { fields?: { label?: unknown; value?: unknown }[] } | null)
      ?.fields;
    for (const field of fields ?? []) {
      if (typeof field.label !== "string" || !(field.label in SAVED_PROFILE_FIELDS)) continue;
      const value = typeof field.value === "string" ? field.value.replace(/\s+/g, " ").trim() : "";
      if (value.length > (best.get(field.label)?.length ?? 0)) best.set(field.label, value);
    }
  }
  const parts = Object.entries(SAVED_PROFILE_FIELDS).flatMap(([label, chars]) => {
    const value = best.get(label);
    return value ? [`${label}: ${value.slice(0, chars)}`] : [];
  });
  return parts.length ? parts.join(" | ") : undefined;
}
/** The saved fields the check reads, and how much of each. */
const SAVED_PROFILE_FIELDS: Record<string, number> = {
  "Current title": 120,
  "Current company": 120,
  Location: 80,
  Snippet: 600,
  Experience: 2500,
  Education: 500,
};

export function recruitingGradePrompt(
  people: readonly { name: string; url: string; found?: string; language?: string }[],
  service: GradingService,
  requirements: readonly string[] = [],
  said: readonly string[] = [],
) {
  // The recruiter's requirements and own words come first: the grade is judged by them.
  const asked = [
    ...(requirements.length
      ? ["The role's requirements:", ...requirements.map((statement) => `* ${statement}`), ""]
      : []),
    ...(said.length
      ? [
          "What the recruiter said after the first round, word for word:",
          ...said.map((words) => `* "${words}"`),
          "",
        ]
      : []),
  ];
  const list = people.map(
    (person) =>
      `- ${person.name}: ${person.url}${person.found ? `\n  Saved profile: ${person.found}` : ""}${person.language ? `\n  The language check found: ${person.language}` : ""}`,
  );
  if (service.tool === "self")
    return [
      `Grade these ${people.length} people who are already saved in Results for this role, by the recruiter's requirements and words below. You grade them yourself, from each person's saved profile below: what the search returned for them.`,
      "",
      ...asked,
      "Judge only from the saved profiles below; open no page and search for nothing. A requirement a saved profile doesn't show is unknown.",
      SELF_GRADE_RUBRIC,
      "Then save every person's grade with one recruiting_research save_grades call (expectedRoleRevision is the role's current revision): name and linkedin_url exactly as listed below, match_score 0 to 100, match_tier, one short fit reason, a concern only for what is not met, and requirements_assessment with every hard requirement and every preference by name as met, not_met or unknown. Evidence is at most six profile words, and only for not_met or a met that isn't plain from the title; leave it empty for unknown. Leave out title, company, location and education, which Results already holds: the recruiter is waiting on this. Call nothing else. End the turn with an empty reply. Grading only: don't look for anyone new, don't contact anyone and don't ask the recruiter anything.",
      "",
      ...list,
    ].join("\n");
  if (service.tool === "agent_run")
    return [
      `Grade these ${people.length} people who are already saved in Results for this role, against the role's requirements.`,
      `Call the people-search agent run once: mcp__${service.slug}__agent_run when it is listed, otherwise connectors_execute_tool with id "${service.serverId}:agent_run". Pass effort "auto", input.data with one {name, linkedin_url} per person below, and a query that names the role and lists every hard requirement and every preference by name, asking for each person: current title, company, location, education (each degree with school, degree and dates), evidence links, match_score 0 to 100, match_tier Strong, Promising, Partial or Uncertain, fit_reasons naming the evidence, concerns, and requirements_assessment with each requirement as met, not_met or unknown and the profile text that shows it. When the role is a job opening, the query also says that match_score and match_tier grade the fit for the job as a whole: the person's current role, experience and seniority against the job description count with the listed requirements, so someone who meets a listed condition but whose current work doesn't fit the job is Partial at most, and Strong needs current work that fits the job and every hard requirement met. A list of people that is not a job opening is graded on its listed requirements alone. When the brief names reference people, the query lists each with the details that make them a fit and asks how closely every person matches them on those details; wrong-fit profiles and companies to avoid are listed the same way. A requirement the public profile does not show is unknown, never met; the job's own terms (pay, office days, benefits) are not requirements on the person and are left out; never judge ethnicity, race or background from a name or photo. The server adds the output format.`,
      "While it reports running, call it again with its runId. When it has finished, call recruiting_research save_results with providerTaskId set to the run's id, then end the turn with an empty reply. Grading only: don't look for anyone new, don't contact anyone and don't ask the recruiter anything.",
      "",
      ...asked,
      ...list,
    ].join("\n");
  return [
    `Have the research service grade these ${people.length} people who are already saved in Results for this role: a grade and a short reason for each against the role's requirements, saved to Results like its other results.`,
    `Start new research for this with the research service's research tool: mcp__${service.slug}__research when it is listed, otherwise connectors_execute_tool with id "${service.serverId}:research". Put the request and the people below in its prompt. Don't reply on the role's earlier research.`,
    "Grading only: don't look for anyone new, don't contact anyone and don't ask the recruiter anything. Start the research and end the turn; the grades are saved when they come back.",
    "",
    ...asked,
    ...list,
  ].join("\n");
}

/** How the quality check grades: by the recruiter's requirements and feedback, plus their kept rules. */
export const SELF_GRADE_RUBRIC = [
  "How to grade: the recruiter's latest words win over the requirements.",
  "- Each requirement is met, not_met or unknown by what the profile states. Never judge ethnicity, race or background from a name or photo.",
  "- Hard requirements and preferences are what the recruiter made them. Strong needs every hard requirement met; one not_met makes Partial at most; a missed preference only lowers the score.",
  "- A profile silent on a point the recruiter repeated after the first round or turned someone down for is Uncertain at most; silent on anything else, it can still be Promising.",
  "- Years: count the dated roles that match.",
  "- A required language: the language check's finding on the person's line is its status.",
  "- The job's own terms (pay, office days, benefits) are not requirements on the person.",
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
  /** The turn that recorded the held round and waits for its check within the turn. */
  owner?: { runId: string },
): Promise<{ checkedRound: string } | undefined> {
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
  const skipped = (reason: string) => {
    getLogger().info("recruiting.grade.skipped", { threadId: payload.threadId, reason });
    return undefined;
  };
  if (!thread || !role || role.archivedAt || role.userId !== thread.userId)
    return skipped("no role");
  // The check is the grader's own work: it waits only on the grader's turns, while teammates keep
  // working in the same conversation (reliability plan S3, one lane per agent).
  const grader = await researchTeammate(deps.prisma, thread);
  const busyRun = await deps.prisma.run.findFirst({
    where: {
      threadId: thread.id,
      ...(grader ? { botId: grader.botId } : {}),
      status: { in: BUSY_STATUSES },
    },
    select: { id: true, trigger: true },
  });
  // The Reviewer's own grading batches run side by side, up to SELF_GRADE_PARALLEL.
  const grading = new Set<string>();
  if (grader?.tool === "self" && busyRun?.trigger === ("recruiting_grade" satisfies RunTrigger)) {
    const [other, batches] = await Promise.all([
      deps.prisma.run.findFirst({
        where: {
          threadId: thread.id,
          botId: grader.botId,
          status: { in: BUSY_STATUSES },
          trigger: { not: "recruiting_grade" satisfies RunTrigger },
        },
        select: { id: true },
      }),
      deps.prisma.run.findMany({
        where: {
          threadId: thread.id,
          botId: grader.botId,
          status: { in: BUSY_STATUSES },
          trigger: "recruiting_grade" satisfies RunTrigger,
        },
        select: { id: true },
      }),
    ]);
    if (!other && batches.length < SELF_GRADE_PARALLEL)
      for (const batch of batches) grading.add(batch.id);
  }
  const busy = grading.size ? undefined : busyRun;
  if (busy) {
    // The recruiter waits on a held round, so its check starts within seconds of the turn ending,
    // and the next batch starts within seconds of the batch before it (staging 11-15: half of a
    // search's 20 people were still unscored when the recruiter looked, with 30 s between batches).
    const held = (await roundUnderReview(deps.prisma, role.id, true, now))?.held;
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
  // A batch still grading counts as started: its people are waiting, not failed.
  const started = (id: string) => researchByRun.has(id) || savedRuns.has(id) || grading.has(id);
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
      (!grading.has(id) &&
        task !== undefined &&
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
      select: {
        candidateKey: true,
        name: true,
        linkedinUrl: true,
        report: true,
        page: { select: { observedAt: true } },
      },
    }),
  ]);
  // The round the recruiter is reviewing is graded first, against what they said since the last one.
  const review = await roundUnderReview(
    deps.prisma,
    role.id,
    grader?.tool === "self",
    now,
    thread.id,
  );
  // fr 11-22 (6aa4c10d): a held round waited minutes on people still out in a batch of the pool
  // sent before it, which never finished. A batch from before the round doesn't hold it: those
  // people are sent again with the round's feedback.
  if (review?.held) {
    const since = review.round.createdAt;
    const fresh = new Set(
      requests.flatMap((request) =>
        request.createdAt >= since ? [...sentUrls(request.task?.prompt ?? "")] : [],
      ),
    );
    for (const request of requests) {
      if (request.createdAt >= since || !started(request.id)) continue;
      for (const url of sentUrls(request.task?.prompt ?? "")) {
        if (fresh.has(url) || !waiting.delete(url)) continue;
        if ((sends.get(url) ?? 0) < GRADE_SEND_LIMIT) sent.delete(url);
      }
    }
  }
  const unreviewed = new Set(
    review?.round.candidateKeys.filter((key) => !review.grades.has(key)) ?? [],
  );
  const skip = new Set(
    graded.flatMap((row) => (unreviewed.has(row.candidateKey) ? [] : [row.candidateKey])),
  );
  const people = new Map<
    string,
    { name: string; url: string; found?: string; language?: string }
  >();
  // The language check's finding on each person stands for the required language.
  const languages = languageFindings(
    (
      await deps.prisma.externalEffect
        .findMany({
          where: {
            spaceId: thread.spaceId,
            run: { threadId: thread.id },
            kind: "recruiting_research",
            status: "completed",
            request: { path: ["operation"], equals: "save_search" },
          },
          select: { result: true },
          orderBy: { createdAt: "asc" },
        })
        .catch(() => [])
    ).map((effect) => effect.result),
  );
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
  // fosp 11-20 (eeaf5035): people were checked while the lead searched, but not always the ones it
  // then picked, so the round still waited a minute or more for its own check. When the round's
  // checked people and people checked since the feedback already fill it, it shows now.
  // Only people checked after the recruiter's words fill it: fr 11-20 (3696a182) filled "Spark and
  // Kafka in prod" rounds with people checked a minute before that was said.
  const gradedKeys = review?.round.candidateKeys.filter((key) => review.grades.has(key)) ?? [];
  const feedbackAt = review?.held ? review.feedbackAt : undefined;
  const early =
    review?.held === true &&
    grader?.tool === "self" &&
    feedbackAt !== undefined &&
    gradedKeys.length < review.round.candidateKeys.length &&
    (await (async () => {
      const size = review.round.candidateKeys.length;
      const replacements = await roundReplacements(deps.prisma, role.id, size, feedbackAt);
      return placeable(gradedKeys, review.grades) + replacements.length >= size;
    })());
  if (review && (early || ![...roundUrls].some((url) => waiting.has(url) || !sent.has(url)))) {
    const roundKeys = early ? gradedKeys : review.round.candidateKeys;
    const misfits = roundKeys.flatMap((key) => {
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
      // The lead reads how many the recruiter asked for and recorded that many; it picks the
      // round from the round's checked people and Results' checked people, as a bare model does
      // from the same grades (fosp x5 replay 11-23: right count or asks, no repeats, 10/10).
      const size = review.round.candidateKeys.length;
      // Only as many of Results' checked people as the round has open places (plus a few), so the
      // lead weighs a short list: picking from 25 took it about 30 s more (s21, 11-23).
      const replacements = await roundReplacements(
        deps.prisma,
        role.id,
        Math.max(0, size - placeable(roundKeys, review.grades)),
        early ? feedbackAt : review.since,
        // Uncertain people too, after the fits: the lead shows them only once the recruiter loosens.
        [...REPLACEMENT_TIERS, "Uncertain"],
      );
      const fits = replacements.filter((person) => REPLACEMENT_TIERS.includes(person.tier)).length;
      // fosp 11-20 (4eb42c98): "再来5个" came back with 2 while ten saved people no round had shown
      // were never graded, so none could fill a place. A short round first has those people
      // checked, once each, then shows.
      const unshown =
        placeable(roundKeys, review.grades) + fits < size && grader?.tool === "self"
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
          people.set(row.candidateKey, {
            name: row.name || row.linkedinUrl,
            url: row.linkedinUrl,
            found: searchSnippet(found, row.candidateKey),
            language: languages.get(row.candidateKey),
          });
        }
      } else {
        if (!review.checked && !(await markCalibrationRoundChecked(deps.prisma, review.round)))
          return skipped("round changed");
        // fosp 11-22 (352978a2): a round shown by a later turn never came when that turn did not
        // start. The turn that recorded the round waits for its check and shows it itself, the
        // way a parent agent awaits its child (Claude Code subagents, Workloop); a later turn
        // starts only once that one has ended.
        const keys = [
          ...roundKeys,
          ...replacements.flatMap((person) => (roundKeys.includes(person.key) ? [] : [person.key])),
        ];
        const passages = await recruitingRoundPeople(deps.prisma, {
          threadId: thread.id,
          spaceId: thread.spaceId,
          roleId: role.id,
          candidateKeys: keys,
        });
        const replacing = new Map(replacements.map((person) => [person.key, person]));
        const prompt = roundReviewPrompt(
          review.round.round,
          size,
          keys.map((key) => {
            const grade = review.grades.get(key) ?? replacing.get(key);
            return {
              key,
              name: grade?.name || key,
              tier: typeof grade?.tier === "string" ? grade.tier : undefined,
              score: grade?.score,
              reason: passages.get(key)?.snippet ?? undefined,
              unknown: grade?.unknown,
              inRound: roundKeys.includes(key),
            };
          }),
        );
        const recorder = await deps.prisma.externalEffect.findUnique({
          where: { id: review.round.effectId },
          select: { run: { select: { id: true, status: true } } },
        });
        if (recorder?.run && ["leased", "running"].includes(recorder.run.status)) {
          if (owner?.runId === recorder.run.id) return { checkedRound: prompt };
          await deps.jobs.enqueue(
            laterGradingStart({ threadId: thread.id, attempt: attempt + 1 }, now + HELD_RETRY_MS),
          );
          return skipped("owner waiting");
        }
        // Once per recruiter message, so the corrected round is never corrected again on its own.
        const clientNonce = `${RECRUITING_ROUND_REVIEW_NONCE_PREFIX}${thread.id}:${latest?.id ?? review.round.id}`;
        const runId = await startLeadRun(
          deps,
          thread,
          clientNonce,
          async () => prompt,
          grader?.botId,
          review.round.ownerBotId,
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
    people.set(row.candidateKey, {
      name: row.name || row.linkedinUrl,
      url: row.linkedinUrl,
      found: searchSnippet(found, row.candidateKey),
      language: languages.get(row.candidateKey),
    });
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
  // do the shown round's own people: the recruiter has already answered that round. People the
  // lead's searches save after the feedback are the next round's, so they are checked as they
  // arrive: fosp 11-20 (b0334cad) sat 1.5 minutes with nothing checked while the lead searched,
  // then held the round 1.3 minutes more for the check.
  const coming =
    grader.tool === "self" &&
    review &&
    !review.held &&
    (await nextRoundComing(deps.prisma, thread.id, review.round.createdAt, grader.botId));
  if (coming) {
    const feedbackAt = await recruiterFeedbackAt(deps.prisma, thread.id, review.round.createdAt);
    const checked = new Set(graded.map((row) => row.candidateKey));
    people.clear();
    for (const row of found) {
      if (people.size >= batchSize) break;
      if (!feedbackAt || !(row.page?.observedAt > feedbackAt)) continue;
      if (!row.linkedinUrl || checked.has(row.candidateKey) || sent.has(row.linkedinUrl)) continue;
      people.set(row.candidateKey, {
        name: row.name || row.linkedinUrl,
        url: row.linkedinUrl,
        found: searchSnippet(found, row.candidateKey),
        language: languages.get(row.candidateKey),
      });
    }
  }
  if (coming && !people.size) {
    if (attempt + 1 < MAX_ATTEMPTS)
      await deps.jobs.enqueue(
        laterGradingStart({ threadId: thread.id, attempt: attempt + 1 }, now + BUSY_RETRY_MS),
      );
    return skipped("next round coming");
  }
  const [criteria, said] = await Promise.all([
    roundCriteria(deps.prisma, { roleId: role.id, spaceId: thread.spaceId }),
    recruiterWordsSinceFirstRound(deps.prisma, { threadId: thread.id, roleId: role.id }),
  ]);
  const prompt = recruitingGradePrompt(
    [...people.values()],
    grader,
    criteria.map((criterion) => criterion.statement),
    said,
  );
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
      tx.run.findMany({
        where: { threadId: thread.id, botId: grader.botId, status: { in: BUSY_STATUSES } },
        select: { trigger: true },
      }),
    ]);
    // Only the Reviewer's own batches run beside each other, never beside its other turns.
    const others = running.some((run) => run.trigger !== ("recruiting_grade" satisfies RunTrigger));
    if (existing || others || running.length >= (grader.tool === "self" ? SELF_GRADE_PARALLEL : 1))
      return null;
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
  /**
   * The bot that recorded the round, the only one that may show it. fosp 11-21 (9082bb56): "再来5个"
   * reached the Sourcer, which recorded round 3; its check went to Main, whose show was refused as
   * not the round's owner, and the checked round was never shown.
   */
  owner?: string | null,
): Promise<string | null> {
  const lead = owner
    ? owner
    : thread.groupId
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
  score?: number;
  /** Requirements the person's profile says nothing about. */
  unknown?: string[];
};

/**
 * The latest calibration round while the recruiter has not approved it, with each of its people's
 * newest grade saved after the previous round was recorded, i.e. made with their feedback.
 */
async function roundUnderReview(
  prisma: PrismaClient,
  roleId: string,
  reviewer: boolean,
  now = Date.now(),
  threadId?: string,
): Promise<{
  round: {
    id: string;
    round: number;
    candidateKeys: string[];
    version: number;
    createdAt: Date;
    ownerBotId: string | null;
    effectId: string;
  };
  grades: Map<string, RoundGrade>;
  /** Not shown yet: it waits for the Reviewer's check, or for its owner to show it. */
  held: boolean;
  /** The Reviewer's grades are all in and the owner has not shown it yet. */
  checked: boolean;
  /**
   * When the recruiter first wrote after the round before (else when it was recorded): grades
   * made since then had their feedback.
   */
  since: Date | undefined;
  /** When the recruiter first wrote after the round before, if they have. */
  feedbackAt: Date | undefined;
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
      ownerBotId: true,
      effectId: true,
    },
  });
  if (!round || round.approvedAt) return null;
  const status = calibrationRoundStatus(round, now);
  const held = reviewer && status !== "shown";
  const feedbackAt =
    previous && threadId
      ? await recruiterFeedbackAt(prisma, threadId, previous.createdAt)
      : undefined;
  const since = feedbackAt ?? previous?.createdAt;
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
        tier: placeTier(row.matchFields),
        score: gradeScore(row.matchFields),
        unknown: gradeUnknown(row.matchFields),
      });
  return { round, grades, held, checked: held && status === "checked", since, feedbackAt };
}

/**
 * When the recruiter first wrote in the role's conversation after `after`, leaving out the brief
 * confirmation posted as theirs. fr 11-21 (8ef94139): that confirmation came right after round 1,
 * so people checked before the feedback ("no staff, no AWS infra") counted as checked with it,
 * and round 2 was shown 30 s later with a Principal and five AWS people.
 */
async function recruiterFeedbackAt(
  prisma: PrismaClient,
  threadId: string,
  after: Date,
): Promise<Date | undefined> {
  const said = await prisma.message.findMany({
    where: { threadId, role: "user", createdAt: { gt: after } },
    orderBy: { seq: "asc" },
    take: 5,
    select: { createdAt: true, blocks: true },
  });
  return said.find(
    (message) =>
      !(Array.isArray(message.blocks) ? message.blocks : []).every((block) =>
        BRIEF_CONFIRMATION_TEXT.test(String((block as { text?: unknown } | null)?.text ?? "")),
      ),
  )?.createdAt;
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
 * Whether the round this run would record waits for the Reviewer: no round is waiting already, and
 * the team has the Reviewer. Nothing of such a round is shown in chat before the check.
 */
export async function nextRoundHeld(
  prisma: PrismaClient,
  input: { threadId: string; roleId: string },
): Promise<boolean> {
  // The first ten too: the playbook shows ten people the Reviewer passed (fr 11-24: round 1 was
  // shown before its check and listed a recent graduate and someone with no Kafka).
  const state = await roundState(prisma, input.roleId);
  return (!state || state.status === "shown") && (await hasRoundReviewer(prisma, input.threadId));
}

/**
 * Whether a checked round the lead records again holds people the Reviewer has not checked since
 * the recruiter's feedback: the top-up search's people. The round is then held once more and the
 * same turn waits for their check, so only the Reviewer judges who is shown (the approved loop,
 * 11-24: s45/s46 shown top-ups were graded by the search alone).
 */
export async function correctionNeedsCheck(
  prisma: PrismaClient,
  input: { threadId: string; roleId: string; candidateKeys: readonly string[] },
): Promise<boolean> {
  const state = await roundState(prisma, input.roleId);
  if (state?.status !== "checked" || !(await hasRoundReviewer(prisma, input.threadId)))
    return false;
  const review = await roundUnderReview(prisma, input.roleId, true, Date.now(), input.threadId);
  if (!review) return false;
  const graded = await prisma.recruitingCandidateOccurrence.findMany({
    where: {
      roleId: input.roleId,
      candidateKey: { in: [...input.candidateKeys] },
      page: {
        ...(review.since ? { observedAt: { gt: review.since } } : {}),
        effect: {
          OR: GRADE_SAVE_OPERATIONS.map((operation) => ({
            request: { path: ["operation"], equals: operation },
          })),
        },
      },
    },
    distinct: ["candidateKey"],
    select: { candidateKey: true },
  });
  const checked = new Set(graded.map((row) => row.candidateKey));
  return input.candidateKeys.some((key) => !checked.has(key));
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
  return hasRoundReviewer(prisma, input.threadId);
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
  score?: number;
  unknown?: string[];
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
  usable: readonly string[] = REPLACEMENT_TIERS,
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
  const fields = new Map<string, unknown>();
  for (const row of graded)
    if (!tiers.has(row.candidateKey)) {
      tiers.set(row.candidateKey, placeTier(row.matchFields));
      fields.set(row.candidateKey, row.matchFields);
    }
  const people = new Map<string, Replacement>();
  for (const tier of usable)
    for (const row of rows) {
      if (shown.has(row.candidateKey) || people.has(row.candidateKey)) continue;
      if (tiers.get(row.candidateKey) !== tier) continue;
      const grade = fields.get(row.candidateKey);
      people.set(row.candidateKey, {
        ...row,
        key: row.candidateKey,
        tier,
        score: gradeScore(grade),
        unknown: gradeUnknown(grade),
      });
    }
  return [...people.values()].slice(0, open + 5);
}

function gradeScore(fields: unknown): number | undefined {
  const score = (fields as { match_score?: unknown } | null)?.match_score;
  return typeof score === "number" ? score : undefined;
}

function gradeUnknown(fields: unknown): string[] | undefined {
  const unknown = (fields as { unknown?: unknown } | null)?.unknown;
  return Array.isArray(unknown) ? unknown.filter((item) => typeof item === "string") : undefined;
}

/** A saved grade's tier. */
function placeTier(fields: unknown): unknown {
  return (fields as { match_tier?: unknown } | null)?.match_tier;
}

/** Checked people from Results who may fill a round's open places, best first. */
const REPLACEMENT_TIERS = [FIT_TIER, "Promising"];
/**
 * How many of a round's checked people the check left fit to show: Strong or Promising. The
 * recruiter deleted filling a round with Uncertain people (11-22): a short round asks instead.
 */
function placeable(
  keys: readonly string[],
  grades: ReadonlyMap<string, Pick<RoundGrade, "tier">>,
): number {
  return keys.filter((key) => {
    const tier = grades.get(key)?.tier;
    return typeof tier === "string" && REPLACEMENT_TIERS.includes(tier);
  }).length;
}

type CheckedPerson = {
  key: string;
  name: string;
  tier?: string;
  score?: number;
  reason?: string;
  unknown?: readonly string[];
  /** In the round the lead recorded, rather than another checked person from Results. */
  inRound: boolean;
};

/**
 * The checked round handed back to the lead, which picks whom to show from the Reviewer's grades
 * itself. `size` is how many it recorded, i.e. read from the recruiter's words.
 */
export function roundReviewPrompt(round: number, size: number, people: readonly CheckedPerson[]) {
  const line = (person: CheckedPerson) => {
    const grade = [person.tier, person.score].filter((part) => part !== undefined).join(" ");
    const unknown = person.unknown?.length
      ? ` Profile doesn't show: ${person.unknown.join("; ")}.`
      : "";
    return `- ${person.name} (candidateKey ${person.key})${person.inRound ? " [in the round]" : ""}: ${grade || "not graded"}.${person.reason ? ` ${person.reason.replace(/\s+/g, " ").trim()}` : ""}${unknown}`;
  };
  return [
    `The Reviewer has checked round ${round}; the recruiter has not seen it yet. Show it now: record calibration_round with corrects: true and the people you pick from the checked people below, best first.`,
    round === 1
      ? // The first ten come straight from the JD (the recruiter's rule 11-22): checked people who
        // miss no hard requirement, those the profile can't confirm marked with what it doesn't show.
        `Pick as many as the recruiter asked for (you recorded ${size}), best grade first: Strong, Promising, then Uncertain, each Uncertain with what their profile doesn't show; never someone graded Partial.`
      : `Pick as many as the recruiter asked for this round (you recorded ${size}), best grade first, the round's own people before others of the same grade. Show only people graded Strong or Promising, unless the recruiter has said to loosen or accept less: then Uncertain too, each with what their profile doesn't show.`,
    "If fewer fit than asked, follow your short-round rule from where your work.md note says this request stands: the Reviewer checks the new people in the same turn when you record the round again.",
    // The recruiter's rule 11-22: a requirement profiles can't show is asked about, not hidden.
    // s38 11-24: the lead asked with a card instead of recording, and the checked round was never shown.
    "When most of your picks' profiles don't show the same requirement, record the round first, then ask in one line in the same reply whether people whose profile doesn't show it should still count, unless you already asked in this conversation.",
    "",
    ...people.map(line),
    "",
    "The Reviewer's grades stand for them: no checks, no search beyond your short-round rule, and don't read Results or anyone's profile again. Recording it shows the round to the recruiter; then follow its next step. Don't mention the check or anyone replaced.",
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

/** How long the turn that recorded a held round waits for its check before ending without it. */
export const ROUND_CHECK_WAIT_MS = 4 * 60_000;
const ROUND_CHECK_POLL_MS = 3_000;

/**
 * Waits, within the turn that recorded a held round, for the Reviewer's check of it, and returns
 * the checked round for that turn to show. Undefined when the wait ends first (a new message, the
 * turn stopping, or the time limit): the check then goes on and a later turn shows the round.
 */
export async function waitForRoundCheck(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  input: {
    threadId: string;
    runId: string;
    signal: AbortSignal;
    timeoutMs?: number;
    pollMs?: number;
    userMessageWaiting?: () => Promise<boolean>;
  },
): Promise<string | undefined> {
  const deadline = Date.now() + (input.timeoutMs ?? ROUND_CHECK_WAIT_MS);
  for (;;) {
    const result = await startRecruitingGrading(deps, { threadId: input.threadId }, Date.now(), {
      runId: input.runId,
    });
    if (result?.checkedRound) return result.checkedRound;
    if (
      Date.now() >= deadline ||
      input.signal.aborted ||
      (await input.userMessageWaiting?.().catch(() => false))
    )
      return undefined;
    await sleep(Math.min(input.pollMs ?? ROUND_CHECK_POLL_MS, deadline - Date.now()), input.signal);
  }
}
