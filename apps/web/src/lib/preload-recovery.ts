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
  | "fetch"
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
 * During a release the server can briefly answer with an error page; the
 * reload waits until the page itself loads again so it never lands there.
 */
export function installPreloadRecovery(
  target: PreloadRecoveryWindow = window,
  isWorking: () => boolean = () => activeWork,
): () => void {
  let pendingRecovery: number | undefined;
  let recovering = false;
  let disposed = false;
  const serverReady = () =>
    target.fetch(target.location.href, { cache: "no-store", credentials: "same-origin" }).then(
      (response) => response.ok,
      () => false,
    );
  const recoverWhenIdle = async () => {
    pendingRecovery = undefined;
    if (disposed) return;
    if (isWorking() || !target.navigator.onLine) {
      pendingRecovery = target.setTimeout(recoverWhenIdle, 1000);
      return;
    }
    if (!(await serverReady())) {
      if (!disposed) pendingRecovery = target.setTimeout(recoverWhenIdle, 3000);
      return;
    }
    if (disposed) return;
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
    if (recovering) return;
    recovering = true;
    void recoverWhenIdle();
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  return () => {
    disposed = true;
    target.clearTimeout(clearRecovery);
    if (pendingRecovery !== undefined) target.clearTimeout(pendingRecovery);
    target.removeEventListener("vite:preloadError", onPreloadError);
  };
}
