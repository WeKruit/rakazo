import { useEffect, useRef, useState } from "react";
import { rpc } from "./rpc";

type CountReader = (signal: AbortSignal) => Promise<number>;

/**
 * People added to a role's Results while its chat is working: the business progress line for long
 * searches. Counts come from saved results, never from model text. Null when nothing was added,
 * outside a role chat, or once the work ends.
 */
export function useNewPeopleDuringRun(options: {
  groupId: string | undefined;
  threadId: string | undefined;
  running: boolean;
  refreshSignal: number;
  read?: CountReader;
}): number | null {
  const { groupId, threadId, running, refreshSignal } = options;
  const read = options.read ?? defaultReader(groupId, threadId);
  const baseline = useRef<number | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  const active = running && Boolean(groupId && threadId);

  useEffect(() => {
    if (!active) {
      baseline.current = null;
      setAdded(null);
    }
  }, [active]);

  useEffect(() => {
    if (!active || !read) return;
    const abort = new AbortController();
    read(abort.signal)
      .then((total) => {
        if (abort.signal.aborted) return;
        if (baseline.current === null) baseline.current = total;
        const grown = total - baseline.current;
        setAdded(grown > 0 ? grown : null);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [active, refreshSignal, groupId, threadId]);

  return active ? added : null;
}

function defaultReader(groupId: string | undefined, threadId: string | undefined) {
  if (!groupId || !threadId) return undefined;
  return async (signal: AbortSignal) =>
    (await rpc.recruiting.roleCandidates({ groupId, threadId, limit: 1 }, { signal })).total;
}
