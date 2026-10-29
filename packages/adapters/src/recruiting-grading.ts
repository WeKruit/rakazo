import { createHash } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { recruitingGradeStartJob, runContinueJob } from "@rakazo/adapter-kit";
import type { RunTrigger } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** Nonce prefix of the run that hands a conversation's newly found people to the research service. */
export const RECRUITING_GRADE_NONCE_PREFIX = "recruiting-grade:";
/** Newly saved searches settle this long before grading starts, so one request covers them. */
export const RECRUITING_GRADE_SETTLE_MS = 30_000;
/** A busy conversation is checked again this often, for at most this many tries (about 1 hour). */
const BUSY_RETRY_MS = 30_000;
const MAX_ATTEMPTS = 120;
/** People per grading request. */
export const GRADE_BATCH = 50;
/** A grading request whose grades never came back stops holding up the next batch after this. */
const IN_FLIGHT_MS = 2 * 60 * 60_000;
const RESEARCH_MCP = "https://api.autumn.ai/mcp";
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
const GRADING_PROVIDER_TOOL = /^mcp__.+__(research|get_task|get_rows|credits)$/;

/**
 * Why a grading turn may not call this tool, or undefined when it may. A grading turn only grades
 * people already in Results: it never changes the role, its brief or stage, the people's status,
 * or messages anyone, whatever the model decides.
 */
export function gradingToolRefusal(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  const allowed =
    GRADING_BUILTIN_TOOLS.has(name) ||
    (name === "recruiting_research" && GRADING_RESEARCH_OPERATIONS.has(String(args.operation))) ||
    (GRADING_PROVIDER_TOOL.test(name) && args.task_id === undefined) ||
    (GRADING_PROVIDER_TOOL.test(name) && /__(get_task|get_rows)$/.test(name));
  return allowed
    ? undefined
    : "Not run: this turn only grades people already in Results. Start the grading research, or read and save its rows with recruiting_research save_results; nothing else.";
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

export function recruitingGradePrompt(people: readonly { name: string; url: string }[]) {
  return [
    `Have the research service grade these ${people.length} people who are already saved in Results for this role: a grade and a short reason for each against the role's requirements, saved to Results like its other results.`,
    "Grading only: don't look for anyone new, don't contact anyone and don't ask the recruiter anything. Start the research and end the turn; the grades are saved when they come back.",
    "",
    ...people.map((person) => `- ${person.name}: ${person.url}`),
  ].join("\n");
}

/** The profile links an earlier grading request already sent, so nobody is sent twice. */
function sentUrls(prompts: readonly string[]): Set<string> {
  const urls = new Set<string>();
  for (const prompt of prompts)
    for (const line of prompt.split("\n")) {
      const url = /^- .*: (https?:\/\/\S+)$/.exec(line)?.[1];
      if (url) urls.add(url);
    }
  return urls;
}

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
  if (!thread || !role || role.archivedAt || role.userId !== thread.userId) return;
  const busy = await deps.prisma.run.findFirst({
    where: { threadId: thread.id, status: { in: BUSY_STATUSES } },
    select: { id: true },
  });
  if (busy) {
    if (attempt + 1 < MAX_ATTEMPTS)
      await deps.jobs.enqueue(
        recruitingGradeStartJob(
          { threadId: thread.id, attempt: attempt + 1 },
          new Date(now + BUSY_RETRY_MS),
        ),
      );
    return;
  }
  const requests = await deps.prisma.run.findMany({
    where: { threadId: thread.id, clientNonce: { startsWith: RECRUITING_GRADE_NONCE_PREFIX } },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, task: { select: { prompt: true } } },
  });
  // One batch at a time: the wake that saves a batch's grades schedules the next one.
  const latest = requests[0];
  if (latest && now - latest.createdAt.getTime() < IN_FLIGHT_MS) {
    const research = await deps.prisma.recruitingResearchTask.findFirst({
      where: { createdByRunId: latest.id },
      select: { id: true },
    });
    const saved =
      research &&
      (await deps.prisma.run.findFirst({
        where: {
          threadId: thread.id,
          clientNonce: { startsWith: `${RESEARCH_WAKE_PREFIX}${research.id}:` },
        },
        select: { id: true },
      }));
    if (research && !saved) return;
  }
  const sent = sentUrls(requests.map((request) => request.task?.prompt ?? ""));
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
  if (!people.size) return;
  const grader = await researchTeammate(deps.prisma, thread);
  if (!grader) return;
  const prompt = recruitingGradePrompt([...people.values()]);
  const batch = createHash("sha256")
    .update([...people.keys()].join("\n"))
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
        botId: grader,
        threadId: thread.id,
        userId: thread.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: thread.spaceId,
        botId: grader,
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
  if (!runId) return;
  getLogger().info("recruiting.grade.started", { runId, roleId: role.id, people: people.size });
  // The existing run reconciler recovers a queued run after an enqueue failure.
  await deps.jobs.enqueue(runContinueJob(runId)).catch(() => {
    getLogger().warn("recruiting grade start deferred to reconciliation");
  });
}

/** The conversation's bot assigned the research service: the thread's own bot or a group member. */
async function researchTeammate(
  prisma: PrismaClient,
  thread: { spaceId: string; userId: string; botId: string | null; groupId: string | null },
): Promise<string | null> {
  const members = thread.groupId
    ? (
        await prisma.chatGroupMember.findMany({
          where: { groupId: thread.groupId },
          orderBy: { createdAt: "asc" },
          select: { botId: true },
        })
      ).map((member) => member.botId)
    : thread.botId
      ? [thread.botId]
      : [];
  if (!members.length) return null;
  const assigned = await prisma.botMcpServer.findMany({
    where: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId: { in: members },
      server: { endpoint: RESEARCH_MCP, enabled: true },
      bot: { archivedAt: null },
    },
    select: { botId: true },
  });
  const ids = new Set(assigned.map((row) => row.botId));
  return members.find((id) => ids.has(id)) ?? null;
}
