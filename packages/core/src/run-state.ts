import type { RunStatus } from "@rakazo/contracts";

export const ACTIVE_RUN_STATUSES = [
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
] as const satisfies readonly RunStatus[];
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];
/**
 * These turns carry their own prompt and must not take a user message as steering.
 * Routine, webhook, and peer-message turns have their own recipient. User messages
 * wait for their own continuation instead of being answered back to another bot.
 * The creation intro has no tools and likewise cannot take user steering.
 */
const NON_CONVERSATIONAL_RUN_TRIGGERS = new Set([
  "routine",
  "webhook",
  "created",
  "tickets",
  "bot_message",
  "recruiting_grade",
  "recruiting_checkin",
]);

/**
 * Background triggers do internal work that must not leak into the chat: the
 * sidebar must not show them as activity and the bot transcript must not render
 * their steps/text. Ticket work reports through board comments and its status;
 * recruiting grades appear in Results. Existing ask and approval cards can still
 * request user input.
 */
export const BACKGROUND_RUN_TRIGGERS = ["tickets", "recruiting_grade"] as const;
const BACKGROUND_RUN_TRIGGER_SET = new Set<string>(BACKGROUND_RUN_TRIGGERS);

export function isBackgroundRunTrigger(trigger: string | null | undefined): boolean {
  return BACKGROUND_RUN_TRIGGER_SET.has(trigger ?? "");
}

/**
 * Run triggers that no person is waiting on. Each thread runs them one at a time, oldest first,
 * after the thread's earlier runs; workers also schedule them behind a person's turn.
 */
export const AUTOMATION_RUN_TRIGGERS = [
  "bot_message",
  "routine",
  "webhook",
  "tickets",
  "recruiting_research",
  "recruiting_grade",
  "recruiting_checkin",
  "cloud_agent",
] as const;
const AUTOMATION_RUN_TRIGGER_SET = new Set<string>(AUTOMATION_RUN_TRIGGERS);

export function isAutomationRunTrigger(trigger: string | null | undefined): boolean {
  return AUTOMATION_RUN_TRIGGER_SET.has(trigger ?? "");
}

const allowed: Record<RunStatus, RunStatus[]> = {
  queued: ["leased", "cancelled"],
  leased: ["running", "queued", "cancelled"],
  running: ["waiting_input", "waiting_takeover", "completed", "failed", "cancelled", "leased"],
  waiting_input: ["queued", "leased", "cancelled"],
  waiting_takeover: ["queued", "leased", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return allowed[from]?.includes(to) ?? false;
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal run transition ${from} -> ${to}`);
  }
}

export function isActive(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/** Whether a run's turn is part of the thread's conversation and may take user steering. */
export function isConversationalRun(trigger: string | null | undefined): boolean {
  return !NON_CONVERSATIONAL_RUN_TRIGGERS.has(trigger ?? "");
}

export function nextFence(current: number): number {
  return current + 1;
}

/**
 * Per-run guardrails. A run that crosses either stops opening model calls and ends with a
 * reply naming the limit. Conservative constants until shared deployment settings carry
 * them; no persisted setting exists today without a migration.
 */
export const RUN_COST_LIMIT_USD = 5;
export const RUN_WALL_CLOCK_LIMIT_MS = 120 * 60_000;

export type RunBudgetLimit = "cost" | "time";

export function runBudgetExceeded(
  spent: { costUsd: number; elapsedMs: number },
  limits: { costUsd: number; wallClockMs: number } = {
    costUsd: RUN_COST_LIMIT_USD,
    wallClockMs: RUN_WALL_CLOCK_LIMIT_MS,
  },
): RunBudgetLimit | null {
  if (spent.costUsd >= limits.costUsd) return "cost";
  if (spent.elapsedMs >= limits.wallClockMs) return "time";
  return null;
}

/** User-facing reply for a run stopped by a budget guardrail. */
export function runBudgetStopText(
  limit: RunBudgetLimit,
  spent: { costUsd: number; elapsedMs: number; toolCalls: number },
  progress?: { savedCandidates: number; nextStep: string | null },
): string {
  const reason =
    limit === "cost"
      ? `this run reached its cost limit (about $${spent.costUsd.toFixed(2)} spent)`
      : `this run reached its time limit (${Math.round(spent.elapsedMs / 60_000)} minutes)`;
  const saved = progress
    ? ` This role has ${progress.savedCandidates} saved candidate profile${progress.savedCandidates === 1 ? "" : "s"}.${progress.nextStep ? ` Next step: ${progress.nextStep}.` : ""}`
    : " Everything completed so far is above and stays done.";
  return `I stopped early because ${reason} after ${spent.toolCalls} tool call${spent.toolCalls === 1 ? "" : "s"}.${saved} Nothing after this point was started. Tell me to continue if you want me to pick up where I left off.`;
}
