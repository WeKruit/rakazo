/**
 * Background helpers inside one run. A helper started with `background` returns a handle at
 * once; its result reaches the parent exactly once: at the next turn boundary, from `wait`, or
 * before the run pauses. Helpers run in the parent's process under its lease and signal, so
 * they never outlive the run: a final turn waits for them instead of ending, and Stop aborts
 * them with the run.
 */
export interface SubagentSession {
  readonly handle: string;
  readonly name: string;
  /** A turn of this helper is working (background or blocking). */
  busy: boolean;
  /** The background turn in flight; settles after its result is stored in `undelivered`. */
  background?: Promise<void>;
  /** A finished background turn's result the parent has not read yet. */
  undelivered?: string;
}

export const DEFAULT_SUBAGENT_WAIT_SECONDS = 60;
export const MAX_SUBAGENT_WAIT_SECONDS = 600;

export function startBackgroundTurn(session: SubagentSession, turn: Promise<string>): void {
  session.background = turn
    .catch((error: unknown) => `Subagent failed: ${error instanceof Error ? error.message : error}`)
    .then((result) => {
      session.undelivered = result;
      session.background = undefined;
    });
}

export function formatSubagentResult(session: SubagentSession, result: string): string {
  return `Helper ${session.name} (${session.handle}) finished:\n${result}`;
}

/** Hands over a finished result once; later calls return undefined. */
export function takeSubagentResult(session: SubagentSession): string | undefined {
  const result = session.undelivered;
  session.undelivered = undefined;
  return result === undefined ? undefined : formatSubagentResult(session, result);
}

function openSessions(sessions: Iterable<SubagentSession>): SubagentSession[] {
  return [...sessions].filter(
    (session) => session.background !== undefined || session.undelivered !== undefined,
  );
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function settle(
  pending: Array<Promise<void>>,
  mode: "all" | "any",
  signal: AbortSignal | undefined,
  timeoutMs?: number,
): Promise<void> {
  if (pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limits: Array<Promise<void>> = [aborted(signal)];
  if (timeoutMs !== undefined)
    limits.push(
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    );
  try {
    await Promise.race([
      mode === "all" ? Promise.all(pending).then(() => undefined) : Promise.race(pending),
      ...limits,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * At a turn boundary, steer in every background result that finished. A turn that would end
 * the run first waits for the next result, so a result is never dropped by the run ending.
 * A pausing turn cannot continue: it lets running helpers finish (their results stay on the
 * thread's helper rows) instead of cutting them off. Errors and Stop deliver nothing.
 */
export async function deliverFinishedSubagents(
  steer: (text: string) => void,
  sessions: Iterable<SubagentSession>,
  turn: { message: { stopReason?: string }; toolResults: unknown[] },
  options: { paused: boolean; signal?: AbortSignal },
): Promise<void> {
  const open = openSessions(sessions);
  if (open.length === 0) return;
  const stop = turn.message.stopReason;
  if (stop === "error" || stop === "aborted" || options.signal?.aborted) return;
  const running = open.flatMap((session) => (session.background ? [session.background] : []));
  if (options.paused) {
    await settle(running, "all", options.signal);
    return;
  }
  const finalTurn = turn.toolResults.length === 0;
  if (finalTurn && !open.some((session) => session.undelivered !== undefined))
    await settle(running, "any", options.signal);
  if (options.signal?.aborted) return;
  const results = open.flatMap((session) => takeSubagentResult(session) ?? []);
  if (results.length) steer(results.join("\n\n"));
}

/** Before the run pauses for the user: wait for every background helper and hand over results. */
export async function collectSubagentResults(
  sessions: Iterable<SubagentSession>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const open = openSessions(sessions);
  if (open.length === 0) return undefined;
  await settle(
    open.flatMap((session) => (session.background ? [session.background] : [])),
    "all",
    signal,
  );
  if (signal?.aborted) return undefined;
  const results = open.flatMap((session) => takeSubagentResult(session) ?? []);
  return results.length ? results.join("\n\n") : undefined;
}

/** The `wait` mode of run_subagent: block until the named helpers finish or the timeout passes. */
export async function waitForSubagents(
  sessions: ReadonlyMap<string, SubagentSession>,
  handles: string[],
  timeoutSeconds: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const unknown = handles.filter((handle) => !sessions.has(handle));
  const targets = handles.length
    ? handles.flatMap((handle) => sessions.get(handle) ?? [])
    : openSessions(sessions.values());
  const seconds = Number(timeoutSeconds);
  const timeout = Number.isFinite(seconds)
    ? Math.min(Math.max(seconds, 0), MAX_SUBAGENT_WAIT_SECONDS)
    : DEFAULT_SUBAGENT_WAIT_SECONDS;
  await settle(
    targets.flatMap((session) => (session.background ? [session.background] : [])),
    "all",
    signal,
    timeout * 1000,
  );
  const lines = targets.map((session) => {
    const result = takeSubagentResult(session);
    if (result) return result;
    if (session.background) return `Helper ${session.name} (${session.handle}) is still working.`;
    return `Helper ${session.name} (${session.handle}) has no new result.`;
  });
  if (unknown.length) lines.push(`No helper with handle ${unknown.join(", ")} in this turn.`);
  return lines.length ? lines.join("\n\n") : "No helpers are working.";
}
