import { Trans, useLingui } from "@lingui/react/macro";
import { Badge, Button } from "@rakazo/ui-web";
import { ChevronDown, CircleCheck, CircleHelp, CircleX, Scale } from "lucide-react";
import { useState } from "react";
import { OrgBadge } from "./OrgBadge";
import type { RequirementRow, RequirementStatus } from "./profile";
import { sourceLabel } from "./profile";

const ICONS: Record<RequirementStatus, { Icon: typeof CircleCheck; className: string }> = {
  match: { Icon: CircleCheck, className: "text-success" },
  gap: { Icon: CircleX, className: "text-destructive" },
  partial: { Icon: Scale, className: "text-warning" },
  unknown: { Icon: CircleHelp, className: "text-muted-foreground" },
};

export type QuickOutput = {
  headline: string | null;
  highlights: readonly string[];
  keyWorks: readonly { title: string; detail: string | null; url: string | null }[];
  concerns: readonly string[];
  entities: readonly {
    name: string;
    kind: string | null;
    host: string | null;
    description: string | null;
  }[];
};

/** The longest returned organization whose name the tag mentions. */
function entityIn(tag: string, entities: QuickOutput["entities"]) {
  const text = tag.toLowerCase();
  return entities
    .filter((entity) => text.includes(entity.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/**
 * Autumn's own assessment of one candidate: its short headline, tags and per-criterion verdicts
 * first, with each criterion's full evidence and the full summary one click away. Display only:
 * nothing here re-ranks or re-judges the candidate.
 */
export function AssessmentCard({
  score,
  rank,
  summary,
  quick,
  rows,
  sourceUrls,
}: {
  score: string | null;
  rank: { label: string; value: string } | null;
  summary: string | null;
  quick: QuickOutput;
  rows: readonly RequirementRow[];
  sourceUrls: readonly string[];
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [summaryOpen, setSummaryOpen] = useState(false);
  const statusLabel: Record<RequirementStatus, string | null> = {
    match: t`Match`,
    gap: t`Gap`,
    partial: t`Partial match`,
    unknown: null,
  };
  const counts = (["match", "partial", "gap"] as const)
    .map((status) => ({ status, count: rows.filter((row) => row.status === status).length }))
    .filter((item) => item.count);
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
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
      {quick.headline ? <p className="text-base font-medium">{quick.headline}</p> : null}
      {quick.highlights.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {quick.highlights.map((tag) => {
            const entity = entityIn(tag, quick.entities);
            return (
              <li key={tag}>
                <Badge variant="secondary">
                  {entity ? (
                    <OrgBadge
                      name={entity.name}
                      label={tag}
                      host={entity.host}
                      kind={entity.kind}
                      description={entity.description}
                    />
                  ) : (
                    tag
                  )}
                </Badge>
              </li>
            );
          })}
        </ul>
      ) : null}
      {quick.keyWorks.length ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            <Trans>Key work</Trans>
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {quick.keyWorks.map((work) => {
              const body = (
                <>
                  {work.title}
                  {work.detail ? (
                    <span className="font-normal text-muted-foreground">{work.detail}</span>
                  ) : null}
                </>
              );
              return (
                <li key={work.title}>
                  {work.url ? (
                    <Badge
                      variant="outline"
                      render={<a href={work.url} target="_blank" rel="noreferrer" />}
                    >
                      {body}
                    </Badge>
                  ) : (
                    <Badge variant="outline">{body}</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {quick.concerns.length ? (
        <div className="space-y-0.5 rounded-md bg-muted px-3 py-2">
          <p className="text-xs font-medium text-warning">
            <Trans>Worth checking</Trans>
          </p>
          <ul className="list-inside list-disc">
            {quick.concerns.map((concern) => (
              <li key={concern}>{concern}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {rows.length ? (
        <ul className="divide-y border-y">
          {rows.map((row) => {
            const { Icon, className } = ICONS[row.status];
            const label = statusLabel[row.status];
            const name = row.brief?.name ?? row.label;
            const verdict = row.brief?.verdict ?? null;
            const expanded = open.has(row.key);
            const hasDetail = Boolean(row.text || row.sourceUrls.length);
            return (
              <li key={row.key}>
                <button
                  type="button"
                  className="flex min-h-9 w-full items-center gap-2 py-1.5 text-start disabled:cursor-default"
                  aria-expanded={hasDetail ? expanded : undefined}
                  disabled={!hasDetail}
                  onClick={() => toggle(row.key)}
                >
                  <Icon
                    size={16}
                    aria-label={label ?? undefined}
                    className={`shrink-0 ${className}`}
                  />
                  {name ? <span className="shrink-0 font-medium">{name}</span> : null}
                  <span
                    className={`min-w-0 flex-1 text-muted-foreground ${expanded ? "" : "truncate"}`}
                  >
                    {verdict ?? (expanded ? null : row.text)}
                  </span>
                  {hasDetail ? (
                    <ChevronDown
                      size={14}
                      aria-hidden
                      className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
                    />
                  ) : null}
                </button>
                {expanded ? (
                  <div className="space-y-0.5 pb-2 ps-6">
                    {row.text ? (
                      <p className="whitespace-pre-wrap text-muted-foreground">{row.text}</p>
                    ) : null}
                    <SourceLinks urls={row.sourceUrls} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {summary ? (
        quick.headline && !summaryOpen ? (
          <Button size="sm" variant="ghost" onClick={() => setSummaryOpen(true)}>
            <Trans>Full assessment</Trans>
          </Button>
        ) : (
          <div className="space-y-1">
            <p
              className={`whitespace-pre-wrap text-muted-foreground ${summaryOpen ? "" : "line-clamp-3"}`}
            >
              {summary}
            </p>
            <Button size="sm" variant="ghost" onClick={() => setSummaryOpen((value) => !value)}>
              {summaryOpen ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
            </Button>
          </div>
        )
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
