/** A deployment drain stops admission, not the running jobs' cancellation signal. */
export function createWorkerDrain(deps: {
  stopJobs: () => Promise<void>;
  stopReconciler: () => Promise<void>;
}) {
  let state: "ready" | "draining" | "drained" | "failed" = "ready";
  let draining: Promise<void> | undefined;
  return {
    state: () => state,
    begin(): Promise<void> {
      if (draining) return draining;
      state = "draining";
      // Invoke both immediately: stop fetching jobs before waiting for reconciliation.
      draining = Promise.all([
        Promise.resolve().then(deps.stopJobs),
        Promise.resolve().then(deps.stopReconciler),
      ]).then(
        () => {
          state = "drained";
        },
        (error: unknown) => {
          state = "failed";
          throw error;
        },
      );
      return draining;
    },
  };
}
