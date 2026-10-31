import type { BackgroundWorkTiming, MessageBlock } from "@rakazo/contracts";
import { recruitingBotKey } from "./recruiting-defaults.js";
import { hideVendorNames } from "./vendor-names.js";

/**
 * What an agent is doing, in categories every client can word for people. Derived only
 * from closed native tool names, never from tool arguments, ids or free progress text.
 */
export type WorkActivity =
  | "files"
  | "search"
  | "page"
  | "context"
  | "memory"
  | "connections"
  | "connected_action"
  | "emails"
  | "availability"
  | "drafting"
  | "role"
  | "candidates"
  | "research"
  | "feedback"
  | "crm"
  | "question"
  | "specialist"
  | "working";

const BUILTIN_ACTIVITIES: Record<string, WorkActivity> = {
  read_file: "files",
  list_files: "files",
  artifact_read: "files",
  web_search: "search",
  web_fetch: "page",
  browser_navigate: "page",
  browser_snapshot: "page",
  skill_read: "context",
  read_memory: "context",
  read_history: "context",
  search_history: "context",
  recall_memory: "context",
  remember: "memory",
  save_memory: "memory",
  save_shared_memory: "memory",
  save_group_memory: "memory",
  mcp_list_tools: "connections",
  mcp_search: "connections",
  mcp_execute_tool: "connected_action",
  connectors_execute_tool: "connected_action",
  recruiting_role: "role",
  recruiting_candidates: "candidates",
  recruiting_shortlist: "candidates",
  recruiting_assess: "candidates",
  recruiting_research: "research",
  recruiting_feedback: "feedback",
  recruiting_reply: "drafting",
  recruiting_crm_target: "crm",
  recruiting_crm_import: "crm",
  recruiting_request_approval: "question",
  ask_user: "question",
  run_subagent: "specialist",
  message_bot: "specialist",
  handoff_to_bot: "specialist",
  message_agent: "specialist",
};

/**
 * Connected-service operations with a safe generic meaning. Anything else stays "working":
 * a send or booking may still wait for approval, so the line never claims it happened.
 */
const CONNECTED_OPERATIONS: Record<string, WorkActivity> = {
  get_email: "emails",
  list_emails: "emails",
  get_thread_history: "emails",
  search_contact_emails: "emails",
  list_mailbox_emails: "emails",
  search_threads: "emails",
  get_availability: "availability",
  create_draft: "drafting",
  research: "research",
  get_rows: "research",
  get_task: "research",
  continue_with_file: "research",
  get_crm_role: "crm",
  list_candidates: "crm",
  crm_import_candidate: "crm",
};

/**
 * Maps a native tool name, or the humanized label a saved steps block carries
 * ("Mcp  autumn  research"), to a work category.
 */
export function workActivityForTool(name: string): WorkActivity {
  const key = name.trim().toLowerCase().replaceAll(" ", "_");
  const builtin = BUILTIN_ACTIVITIES[key];
  if (builtin) return builtin;
  // Connected tools are <service>__<connection>__<operation>; older labels kept single spaces.
  if (!/^(?:mcp|instantly|cal)_/.test(key)) return "working";
  const operation = Object.keys(CONNECTED_OPERATIONS)
    .filter((candidate) => key.endsWith(`_${candidate}`))
    .sort((a, b) => b.length - a.length)[0];
  return operation ? CONNECTED_OPERATIONS[operation]! : "working";
}

type WorkMessage = {
  id: string;
  runId?: string | null;
  botId?: string;
  seq?: number;
  role?: string;
  internal?: boolean;
  blocks: readonly MessageBlock[];
  createdAt?: string;
};

type WorkRun = {
  id: string;
  /** The member doing the run, so work handed to another member shows as its own stage. */
  botId?: string;
  status: string;
  startedAt?: string | null;
  createdAt?: string | null;
};

/** One run's live steps: finished calls in order, and the call still in flight. */
export function runWorkSteps(message: Pick<WorkMessage, "blocks"> | undefined): {
  done: WorkItem[];
  current: WorkActivity | null;
  currentStartedAt?: string;
} {
  if (!message) return { done: [], current: null };
  const done = message.blocks.flatMap((block) =>
    block.kind === "steps"
      ? block.steps.flatMap((step) =>
          Array.from({ length: step.count }, (): WorkItem => {
            const activity = workActivityForTool(step.label);
            return step.status ||
              step.peopleWithEmail !== undefined ||
              step.durationMs !== undefined ||
              step.startedAt
              ? {
                  activity,
                  ...(step.status ? { status: step.status } : {}),
                  ...(step.peopleWithEmail === undefined
                    ? {}
                    : { peopleWithEmail: step.peopleWithEmail }),
                  ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
                  ...(step.startedAt ? { startedAt: step.startedAt } : {}),
                }
              : activity;
          }),
        )
      : [],
  );
  const marker = message.blocks.at(-1);
  if (marker?.kind !== "progress" || marker.activity !== true) return { done, current: null };
  if (marker.phase) return { done, current: null };
  const pending = marker.pendingToolNames?.at(-1);
  if (pending)
    return {
      done,
      current: workActivityForTool(pending),
      ...(marker.pendingToolCalls?.at(-1)?.startedAt
        ? { currentStartedAt: marker.pendingToolCalls.at(-1)!.startedAt }
        : {}),
    };
  // The steps block already holds the call this empty marker follows.
  const currentIndex = done.findLastIndex(
    (item) => typeof item === "string" || (!item.status && item.durationMs === undefined),
  );
  const currentItem = done[currentIndex];
  if (marker.text === "" && currentItem)
    return {
      done: done.filter((_, index) => index !== currentIndex),
      current: itemActivity(currentItem),
      ...(typeof currentItem !== "string" && currentItem.startedAt
        ? { currentStartedAt: currentItem.startedAt }
        : {}),
    };
  return { done, current: "working" };
}

/**
 * The work behind one turn: from when a run starts executing until no run is. Clients keep
 * the latest one so steps survive narration messages that replace the live row, and so the
 * finished turn can say how long it took. Time spent queued or paused for an answer is not
 * work, so it never counts.
 */
export type WorkSession = {
  /** When execution of the turn began. */
  startedAt: string;
  /** Server time of the last message the turn produced, once nothing is working. */
  endedAt: string | null;
  runIds: string[];
  /** The member behind each run, when known. */
  runBots: Record<string, string>;
  /** Per run: steps from live rows that later messages cleared, or from runs that finished. */
  earlier: Record<string, WorkItem[]>;
  /** Latest live steps per run, to tell growth from a fresh row. */
  live: Record<string, WorkItem[]>;
  current: WorkActivity | null;
  currentStartedAt?: string;
  progress?: { phase: "thinking" | "compacting" | "retrying"; summary?: string };
};

export type WorkStep = {
  activity: WorkActivity;
  count: number;
  status?: "failed" | "paused";
  peopleWithEmail?: number;
  startedAt?: string;
  durationMs?: number;
};
export type WorkItem = WorkActivity | Omit<WorkStep, "count">;

function itemActivity(item: WorkItem): WorkActivity {
  return typeof item === "string" ? item : item.activity;
}

/** A later run joins the turn when it starts this soon after the previous one ended. */
export const WORK_SESSION_CONTINUE_MS = 15_000;

function isPrefix(prefix: readonly WorkItem[], list: readonly WorkItem[]) {
  return (
    prefix.length <= list.length &&
    prefix.every((activity, index) => itemActivity(list[index]!) === itemActivity(activity))
  );
}

function time(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function latest(values: readonly (string | null | undefined)[]): string | undefined {
  return values
    .filter((value): value is string => Number.isFinite(time(value)))
    .sort((a, b) => time(a) - time(b))
    .at(-1);
}

/**
 * Folds the visible thread into the current work session. Pure: call it whenever runs or
 * messages change and keep the result. Returns `previous` itself when nothing changed.
 *
 * A run's `startedAt` also covers any pause for an answer, so a new session starts no
 * earlier than the latest user message, the previous session's end, or `notBefore`: the
 * last moment this client saw nothing executing.
 */
export function observeWorkSession(
  previous: WorkSession | null,
  thread: {
    runs: readonly WorkRun[];
    messages: readonly WorkMessage[];
    backgroundWork?: readonly BackgroundWorkTiming[];
  },
  now: string,
  options: { notBefore?: string | null } = {},
): WorkSession | null {
  let foreground = observeForegroundWorkSession(previous, thread, now, options);
  const lastUserAt = latest(
    thread.messages
      .filter((message) => message.role === "user" && !message.internal)
      .map((message) => message.createdAt),
  );
  if (!foreground && !thread.runs.some((run) => run.status === "running")) {
    const completed = thread.messages.findLast(
      (message) =>
        message.role === "bot" &&
        message.runId &&
        Number.isFinite(time(message.createdAt)) &&
        (!lastUserAt || time(message.createdAt) >= time(lastUserAt)) &&
        message.blocks.some((block) => block.kind === "steps" && block.durationMs !== undefined),
    );
    const duration = completed?.blocks.findLast(
      (block) => block.kind === "steps" && block.durationMs !== undefined,
    );
    if (
      completed?.runId &&
      completed.createdAt &&
      duration?.kind === "steps" &&
      duration.durationMs !== undefined
    ) {
      // Saved messages retain the native crew runs after live rows are gone. A real user
      // turn bounds the history; internal research wakes must not hide its earlier stages.
      const rows = thread.messages.filter(
        (message) =>
          message.role === "bot" &&
          message.runId &&
          (lastUserAt
            ? time(message.createdAt) >= time(lastUserAt)
            : message.runId === completed.runId),
      );
      const runIds = [...new Set(rows.map((message) => message.runId!))];
      const start = Math.max(
        Math.min(
          ...rows.flatMap((message) =>
            message.blocks.flatMap((block) =>
              block.kind === "steps" &&
              block.durationMs !== undefined &&
              Number.isFinite(time(message.createdAt))
                ? [time(message.createdAt) - block.durationMs]
                : [],
            ),
          ),
        ),
        lastUserAt ? time(lastUserAt) : -Infinity,
      );
      foreground = {
        startedAt: new Date(start).toISOString(),
        endedAt: latest(rows.map((message) => message.createdAt)) ?? completed.createdAt,
        runIds,
        runBots: Object.fromEntries(
          rows.flatMap((message) => (message.botId ? [[message.runId!, message.botId]] : [])),
        ),
        earlier: Object.fromEntries(
          runIds.map((runId) => [
            runId,
            rows
              .filter((message) => message.runId === runId)
              .flatMap((row) => runWorkSteps(row).done),
          ]),
        ),
        live: {},
        current: null,
      };
    }
  }
  const background = (thread.backgroundWork ?? []).filter(
    (work) =>
      Number.isFinite(time(work.startedAt)) &&
      (!work.endedAt ||
        (time(work.endedAt) >= time(work.startedAt) &&
          (!lastUserAt || time(work.endedAt) >= time(lastUserAt)))) &&
      (!foreground ||
        foreground.runIds.includes(work.runId) ||
        (!previous &&
          !thread.runs.some((run) => run.status === "running") &&
          work.endedAt &&
          time(work.endedAt) >= time(foreground.startedAt) - WORK_SESSION_CONTINUE_MS)),
  );
  if (!background.length) return foreground;
  const runIds = [...new Set(background.map((work) => work.runId))];
  const starts = background.flatMap((work) => {
    const userAtStart = latest(
      thread.messages
        .filter(
          (message) =>
            message.role === "user" &&
            !message.internal &&
            time(message.createdAt) <= time(work.startedAt),
        )
        .map((message) => message.createdAt),
    );
    return [latest([work.turnStartedAt, userAtStart]) ?? work.startedAt, work.startedAt];
  });
  const base: WorkSession = foreground ?? {
    startedAt: starts[0]!,
    endedAt: null,
    runIds,
    runBots: Object.fromEntries(background.map((work) => [work.runId, work.botId])),
    earlier: Object.fromEntries(
      runIds.map((runId) => [
        runId,
        thread.messages
          .filter((message) => message.runId === runId)
          .flatMap((message) => runWorkSteps(message).done),
      ]),
    ),
    live: {},
    current: null,
  };
  const next: WorkSession = {
    ...base,
    startedAt: [base.startedAt, ...starts].sort((a, b) => time(a) - time(b))[0]!,
    endedAt:
      background.some((work) => !work.endedAt) ||
      thread.runs.some((run) => run.status === "running")
        ? null
        : (latest([base.endedAt, ...background.map((work) => work.endedAt)]) ?? now),
    runIds: [...new Set([...base.runIds, ...runIds])],
    runBots: {
      ...base.runBots,
      ...Object.fromEntries(background.map((work) => [work.runId, work.botId])),
    },
  };
  return previous && sameSession(previous, next) ? previous : next;
}

function observeForegroundWorkSession(
  previous: WorkSession | null,
  thread: { runs: readonly WorkRun[]; messages: readonly WorkMessage[] },
  now: string,
  options: { notBefore?: string | null } = {},
): WorkSession | null {
  const working = thread.runs.filter((run) => run.status === "running");
  if (!working.length) {
    if (!previous || previous.endedAt) return previous;
    const runIds = new Set(previous.runIds);
    const last = latest(
      thread.messages
        .filter((message) => message.runId && runIds.has(message.runId))
        .map((message) => message.createdAt),
    );
    // Runs that finished earlier already moved their steps; settle the ones last seen working.
    const earlier = { ...previous.earlier };
    const lastLive = Object.keys(previous.live).at(-1);
    for (const [runId, seen] of Object.entries(previous.live)) {
      const rows = thread.messages.filter((message) => message.runId === runId);
      const row =
        rows.find((message) => message.id === `progress:${runId}`) ??
        rows.filter((message) => message.blocks.some((block) => block.kind === "steps")).at(-1);
      const inFlight = !row && previous.current && runId === lastLive ? [previous.current] : [];
      addItems(earlier, runId, row ? runWorkSteps(row).done : [...seen, ...inFlight]);
    }
    return {
      ...previous,
      endedAt: last && time(last) >= time(previous.startedAt) ? last : now,
      earlier,
      live: {},
      current: null,
      currentStartedAt: undefined,
      progress: undefined,
    };
  }
  const runStart = working
    .map((run) => run.startedAt ?? run.createdAt)
    .filter((value): value is string => Number.isFinite(time(value)))
    .sort((a, b) => time(a) - time(b))[0];
  const startedAt =
    latest([
      runStart,
      latest(
        thread.messages.filter((m) => m.role === "user" && !m.internal).map((m) => m.createdAt),
      ),
      previous?.endedAt,
      options.notBefore,
    ]) ?? now;
  const spoke = (since: string) =>
    thread.messages.some(
      (message) =>
        message.role === "user" && !message.internal && time(message.createdAt) > time(since),
    );
  const continues =
    previous &&
    (!previous.endedAt ||
      (!spoke(previous.endedAt) &&
        time(startedAt) - time(previous.endedAt) <= WORK_SESSION_CONTINUE_MS));
  const base: WorkSession = continues
    ? { ...previous, endedAt: null }
    : {
        startedAt,
        endedAt: null,
        runIds: [],
        runBots: {},
        earlier: {},
        live: {},
        current: null,
      };
  const earlier = { ...base.earlier };
  const live: Record<string, WorkItem[]> = {};
  const workingIds = new Set(working.map((run) => run.id));
  // A member that finished while others work keeps its steps in the turn.
  for (const [runId, steps] of Object.entries(base.live))
    if (!workingIds.has(runId)) addItems(earlier, runId, steps);
  let current: WorkActivity | null = null;
  let currentStartedAt: string | undefined;
  let currentSeq = -Infinity;
  let progress: WorkSession["progress"];
  let progressSeq = -Infinity;
  for (const run of working) {
    const row = thread.messages.find((message) => message.id === `progress:${run.id}`);
    const steps = runWorkSteps(row);
    const marker = row?.blocks.at(-1);
    if (marker?.kind === "progress" && marker.phase && (row?.seq ?? 0) >= progressSeq) {
      progress = {
        phase: marker.phase,
        ...(marker.summary ? { summary: hideVendorNames(marker.summary) } : {}),
      };
      progressSeq = row?.seq ?? 0;
    }
    const seen = base.live[run.id] ?? [];
    if (!isPrefix(seen, steps.done)) addItems(earlier, run.id, seen);
    live[run.id] = steps.done;
    if (steps.current && (row?.seq ?? 0) >= currentSeq) {
      current = steps.current;
      currentStartedAt = steps.currentStartedAt;
      currentSeq = row?.seq ?? 0;
    }
  }
  const next: WorkSession = {
    startedAt: base.startedAt,
    endedAt: null,
    runIds: [...new Set([...base.runIds, ...working.map((run) => run.id)])],
    runBots: {
      ...base.runBots,
      ...Object.fromEntries(working.flatMap((run) => (run.botId ? [[run.id, run.botId]] : []))),
    },
    earlier,
    live,
    current,
    ...(currentStartedAt ? { currentStartedAt } : {}),
    ...(progress ? { progress } : {}),
  };
  return previous && sameSession(previous, next) ? previous : next;
}

/** What a client keeps per open thread: the session and when it last saw nothing running. */
export type WorkTracker = { session: WorkSession | null; idleAt: string | null };

export const EMPTY_WORK_TRACKER: WorkTracker = { session: null, idleAt: null };

/** Observes one render of the thread; feed the result back on the next one. */
export function trackWork(
  tracker: WorkTracker,
  thread: {
    runs: readonly WorkRun[];
    messages: readonly WorkMessage[];
    backgroundWork?: readonly BackgroundWorkTiming[];
  },
  now: string,
): WorkTracker {
  const session = observeWorkSession(tracker.session, thread, now, {
    notBefore: tracker.idleAt,
  });
  const idleAt = session && !session.endedAt ? tracker.idleAt : now;
  return session === tracker.session && idleAt === tracker.idleAt ? tracker : { session, idleAt };
}

function sameSession(a: WorkSession, b: WorkSession): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function addItems(target: Record<string, WorkItem[]>, runId: string, items: readonly WorkItem[]) {
  if (items.length) target[runId] = [...(target[runId] ?? []), ...items];
}

function runItems(session: WorkSession, runId: string): WorkItem[] {
  return [...(session.earlier[runId] ?? []), ...(session.live[runId] ?? [])];
}

/** Finished steps in order, with consecutive repeats folded into a count. */
export function workSessionSteps(session: WorkSession | null): WorkStep[] {
  if (!session) return [];
  return foldSteps(session.runIds.flatMap((runId) => runItems(session, runId)));
}

/**
 * Work the turn handed to another member, under one entry each. The member that started the
 * turn keeps its own steps; a member that runs more than once stays one stage.
 */
export type WorkStage = { botId: string; running: boolean; steps: WorkStep[] };

/** A stage's own messages plus the handoff brief, always from its original conversation. */
export function workStageMessages<
  T extends { runId?: string | null; blocks: readonly MessageBlock[] },
>(
  messages: readonly T[],
  stage: { botId: string; runIds: readonly string[]; sourceRunIds: readonly string[] },
): T[] {
  return messages.filter(
    (message) =>
      !!message.runId &&
      (stage.runIds.includes(message.runId) ||
        (stage.sourceRunIds.includes(message.runId) &&
          message.blocks.some(
            (block) => block.kind === "handoff" && block.toBotId === stage.botId,
          ))),
  );
}

export function workSessionStages(session: WorkSession | null): {
  own: WorkStep[];
  stages: WorkStage[];
} {
  if (!session) return { own: [], stages: [] };
  const lead = session.runBots[session.runIds[0] ?? ""];
  const own: WorkItem[] = [];
  const stages = new Map<string, { running: boolean; items: WorkItem[] }>();
  for (const runId of session.runIds) {
    const botId = session.runBots[runId];
    if (!botId || botId === lead) {
      own.push(...runItems(session, runId));
      continue;
    }
    const stage = stages.get(botId) ?? { running: false, items: [] };
    stage.items.push(...runItems(session, runId));
    stage.running ||= runId in session.live;
    stages.set(botId, stage);
  }
  return {
    own: foldSteps(own),
    stages: [...stages].map(([botId, stage]) => ({
      botId,
      running: stage.running,
      steps: foldSteps(stage.items),
    })),
  };
}

/** One stage's place on the turn's timeline, as fractions of the turn so far (0..1). */
export type WorkTimelineRow = {
  botId: string;
  running: boolean;
  start: number;
  end: number;
  durationMs: number;
};

/**
 * Where each handed-off stage ran within the turn, from its timed steps, for a Gantt-style
 * view of parallel work. A stage with no timed step is left out; a running one reaches now.
 */
export function workTimeline(
  session: WorkSession | null,
  now: number,
): { totalMs: number; rows: WorkTimelineRow[] } {
  if (!session) return { totalMs: 0, rows: [] };
  const origin = time(session.startedAt);
  const totalMs = Math.max(1, workSessionElapsedMs(session, now));
  const rows: WorkTimelineRow[] = [];
  for (const stage of workSessionStages(session).stages) {
    const timed = stage.steps.filter((step) => step.startedAt);
    if (!timed.length) continue;
    const first = Math.min(...timed.map((step) => time(step.startedAt!)));
    const last = stage.running
      ? origin + totalMs
      : Math.max(...timed.map((step) => time(step.startedAt!) + (step.durationMs ?? 0)));
    const clamp = (value: number) => Math.min(1, Math.max(0, (value - origin) / totalMs));
    const start = clamp(first);
    rows.push({
      botId: stage.botId,
      running: stage.running,
      start,
      end: Math.max(start, clamp(last)),
      durationMs: Math.max(0, last - first),
    });
  }
  return { totalMs, rows };
}

/** What a handed-off stage is for, in closed words clients translate; never a member's name. */
export type WorkStageKind = "sourcing" | "quality" | "outreach" | "scheduling" | "other";

export function workStageKind(
  bot: { name?: string | null; spawnKey?: string | null } | undefined,
): WorkStageKind {
  const key = bot ? recruitingBotKey(bot) : undefined;
  return key === "sourcer"
    ? "sourcing"
    : key === "reviewer"
      ? "quality"
      : key === "outreach" || key === "scheduling"
        ? key
        : "other";
}

const STAGE_LABELS: Record<WorkStageKind, string> = {
  sourcing: "Finding candidates",
  quality: "Checking candidates",
  outreach: "Preparing outreach",
  scheduling: "Scheduling interviews",
  other: "Delegated task",
};

/** Shared English copy for a stage entry; clients translate it. */
export function workStageLabel(kind: WorkStageKind): string {
  return STAGE_LABELS[kind];
}

function foldSteps(items: readonly WorkItem[]): WorkStep[] {
  const steps: WorkStep[] = [];
  for (const item of items) {
    const row = typeof item === "string" ? { activity: item } : item;
    const last = steps.at(-1);
    if (
      last?.activity === row.activity &&
      !last.status &&
      !row.status &&
      last.peopleWithEmail === undefined &&
      row.peopleWithEmail === undefined &&
      last.durationMs === undefined &&
      row.durationMs === undefined &&
      !last.startedAt &&
      !row.startedAt
    )
      last.count += 1;
    else steps.push({ ...row, count: 1 });
  }
  return steps;
}

/** Milliseconds the session has run (live) or ran (ended); never negative. */
export function workSessionElapsedMs(session: WorkSession, now: number): number {
  const end = session.endedAt ? time(session.endedAt) : now;
  const elapsed = end - time(session.startedAt);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

/** A ticking clock: "0:07", "1:12", "1:02:03". */
export function formatWorkClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** A finished duration: "8s", "1m 12s", "1h 2m". */
export function formatWorkDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}

/**
 * A short "how is it going?" sent while an agent works. Like a side question it is answered
 * from the live work itself, so the work is neither interrupted nor told about it.
 */
export function isStatusQuestion(text: string | undefined): boolean {
  const trimmed = text?.trim() ?? "";
  return (
    trimmed.length > 0 &&
    trimmed.length <= 40 &&
    /进度|到哪|怎么样了|好了吗|好了没|还要多久|多久好|做完了吗|how(?:['’]s| is) it going|any (?:update|progress)|status\??$|progress\??$|how long|are you done|done yet|eta\??$/i.test(
      trimmed,
    )
  );
}

const STATUS_LABELS: Record<WorkActivity, string> = {
  files: "reading files",
  search: "searching the web",
  page: "reading a page",
  context: "checking saved context",
  memory: "saving notes",
  connections: "checking connections",
  connected_action: "using a connected app",
  emails: "checking email",
  availability: "checking availability",
  drafting: "drafting email",
  role: "reviewing the role",
  candidates: "reviewing candidates",
  research: "searching candidates",
  feedback: "recording feedback",
  crm: "checking candidate records",
  question: "preparing a question",
  specialist: "asking a specialist",
  working: "working on it",
};

/** The middle of past durations of the same kind of work, or undefined with fewer than three. */
export function typicalDurationMs(durations: readonly number[]): number | undefined {
  if (durations.length < 3) return undefined;
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The reply to a status question: what is running now, for how long, and, when past runs of the
 * same kind give a typical length, roughly how much is left.
 */
export function statusAnswer(input: {
  activity: WorkActivity;
  elapsedMs: number;
  typicalMs?: number;
}): string {
  const now = `Still working: ${STATUS_LABELS[input.activity]}, ${formatWorkDuration(input.elapsedMs)} so far.`;
  if (input.typicalMs === undefined) return `${now} The result will appear here when it's ready.`;
  const left = input.typicalMs - input.elapsedMs;
  if (left <= 0)
    return `${now} This is taking longer than usual; the result will appear here when it's ready.`;
  const minutes = Math.ceil(left / 60_000);
  return `${now} Usually done in ${left < 60_000 ? "under a minute" : `about ${minutes} min`}.`;
}

/** Closed role words: runtime names and task text stay in diagnostics. */
export function specialistWorkLabel(status: "running" | "completed" | "failed"): string {
  return status === "running"
    ? "A specialist is working…"
    : status === "completed"
      ? "Specialist finished"
      : "Specialist needs attention";
}

/** Shared recruiter copy for native work rows. */
export function workActivityLabel(activity: WorkActivity): string {
  const label = STATUS_LABELS[activity];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Only the runtime's safe summary, never progress text or raw reasoning. */
export function workProgressLabel(progress?: WorkSession["progress"]): string {
  if (!progress) return "";
  return (
    progress.summary ||
    (progress.phase === "thinking"
      ? "Thinking…"
      : progress.phase === "retrying"
        ? "Trying again…"
        : "Reviewing context…")
  );
}
