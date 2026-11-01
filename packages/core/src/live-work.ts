import type { BackgroundWorkTiming, MessageBlock } from "@rakazo/contracts";
import { isChineseText, recruitingBotKey } from "./recruiting-defaults.js";
import { hideVendorNames } from "./vendor-names.js";

/**
 * What an agent is doing, in categories every client can word for people. Derived only
 * from closed native tool names, never from tool arguments, ids or free progress text.
 */
export type WorkActivity =
  | "files"
  | "search"
  | "page"
  | "playbook"
  | "recall"
  | "history"
  | "memory"
  | "connections"
  | "connected_action"
  | "emails"
  | "availability"
  | "drafting"
  | "role"
  | "role_save"
  | "roles"
  | "candidates"
  | "candidate_lookup"
  | "replies"
  | "assess"
  | "profiles_save"
  | "notes"
  | "reminders"
  | "interview"
  | "research"
  | "feedback"
  | "crm"
  | "question"
  | "specialist"
  | "delegating"
  | "routine"
  | "waiting"
  | "writing"
  | "thinking"
  | "working";

const WORK_ACTIVITIES = new Set<string>([
  "files",
  "search",
  "page",
  "playbook",
  "recall",
  "history",
  "memory",
  "connections",
  "connected_action",
  "emails",
  "availability",
  "drafting",
  "role",
  "role_save",
  "roles",
  "candidates",
  "candidate_lookup",
  "replies",
  "assess",
  "profiles_save",
  "notes",
  "reminders",
  "interview",
  "research",
  "feedback",
  "crm",
  "question",
  "specialist",
  "delegating",
  "routine",
  "waiting",
  "writing",
  "thinking",
  "working",
]);

export function isWorkActivity(value: unknown): value is WorkActivity {
  return typeof value === "string" && WORK_ACTIVITIES.has(value);
}

const BUILTIN_ACTIVITIES: Record<string, WorkActivity> = {
  read_file: "files",
  list_files: "files",
  artifact_read: "files",
  web_search: "search",
  web_fetch: "page",
  browser_navigate: "page",
  browser_snapshot: "page",
  skill_read: "playbook",
  read_memory: "recall",
  recall_memory: "recall",
  read_history: "history",
  search_history: "history",
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
  recruiting_profiles: "candidates",
  recruiting_notes: "notes",
  recruiting_reminders: "reminders",
  recruiting_scheduling: "interview",
  recruiting_reply: "drafting",
  recruiting_crm_target: "crm",
  recruiting_crm_import: "crm",
  recruiting_request_approval: "question",
  ask_user: "question",
  run_subagent: "specialist",
  wait_for_work: "waiting",
  message_bot: "specialist",
  handoff_to_bot: "specialist",
  message_agent: "specialist",
  delegate_to_role: "delegating",
  message_user: "writing",
  request_connection: "connections",
  schedule_create: "routine",
  schedule_list: "routine",
  schedule_update: "routine",
  schedule_cancel: "routine",
};

/**
 * Tools whose closed `operation` argument changes what the recruiter should read. Only the
 * enum value is used, never free text, ids or other arguments.
 */
const OPERATION_ACTIVITIES: Record<string, Record<string, WorkActivity>> = {
  recruiting_role: {
    create: "role_save",
    update: "role_save",
    revise: "role_save",
    archive: "role_save",
    unarchive: "role_save",
  },
  recruiting_candidates: {
    roles: "roles",
    replies: "replies",
    resolve: "candidate_lookup",
  },
  recruiting_assess: { ask: "question" },
  recruiting_profiles: { save: "profiles_save", save_many: "profiles_save" },
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
 * ("Mcp  autumn  research"), to a work category. Arguments refine it only through the
 * closed `operation` value of the tools listed above.
 */
export function workActivityForTool(name: string, args?: unknown): WorkActivity {
  const key = name.trim().toLowerCase().replaceAll(" ", "_");
  const operation =
    args && typeof args === "object" ? (args as { operation?: unknown }).operation : undefined;
  const refined =
    typeof operation === "string" ? OPERATION_ACTIVITIES[key]?.[operation] : undefined;
  if (refined) return refined;
  const builtin = BUILTIN_ACTIVITIES[key];
  if (builtin) return builtin;
  // Connected tools are <service>__<connection>__<operation>; older labels kept single spaces.
  if (!/^(?:mcp|instantly|cal)_/.test(key)) return "working";
  const connected = Object.keys(CONNECTED_OPERATIONS)
    .filter((candidate) => key.endsWith(`_${candidate}`))
    .sort((a, b) => b.length - a.length)[0];
  return connected ? CONNECTED_OPERATIONS[connected]! : "working";
}

/** The recruiter-written words a step may quote, per tool: a query, a title or a name. */
const DETAIL_FIELDS: Record<string, string> = {
  search_history: "query",
  recall_memory: "query",
  web_search: "query",
  recruiting_role: "title",
  recruiting_candidates: "nameOrEmail",
};

const DETAIL_LIMIT = 48;

/**
 * A short topic that makes a step specific ("SWE hires"), or undefined. Anything that looks
 * like an id, link, address or tool name is dropped rather than shown.
 */
export function workStepDetail(name: string, args: unknown): string | undefined {
  const field = DETAIL_FIELDS[name];
  if (!field || !args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[field];
  if (typeof value !== "string") return undefined;
  const text = hideVendorNames(value).replaceAll(/\s+/g, " ").trim();
  if (!text || /https?:|www\.|@|[0-9a-f]{8,}|\d{6,}|[a-z]+_[a-z_]+|[{}[\]<>]/i.test(text))
    return undefined;
  if (text.length <= DETAIL_LIMIT) return text;
  const cut = text.slice(0, DETAIL_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${(space > DETAIL_LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
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
  currentDetail?: string;
  currentStartedAt?: string;
} {
  if (!message) return { done: [], current: null };
  const done = message.blocks.flatMap((block) =>
    block.kind === "steps"
      ? block.steps.flatMap((step) =>
          Array.from({ length: step.count }, (): WorkItem => {
            const activity = isWorkActivity(step.activity)
              ? step.activity
              : workActivityForTool(step.label);
            return step.status ||
              step.peopleWithEmail !== undefined ||
              step.durationMs !== undefined ||
              step.startedAt ||
              step.detail
              ? {
                  activity,
                  ...(step.detail ? { detail: step.detail } : {}),
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
  if (marker?.kind !== "progress" || marker.activity !== true)
    return { done: withoutWriting(done), current: null };
  if (marker.phase) return { done: withoutWriting(done), current: null };
  const pendingCall = marker.pendingToolCalls?.at(-1);
  const pending = pendingCall?.name ?? marker.pendingToolNames?.at(-1);
  if (pending)
    return {
      done: withoutWriting(done),
      current: isWorkActivity(pendingCall?.activity)
        ? pendingCall.activity
        : workActivityForTool(pending),
      ...(pendingCall?.detail ? { currentDetail: pendingCall.detail } : {}),
      ...(pendingCall?.startedAt ? { currentStartedAt: pendingCall.startedAt } : {}),
    };
  // The steps block already holds the call this empty marker follows.
  const currentIndex = done.findLastIndex(
    (item) => typeof item === "string" || (!item.status && item.durationMs === undefined),
  );
  const currentItem = done[currentIndex];
  if (marker.text === "" && currentItem)
    return {
      done: withoutWriting(done.filter((_, index) => index !== currentIndex)),
      current: itemActivity(currentItem),
      ...(typeof currentItem !== "string" && currentItem.detail
        ? { currentDetail: currentItem.detail }
        : {}),
      ...(typeof currentItem !== "string" && currentItem.startedAt
        ? { currentStartedAt: currentItem.startedAt }
        : {}),
    };
  // No call is open: the model is deciding what to do with what it just read.
  return { done: withoutWriting(done), current: "thinking" };
}

/** A message the agent posted already shows as the message itself, not as a step. */
function withoutWriting(items: WorkItem[]): WorkItem[] {
  return items.filter((item) => itemActivity(item) !== "writing");
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
  /** The recruiter-facing topic of the call in flight, when it has one. */
  currentDetail?: string;
  currentStartedAt?: string;
  progress?: { phase: "thinking" | "compacting" | "retrying"; summary?: string };
};

export type WorkStep = {
  activity: WorkActivity;
  count: number;
  /** Topics of the folded calls, e.g. a history query or a role title. */
  detail?: string;
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
      currentDetail: undefined,
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
  let currentDetail: string | undefined;
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
      currentDetail = steps.currentDetail;
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
    ...(currentDetail ? { currentDetail } : {}),
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

/**
 * Consecutive calls of the same kind read as one step: finished calls add their time and
 * topics, so four history lookups show once instead of four identical rows. A failed or
 * paused call, an email count, or the call still running keeps its own row.
 */
function foldSteps(items: readonly WorkItem[]): WorkStep[] {
  const steps: WorkStep[] = [];
  for (const item of items) {
    const row = typeof item === "string" ? { activity: item } : item;
    const last = steps.at(-1);
    const finished = (step: { durationMs?: number; startedAt?: string }) =>
      step.durationMs !== undefined || !step.startedAt;
    if (
      last?.activity === row.activity &&
      !last.status &&
      !row.status &&
      last.peopleWithEmail === undefined &&
      row.peopleWithEmail === undefined &&
      finished(last) &&
      finished(row)
    ) {
      last.count += 1;
      if (row.durationMs !== undefined) last.durationMs = (last.durationMs ?? 0) + row.durationMs;
      if (!last.startedAt && row.startedAt) last.startedAt = row.startedAt;
      last.detail = mergeDetails(last.detail, row.detail);
      if (!last.detail) delete last.detail;
    } else steps.push({ ...row, count: 1 });
  }
  return steps;
}

const MAX_DETAILS = 3;

function mergeDetails(a: string | undefined, b: string | undefined): string | undefined {
  const parts = [...new Set([...(a ? a.split(" · ") : []), ...(b ? [b] : [])])];
  return parts.length ? parts.slice(0, MAX_DETAILS).join(" · ") : undefined;
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
  playbook: "reading the hiring playbook",
  recall: "recalling your preferences",
  history: "looking back at earlier conversations",
  memory: "saving notes",
  connections: "checking connections",
  connected_action: "using a connected app",
  emails: "checking email",
  availability: "checking availability",
  drafting: "drafting email",
  role: "reviewing the role",
  role_save: "saving the role",
  roles: "looking up your roles",
  candidates: "reviewing candidates",
  candidate_lookup: "finding the candidate",
  replies: "checking candidate replies",
  assess: "assessing candidates",
  profiles_save: "saving candidates",
  notes: "checking candidate notes",
  reminders: "checking reminders",
  interview: "planning the interview",
  research: "searching candidates",
  feedback: "recording feedback",
  crm: "checking candidate records",
  question: "preparing a question",
  specialist: "asking a specialist",
  delegating: "handing this to the role team",
  routine: "setting up a routine",
  waiting: "waiting for background work",
  writing: "writing to you",
  thinking: "deciding the next step",
  working: "running a step",
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

/**
 * Work labels in Chinese for a recruiter who writes Chinese while the app language is
 * another one: like assistant replies, work rows follow the recruiter's own latest message.
 */
export const WORK_LABELS_ZH: {
  activity: Record<WorkActivity, string>;
  thinking: Partial<Record<WorkActivity, string>>;
  stage: Record<WorkStageKind, string>;
  progress: Record<NonNullable<WorkSession["progress"]>["phase"], string>;
} = {
  activity: {
    files: "读取文件",
    search: "网上搜索",
    page: "阅读网页",
    playbook: "阅读招聘手册",
    recall: "回顾你的偏好",
    history: "翻看之前的对话",
    memory: "记下要点",
    connections: "检查已连接的应用",
    connected_action: "使用已连接的应用",
    emails: "查看邮件",
    availability: "查看空闲时间",
    drafting: "起草邮件",
    role: "查看岗位",
    role_save: "保存岗位",
    roles: "查找你的岗位",
    candidates: "查看候选人",
    candidate_lookup: "查找这位候选人",
    replies: "查看候选人回复",
    assess: "评估候选人",
    profiles_save: "保存候选人",
    notes: "查看候选人备注",
    reminders: "查看提醒",
    interview: "安排面试",
    research: "搜索候选人",
    feedback: "记录反馈",
    crm: "查看候选人记录",
    question: "准备问题",
    specialist: "请同事帮忙",
    delegating: "交给岗位团队",
    routine: "设置定时任务",
    waiting: "等待后台任务",
    writing: "给你回复",
    thinking: "想下一步怎么做",
    working: "执行一步操作",
  },
  thinking: {
    playbook: "按招聘手册梳理",
    recall: "结合你的偏好",
    history: "整理之前的对话",
    search: "查看搜索结果",
    page: "查看页面",
    role: "查看岗位",
    role_save: "查看岗位",
    roles: "确定是哪个岗位",
    candidates: "整理候选人",
    candidate_lookup: "整理这位候选人的信息",
    replies: "整理候选人回复",
    research: "整理搜索结果",
    crm: "整理候选人记录",
    emails: "整理邮件",
    availability: "找合适的时间",
  },
  stage: {
    sourcing: "寻找候选人",
    quality: "核查候选人",
    outreach: "准备联系候选人",
    scheduling: "安排面试",
    other: "交办的任务",
  },
  progress: { thinking: "思考中…", retrying: "重试中…", compacting: "整理上下文…" },
};

/** Whether the recruiter's own latest message is mostly Chinese. */
export function writesChinese(
  messages: readonly { role?: string; internal?: boolean; blocks: readonly MessageBlock[] }[],
): boolean {
  const latest = messages.findLast((message) => message.role === "user" && !message.internal);
  const text = latest?.blocks
    .map((block) => (block.kind === "text" ? block.text : ""))
    .join("")
    .trim();
  return !!text && isChineseText(text);
}
