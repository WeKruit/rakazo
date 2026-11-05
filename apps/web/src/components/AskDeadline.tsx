import { useLingui } from "@lingui/react/macro";
import { formatWorkDuration } from "@rakazo/core";
import { useEffect, useState } from "react";

/** Shown only in the last hour: a day-long countdown on every new question reads as pressure. */
const SHOW_WITHIN_MS = 60 * 60_000;

/** The server's waiting episode supplies the deadline; a reconnect never resets it. */
export function AskDeadline({ expiresAt }: { expiresAt: string }) {
  const { t } = useLingui();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  if (remaining > SHOW_WITHIN_MS) return null;
  const time = formatWorkDuration(Math.ceil(remaining / 60_000) * 60_000);
  return (
    <time
      dateTime={expiresAt}
      data-testid="ask-deadline"
      className="mt-2 block text-xs text-muted-foreground"
    >
      {remaining > 0 ? t`Expires in ${time}` : t`Expired`}
    </time>
  );
}
