/**
 * A working run whose runtime sends nothing for this long is stopped, so it fails visibly and
 * recovers. Longer than any tool or model-stream timeout, so only a real hang trips it.
 */
export const SILENT_RUN_LIMIT_MS = 20 * 60_000;
export const SILENT_RUN_STOP_TEXT = "Stopped after 20 minutes without progress.";

/**
 * Watches a run's runtime events. `touch` marks activity; once nothing has arrived for `limitMs`,
 * `onSilent` runs once with how long it was quiet. Nothing is measured before the first touch.
 */
export function createSilenceWatch(options: {
  limitMs?: number;
  checkEveryMs?: number;
  now?: () => number;
  onSilent: (silentMs: number) => void;
}) {
  const limitMs = options.limitMs ?? SILENT_RUN_LIMIT_MS;
  const now = options.now ?? Date.now;
  let last: number | null = null;
  let fired = false;
  const timer = setInterval(() => {
    if (last === null || fired) return;
    const silentMs = now() - last;
    if (silentMs < limitMs) return;
    fired = true;
    options.onSilent(silentMs);
  }, options.checkEveryMs ?? 30_000);
  timer.unref?.();
  return {
    touch() {
      last = now();
    },
    get fired() {
      return fired;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
