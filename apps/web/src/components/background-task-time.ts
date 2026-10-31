import { t } from "@lingui/core/macro";
import type { ThreadBackgroundTask } from "@rakazo/contracts";
import { workCountdownLeftMs } from "@rakazo/core";

const MINUTE = 60_000;

/** Time left when the work has a countdown, otherwise how long it has been running. */
export function backgroundTaskTime(
  task: Pick<ThreadBackgroundTask, "startedAt" | "estimateMs">,
  now = Date.now(),
): string | null {
  if (!task.startedAt) return null;
  const left = workCountdownLeftMs(
    { startedAt: task.startedAt, estimateMs: task.estimateMs ?? null },
    now,
  );
  if (left !== null) {
    const minutes = Math.max(1, Math.ceil(left / MINUTE));
    return t`About ${minutes} min left`;
  }
  const elapsed = now - Date.parse(task.startedAt);
  if (!Number.isFinite(elapsed)) return null;
  const minutes = Math.floor(Math.max(0, elapsed) / MINUTE);
  return minutes < 1 ? t`Just started` : t`Running ${minutes} min`;
}
