import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import type { ReactNode } from "react";

/** A failed read, compact, with a Retry that re-runs only that read. */
export function RetryNotice({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 py-3 text-sm text-destructive">
      <span>{children}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <Trans>Retry</Trans>
      </Button>
    </div>
  );
}
