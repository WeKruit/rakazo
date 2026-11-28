/**
 * A deployment drain stops admission, not the running jobs' cancellation signal. Owned agent
 * sessions are told to quiesce first: each lets its live turn finish (bounded by the session host)
 * and releases its lease, so stopping the job host waits for those turns instead of cutting them.
 */
export function createWorkerDrain(deps: {
  stopJobs: () => Promise<void>;
  stopReconciler: () => Promise<void>;
  /** Abort the session hosts' signal (plan Task 4 step 6). */
  quiesceSessions?: () => void;
  afterDrain?: () => Promise<void>;
}) {
  let state: "ready" | "draining" | "drained" | "failed" = "ready";
  let draining: Promise<void> | undefined;
  return {
    state: () => state,
    begin(): Promise<void> {
      if (draining) return draining;
      state = "draining";
      deps.quiesceSessions?.();
      // Invoke both immediately: stop fetching jobs before waiting for reconciliation.
      draining = Promise.all([
        Promise.resolve().then(deps.stopJobs),
        Promise.resolve().then(deps.stopReconciler),
      ])
        .then(() => deps.afterDrain?.())
        .then(
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
