import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState, useSyncExternalStore } from "react";
import { readRetries } from "../lib/read-retry";
import { LoadingState } from "./ai/primitives";

/** One status while page reads wait out a restart, instead of each page loading silently. */
export function ServerRetryStatus() {
  const { t } = useLingui();
  const retrying = useSyncExternalStore(readRetries.subscribe, readRetries.getSnapshot);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!retrying) {
      setShown(false);
      return;
    }
    // A blip that recovers on the first retry is not worth a status.
    const timer = setTimeout(() => setShown(true), 2_000);
    return () => clearTimeout(timer);
  }, [retrying]);
  if (!shown) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-full border border-border bg-card px-4 py-2 text-sm shadow-sm">
        <LoadingState label={t`Reconnecting`} />
        <span className="text-muted-foreground">
          <Trans>Can&apos;t reach the server.</Trans>
        </span>
      </div>
    </div>
  );
}
