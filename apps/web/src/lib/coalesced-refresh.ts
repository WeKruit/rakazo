type VisibilityDocument = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/**
 * Runs at most once per window: the first request runs now, later ones in the window collapse
 * into one run at its end. Requests made while the page is hidden wait until it is visible.
 */
export function createCoalescedRefresh(
  run: () => void,
  options: { windowMs: number; doc?: VisibilityDocument },
) {
  const doc = options.doc ?? (typeof document === "undefined" ? undefined : document);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queued = false;
  let waitingForVisible = false;
  const fire = () => {
    queued = false;
    run();
    timer = setTimeout(() => {
      timer = undefined;
      if (queued) request();
    }, options.windowMs);
  };
  const request = () => {
    if (doc?.hidden) {
      waitingForVisible = true;
      return;
    }
    if (timer) queued = true;
    else fire();
  };
  const onVisibility = () => {
    if (!waitingForVisible || doc?.hidden) return;
    waitingForVisible = false;
    request();
  };
  doc?.addEventListener("visibilitychange", onVisibility);
  return {
    request,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      queued = false;
      waitingForVisible = false;
      doc?.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
