import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@rakazo/ui-web";
import { CircleCheck, CircleHelp, CircleX, Scale } from "lucide-react";
import type { RequirementRow, RequirementStatus } from "./profile";
import { sourceLabel } from "./profile";

const ICONS: Record<RequirementStatus, { Icon: typeof CircleCheck; className: string }> = {
  match: { Icon: CircleCheck, className: "text-success" },
  gap: { Icon: CircleX, className: "text-destructive" },
  partial: { Icon: Scale, className: "text-warning" },
  unknown: { Icon: CircleHelp, className: "text-muted-foreground" },
};

/**
 * Autumn's own assessment of one candidate, one row per requirement with its evidence as
 * returned. Display only: nothing here re-ranks or re-judges the candidate.
 */
export function AssessmentCard({
  score,
  rank,
  summary,
  scope,
  rows,
  sourceUrls,
}: {
  score: string | null;
  rank: { label: string; value: string } | null;
  summary: string | null;
  scope: string | null;
  rows: readonly RequirementRow[];
  sourceUrls: readonly string[];
}) {
  const { t } = useLingui();
  const statusLabel: Record<RequirementStatus, string | null> = {
    match: t`Match`,
    gap: t`Gap`,
    partial: t`Partial match`,
    unknown: null,
  };
  const counts = (["match", "partial", "gap"] as const)
    .map((status) => ({ status, count: rows.filter((row) => row.status === status).length }))
    .filter((item) => item.count);
  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        {score ? <Badge variant="secondary">{score}</Badge> : null}
        {rank ? (
          <span className="text-xs text-muted-foreground">
            {rank.label} {rank.value}
          </span>
        ) : null}
        {counts.length ? (
          <span className="ms-auto flex items-center gap-2 text-xs text-muted-foreground">
            {counts.map(({ status, count }) => {
              const { Icon, className } = ICONS[status];
              return (
                <span
                  key={status}
                  className="flex items-center gap-0.5"
                  title={statusLabel[status] ?? undefined}
                >
                  <Icon size={13} aria-hidden className={className} />
                  <span className="sr-only">{statusLabel[status]}</span>
                  {count}
                </span>
              );
            })}
          </span>
        ) : null}
      </div>
      {summary ? <p className="whitespace-pre-wrap">{summary}</p> : null}
      {scope ? <p className="text-xs text-muted-foreground">{scope}</p> : null}
      {rows.length ? (
        <ul className="space-y-3">
          {rows.map((row) => {
            const { Icon, className } = ICONS[row.status];
            const label = statusLabel[row.status];
            return (
              <li key={row.key} className="flex gap-2">
                <Icon size={16} aria-hidden className={`mt-0.5 shrink-0 ${className}`} />
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    {label ? <span className="font-medium">{label}</span> : null}
                    {row.label ? (
                      <span className="text-xs text-muted-foreground">{row.label}</span>
                    ) : null}
                  </p>
                  {row.text ? <p className="whitespace-pre-wrap">{row.text}</p> : null}
                  <SourceLinks urls={row.sourceUrls} />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {sourceUrls.length ? (
        <p className="flex flex-wrap items-center gap-x-2 border-t pt-2 text-xs text-muted-foreground">
          <Trans>Sources</Trans>
          <SourceLinks urls={sourceUrls} />
        </p>
      ) : null}
    </div>
  );
}

export function SourceLinks({ urls }: { urls: readonly string[] }) {
  if (!urls.length) return null;
  return (
    <span className="flex flex-wrap gap-x-2 text-xs">
      {urls.map((url) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" className="underline">
          {sourceLabel(url)}
        </a>
      ))}
    </span>
  );
}
