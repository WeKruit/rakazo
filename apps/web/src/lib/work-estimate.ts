import type { WorkEstimate } from "@rakazo/core";
import { useEffect, useState } from "react";
import { rpc } from "./rpc";

/** While work is waiting in the background, look again this often for its end. */
const POLL_MS = 30_000;

type Target = { botId: string } | { groupId: string };
type Reader = (target: Target, signal: AbortSignal) => Promise<WorkEstimate | null>;

const defaultReader: Reader = (target, signal) => rpc.recruiting.workEstimate(target, { signal });

/**
 * The big search or contact lookup this conversation is waiting on, from the server's estimate.
 * Read again when the conversation changes and, while something is waiting, every half minute.
 */
export function useWorkEstimate(options: {
  target: Target | undefined;
  /** Changes whenever runs start or end, or Results grow. */
  refreshSignal: unknown;
  read?: Reader;
}): WorkEstimate | null {
  const { target, refreshSignal } = options;
  const read = options.read ?? defaultReader;
  const [estimate, setEstimate] = useState<WorkEstimate | null>(null);
  const [tick, setTick] = useState(0);
  const key = target ? ("botId" in target ? `b:${target.botId}` : `g:${target.groupId}`) : "";

  useEffect(() => {
    setEstimate(null);
  }, [key]);

  useEffect(() => {
    if (!target) return;
    const abort = new AbortController();
    Promise.resolve()
      .then(() => read(target, abort.signal))
      .then((next) => {
        if (!abort.signal.aborted) setEstimate(next);
      })
      .catch(() => undefined);
    return () => abort.abort();
    // The target object is rebuilt each render; its key names it.
  }, [key, refreshSignal, tick]);

  useEffect(() => {
    if (!estimate) return;
    const timer = setInterval(() => setTick((value) => value + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [estimate]);

  return target ? estimate : null;
}
