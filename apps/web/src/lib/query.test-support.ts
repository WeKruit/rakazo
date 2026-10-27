import { notifyManager } from "@tanstack/react-query";

// React's async act drains microtasks; keep Query observer notifications within that boundary.
// Production retains TanStack's default scheduler. Fake latency timers still control transport.
notifyManager.setScheduler((notify) => { void Promise.resolve().then(notify); });
