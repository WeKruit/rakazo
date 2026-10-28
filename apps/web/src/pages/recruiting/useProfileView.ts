import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";

type Status = "idle" | "recording" | "recorded" | "failed";

/** Keep one idempotency key per open person, across tab switches and refreshes. */
export function useProfileView({
  spaceId,
  roleId,
  candidateKey,
  visible,
}: {
  spaceId?: string;
  roleId?: string;
  candidateKey: string | null;
  visible: boolean;
}) {
  const key = roleId && candidateKey ? JSON.stringify([spaceId, roleId, candidateKey]) : null;
  const visit = useRef<{ key: string; viewId: string; recorded: boolean; pending: boolean } | null>(
    null,
  );
  const [state, setState] = useState<{ key: string; status: Status }>();
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (visit.current?.key !== key) visit.current = null;
    if (!key || !roleId || !candidateKey) return;
    // A failed visit can be retried from Activity, but a hidden profile cannot start a visit.
    if (!visible && !visit.current) return;
    if (visit.current?.recorded || visit.current?.pending) return;
    const current = visit.current ?? {
      key,
      viewId: crypto.randomUUID(),
      recorded: false,
      pending: false,
    };
    visit.current = current;
    current.pending = true;
    setState({ key, status: "recording" });
    rpc.recruiting.profileActivity
      .recordView({ roleId, candidateKey, viewId: current.viewId })
      .then(() => {
        if (!mounted.current || visit.current !== current) return;
        current.pending = false;
        current.recorded = true;
        setState({ key, status: "recorded" });
      })
      .catch(() => {
        if (!mounted.current || visit.current !== current) return;
        current.pending = false;
        setState({ key, status: "failed" });
        // View history is background record keeping: retry once quietly, never block the profile.
        if (attempt === 0) setTimeout(() => mounted.current && setAttempt(1), 3000);
      });
  }, [key, visible, attempt]);

  return {
    status: key && state?.key === key ? state.status : ("idle" as const),
    retry: () => setAttempt((value) => value + 1),
  };
}
