import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@rakazo/ui-web";
import { CircleCheck, CircleHelp, CircleX, Scale } from "lucide-react";
import { HighlightText } from "./evidence";
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
  keywords = [],
}: {
  score: string | null;
  rank: { label: string; value: string } | null;
  summary: string | null;
  scope: string | null;
  rows: readonly RequirementRow[];
  sourceUrls: readonly string[];
  keywords?: readonly string[];
}) {
  const { t } = useLingui();
  const statusLabel: Record<RequirementStatus, string> = {
    match: t`Match`,
    gap: t`Gap`,
    partial: t`Partial match`,
    unknown: t`Unknown`,
  };
  const counts = (["match", "partial", "gap", "unknown"] as const)
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
      {summary ? (
        <p className="break-words whitespace-pre-wrap">
          <HighlightText text={summary} terms={keywords} />
        </p>
      ) : null}
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
                    {row.label ? (
                      <span className="break-words font-medium">{row.label}</span>
                    ) : row.criterionId ? (
                      <span className="font-medium text-muted-foreground">
                        <Trans>Criterion name unavailable</Trans>
                      </span>
                    ) : null}
                    {row.criterionId ? (
                      <span className="text-xs text-muted-foreground">{row.criterionId}</span>
                    ) : null}
                    <span className={`text-xs ${className}`}>{label}</span>
                  </p>
                  {row.text ? (
                    <p className="break-words whitespace-pre-wrap">
                      <HighlightText
                        text={row.text}
                        terms={[...keywords, ...(row.label ? [row.label] : [])]}
                      />
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      <Trans>No evidence provided.</Trans>
                    </p>
                  )}
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
