import { createHash } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { recruitingGradeStartJob, runContinueJob } from "@rakazo/adapter-kit";
import type { RunTrigger } from "@rakazo/contracts";
import { recruitingBotKey } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { listRecruitingCandidates, RECRUITING_GRADE_NONCE_PREFIX } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export { RECRUITING_GRADE_NONCE_PREFIX };
/** Newly saved searches settle this long before grading starts, so one request covers them. */
export const RECRUITING_GRADE_SETTLE_MS = 30_000;
/** A busy conversation is checked again this often, for at most this many tries (about 1 hour). */
const BUSY_RETRY_MS = 30_000;
const MAX_ATTEMPTS = 120;
/** People per grading request. */
export const GRADE_BATCH = 50;
/** Grading requests the research service works on at once for one conversation. */
export const GRADE_IN_FLIGHT = 4;
/** A grading request whose grades never came back stops holding up the next batch after this. */
const IN_FLIGHT_MS = 2 * 60 * 60_000;
/** After a grading request that never started research, the next batch waits this long. */
const NOT_STARTED_HOLD_MS = 30 * 60_000;
const RESEARCH_MCP = "https://api.autumn.ai/mcp";
const PEOPLE_SEARCH_MCP = "https://mcp.exa.ai/";
const RESEARCH_WAKE_PREFIX = "recruiting-research-wake:";
const BUSY_STATUSES = ["queued", "leased", "running"];

/** Queue (or push back) the grading start for a conversation whose search just saved people. */
export async function scheduleRecruitingGrading(
  jobs: Pick<JobPublisher, "enqueue">,
  threadId: string,
  now = Date.now(),
): Promise<void> {
  await jobs.enqueue(
    recruitingGradeStartJob({ threadId }, new Date(now + RECRUITING_GRADE_SETTLE_MS)),
  );
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
const GRADING_RESEARCH_OPERATIONS = new Set(["status", "rows", "save_results"]);
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
    ? "Not run: this turn only grades the batch: the people-search agent run, then recruiting_research save_results with its run id (or the research request, whose grades are saved when it finishes). End the turn with an empty reply."
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
  service: { slug: string; serverId: string; tool: "agent_run" | "research" },
) {
  const list = people.map((person) => `- ${person.name}: ${person.url}`);
  if (service.tool === "agent_run")
    return [
      `Grade these ${people.length} people who are already saved in Results for this role, against the role's requirements.`,
      `Call the people-search agent run once: mcp__${service.slug}__agent_run when it is listed, otherwise connectors_execute_tool with id "${service.serverId}:agent_run". Pass effort "auto", input.data with one {name, linkedin_url} per person below, and a query that names the role and lists every hard requirement and every preference by name, asking for each person: current title, company, location, education (each degree with school, degree and dates), evidence links, match_score 0 to 100, match_tier Strong, Promising, Partial or Uncertain, fit_reasons naming the evidence, concerns, and requirements_assessment with each requirement as met, not_met or unknown and the profile text that shows it. When the role is a job opening, the query also says that match_score and match_tier grade the fit for the job as a whole: the person's current role, experience and seniority against the job description count with the listed requirements, so someone who meets a listed condition but whose current work doesn't fit the job is Partial at most, and Strong needs current work that fits the job and every hard requirement met. A list of people that is not a job opening is graded on its listed requirements alone. When the brief names reference people, the query lists each with the details that make them a fit and asks how closely every person matches them on those details; wrong-fit profiles and companies to avoid are listed the same way. A requirement the public profile does not show is unknown, never met; never judge ethnicity, race or background from a name or photo. The server adds the output format.`,
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
  const busy = await deps.prisma.run.findFirst({
    where: { threadId: thread.id, status: { in: BUSY_STATUSES } },
    select: { id: true },
  });
  if (busy) {
    if (attempt + 1 < MAX_ATTEMPTS)
      await deps.jobs.enqueue(
        laterGradingStart({ threadId: thread.id, attempt: attempt + 1 }, now + BUSY_RETRY_MS),
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
              request: { path: ["operation"], equals: "save_results" },
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
  // repeat every few minutes.
  const latest = requests[0];
  const latestAge = latest ? now - latest.createdAt.getTime() : Number.POSITIVE_INFINITY;
  if (latest && !started(latest.id) && latestAge < NOT_STARTED_HOLD_MS) return skipped("hold");
  const recent = requests.flatMap((request) => {
    const task = researchByRun.get(request.id);
    return task && now - request.createdAt.getTime() < IN_FLIGHT_MS ? [task] : [];
  });
  // An agent run grades its batch within its own turn, so earlier research requests that are
  // still out never hold it up.
  const grader = await researchTeammate(deps.prisma, thread);
  if (grader?.tool !== "agent_run" && recent.length >= GRADE_IN_FLIGHT) {
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
        page: { effect: { request: { path: ["operation"], equals: "save_results" } } },
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
  const skip = new Set(graded.map((row) => row.candidateKey));
  const people = new Map<string, { name: string; url: string }>();
  for (const row of found) {
    if (people.size >= GRADE_BATCH) break;
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
  const prompt = recruitingGradePrompt([...people.values()], grader);
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
      tx.run.findFirst({
        where: { threadId: thread.id, status: { in: BUSY_STATUSES } },
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
  const lead = thread.groupId
    ? (
        await deps.prisma.chatGroupMember.findMany({
          where: { groupId: thread.groupId },
          orderBy: { createdAt: "asc" },
          select: { botId: true, bot: { select: { name: true, spawnKey: true } } },
        })
      ).find((member) => member.bot && recruitingBotKey(member.bot) === "main")?.botId
    : thread.botId;
  if (!lead) return;
  const clientNonce = `${RECRUITING_GRADE_REPORT_NONCE_PREFIX}${thread.id}:${lastBatch.id}`;
  const reported = await deps.prisma.run.findFirst({
    where: { spaceId: thread.spaceId, clientNonce },
    select: { id: true },
  });
  if (reported) return;
  const prompt = gradeReportPrompt(await gradedSummary(deps.prisma, thread, roleId));
  const runId = await deps.prisma.$transaction(async (tx) => {
    const locked = await tx.thread.updateMany({
      where: { id: thread.id, spaceId: thread.spaceId },
      data: { nextEventSeq: { increment: 0 } },
    });
    if (!locked.count) return null;
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
        prompt,
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
    return run.id;
  });
  if (!runId) return;
  getLogger().info("recruiting.grade.report", { runId, roleId, people });
  await deps.jobs.enqueue(runContinueJob(runId)).catch(() => {
    getLogger().warn("recruiting grade report deferred to reconciliation");
  });
}

/**
 * The conversation's bot that may start research: the thread's own bot or a group member whose
 * research service assignment allows the research tool, not only reads of earlier research.
 */
async function researchTeammate(
  prisma: PrismaClient,
  thread: { spaceId: string; userId: string; botId: string | null; groupId: string | null },
): Promise<{
  botId: string;
  slug: string;
  serverId: string;
  tool: "agent_run" | "research";
} | null> {
  // The quality-check teammate takes grading first; any research teammate otherwise.
  const members = thread.groupId
    ? (
        await prisma.chatGroupMember.findMany({
          where: { groupId: thread.groupId },
          orderBy: { createdAt: "asc" },
          select: { botId: true, bot: { select: { name: true, spawnKey: true } } },
        })
      )
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
