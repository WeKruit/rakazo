import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { supportMailto, useSupportEmail } from "../lib/support";

/** Warn before credits run out: new work stops at zero (CREDITS_EXHAUSTED). */
export const LOW_CREDITS = 1_000;
const RECHECK_MS = 5 * 60_000;

export function CreditsNotice() {
  const [remaining, setRemaining] = useState<number | null>(null);
  const email = useSupportEmail();
  useEffect(() => {
    let active = true;
    const read = () =>
      rpc.usage
        .costs()
        .then((usage) => {
          if (active) setRemaining(usage.remaining);
        })
        .catch(() => undefined);
    void read();
    const timer = setInterval(read, RECHECK_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  if (remaining == null || remaining > LOW_CREDITS) return null;
  const left = Math.floor(remaining);
  return (
    <div
      role="status"
      data-testid="credits-notice"
      className="mx-3 mb-1 rounded-lg bg-muted px-3 py-2 text-[13px]"
    >
      <p className="text-foreground">
        {left > 0 ? <Trans>{left} credits left</Trans> : <Trans>Credits used up</Trans>}
      </p>
      {email ? (
        <a className="text-muted-foreground underline" href={supportMailto(email, "Add credits")}>
          <Trans>Contact us to add more</Trans>
        </a>
      ) : null}
    </div>
  );
}
