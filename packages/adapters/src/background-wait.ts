import type { ThreadBackgroundTask } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { listThreadBackgroundWork } from "@rakazo/db";

export const WAIT_MAX_SECONDS = 30 * 60;
export const WAIT_DEFAULT_SECONDS = 10 * 60;
const WAIT_POLL_MS = 5_000;

type Work = Pick<ThreadBackgroundTask, "id" | "kind">;

export type BackgroundWaitResult = {
  done: Work[];
  running: Work[];
  waitedSeconds: number;
  timedOut: boolean;
  note?: string;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Wait without model calls for this conversation's background work: until all of it is done
 * ("all") or the first piece finishes ("any"), or the timeout. Returns what finished and what
 * is still running, so the agent can report progress and wait again.
 */
export async function waitForBackgroundWork(
  prisma: Pick<PrismaClient, "$queryRaw">,
  input: {
    threadId: string;
    selfRunId: string;
    ids?: readonly string[];
    mode?: "all" | "any";
    timeoutSeconds?: number;
    signal: AbortSignal;
    pollMs?: number;
  },
): Promise<BackgroundWaitResult> {
  const mode = input.mode ?? "all";
  const timeoutSeconds = Math.min(
    WAIT_MAX_SECONDS,
    Math.max(1, Math.round(input.timeoutSeconds ?? WAIT_DEFAULT_SECONDS)),
  );
  const pollMs = input.pollMs ?? WAIT_POLL_MS;
  const startedAt = Date.now();
  const list = async () =>
    (await listThreadBackgroundWork(prisma, input.threadId)).filter(
      (work) => !(work.kind === "run" && work.id === input.selfRunId),
    );
  const wanted = input.ids?.length ? new Set(input.ids) : undefined;
  const watched = (await list())
    .filter((work) => !wanted || wanted.has(work.id))
    .map(({ id, kind }) => ({ id, kind }));
  const waitedSeconds = () => Math.round((Date.now() - startedAt) / 1000);
  if (!watched.length) {
    return {
      done: [],
      running: [],
      waitedSeconds: 0,
      timedOut: false,
      note: wanted
        ? "None of those are running any more. Read their saved results."
        : "Nothing is running in the background for this conversation.",
    };
  }
  let running = watched;
  for (;;) {
    const settled = mode === "all" ? running.length === 0 : running.length < watched.length;
    const timedOut = Date.now() - startedAt >= timeoutSeconds * 1000;
    if (settled || timedOut || input.signal.aborted) {
      const live = new Set(running.map((work) => work.id));
      return {
        done: watched.filter((work) => !live.has(work.id)),
        running,
        waitedSeconds: waitedSeconds(),
        timedOut: !settled && timedOut,
      };
    }
    await sleep(
      Math.min(pollMs, Math.max(0, timeoutSeconds * 1000 - (Date.now() - startedAt))),
      input.signal,
    );
    const current = new Set((await list()).map((work) => work.id));
    running = watched.filter((work) => current.has(work.id));
  }
}
