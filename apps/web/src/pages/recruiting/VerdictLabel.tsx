import { Trans } from "@lingui/react/macro";
import type { Verdict } from "@rakazo/contracts";
import { Check, CircleHelp, X } from "lucide-react";
export function VerdictLabel({ verdict, label }: { verdict: Verdict; label?: string }) {
  const Icon = verdict === "met" ? Check : verdict === "unmet" ? X : CircleHelp;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${verdict === "met" ? "text-success" : verdict === "unmet" ? "text-destructive" : "text-warning"}`}
    >
      <Icon size={14} aria-hidden />
      {label ??
        (verdict === "met" ? (
          <Trans>Met</Trans>
        ) : verdict === "unmet" ? (
          <Trans>Unmet</Trans>
        ) : (
          <Trans>Unknown</Trans>
        ))}
    </span>
  );
}
