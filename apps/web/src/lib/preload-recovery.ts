const PRELOAD_RECOVERY_KEY = "rk:preload-recovery";
const PRELOAD_RECOVERY_COOLDOWN_MS = 30_000;

let activeWork = false;

/** The shell reports native run state so asset recovery cannot interrupt active work. */
export function setPreloadRecoveryActiveWork(active: boolean) {
  activeWork = active;
}

type PreloadRecoveryWindow = Pick<
  Window,
  | "addEventListener"
  | "clearTimeout"
  | "location"
  | "navigator"
  | "removeEventListener"
  | "sessionStorage"
  | "setTimeout"
>;

/**
 * Vite emits this event when a lazy chunk from an older deployment no longer
 * exists. Reload once so the browser receives the current asset manifest.
 * While offline a reload would only reach the browser's offline page, so the
 * failure is left to the app's error boundaries, which offer a retry.
 */
export function installPreloadRecovery(
  target: PreloadRecoveryWindow = window,
  isWorking: () => boolean = () => activeWork,
): () => void {
  let pendingRecovery: number | undefined;
  const recoverWhenIdle = () => {
    if (isWorking() || !target.navigator.onLine) {
      pendingRecovery = target.setTimeout(recoverWhenIdle, 1000);
      return;
    }
    target.sessionStorage.setItem(PRELOAD_RECOVERY_KEY, "1");
    target.location.reload();
  };
  const clearRecovery = target.setTimeout(
    () => target.sessionStorage.removeItem(PRELOAD_RECOVERY_KEY),
    PRELOAD_RECOVERY_COOLDOWN_MS,
  );
  const onPreloadError = (event: Event) => {
    if (!target.navigator.onLine || target.sessionStorage.getItem(PRELOAD_RECOVERY_KEY)) return;
    event.preventDefault();
    if (pendingRecovery === undefined) recoverWhenIdle();
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  return () => {
    target.clearTimeout(clearRecovery);
    if (pendingRecovery !== undefined) target.clearTimeout(pendingRecovery);
    target.removeEventListener("vite:preloadError", onPreloadError);
  };
}
