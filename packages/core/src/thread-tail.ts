import type { LiveThread } from "./thread-reducer.js";
import { hasPendingUserMessage } from "./thread-reducer.js";

/**
 * What the end of a thread should say while the reply is not on screen yet, highest
 * priority first. Derived only from run state and the event log, so it never shows tool
 * arguments or ids. null means nothing to add: idle, or the reply text is streaming.
 */
export type ThreadTailPhase =
  | "retrying"
  | "compacting"
  | "working"
  | "needs_input"
  | "needs_takeover"
  | "starting"
  | "queued"
  | "background";

export function threadTailPhase(
  thread: Pick<LiveThread, "run" | "activeRuns" | "messages" | "queuedMessageIds"> | null,
  options: { sending?: boolean } = {},
): ThreadTailPhase | null {
  if (!thread) return options.sending ? "starting" : null;
  const runs = thread.activeRuns ?? (thread.run ? [thread.run] : []);
  const statuses = new Set(runs.map((run) => run.status));
  const last = thread.messages.at(-1);
  // A new message gets feedback even while an older run reconnects or waits on a card.
  if (options.sending || hasPendingUserMessage(thread)) return "starting";
  if (thread.queuedMessageIds?.length) return "queued";
  const liveTail = (runId: string) =>
    thread.messages.find((message) => message.id === `progress:${runId}`)?.blocks.at(-1);
  const runningPhase = (phase: "compacting" | "retrying") =>
    runs.some((run) => {
      const tail = liveTail(run.id);
      return run.status === "running" && tail?.kind === "progress" && tail.phase === phase;
    });
  if (runningPhase("retrying")) return "retrying";
  if (runningPhase("compacting")) return "compacting";
  // Any member still working keeps the thread visibly busy; a pause shows once work stops.
  if (statuses.has("running")) return "working";
  // An open ask card already is the prompt; repeating it adds nothing.
  const waitingRunIds = new Set(
    runs.filter((run) => run.status === "waiting_input").map((run) => run.id),
  );
  if (
    waitingRunIds.size &&
    !thread.messages.some(
      (message) =>
        (!message.runId || waitingRunIds.has(message.runId)) &&
        message.blocks.some((block) => block.kind === "ask" && block.status !== "answered"),
    )
  )
    return "needs_input";
  if (statuses.has("waiting_takeover")) return "needs_takeover";
  if (statuses.has("leased")) return "starting";
  if (statuses.has("queued")) return "queued";
  if (
    !runs.length &&
    thread.messages.some((message) =>
      message.blocks.some((block) => block.kind === "cloud_agent" && block.status === "running"),
    ) &&
    !last?.blocks.some((block) => block.kind === "cloud_agent")
  )
    return "background";
  return null;
}
