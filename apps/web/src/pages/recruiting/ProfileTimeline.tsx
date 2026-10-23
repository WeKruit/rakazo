import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { TimelineEntry, TimelineKind } from "./profileTimeline";
import { companyHost, parseTimeline, timelineStats } from "./profileTimeline";

type TimelineField = { label: string; value: string | null; sourceUrls: readonly string[] };
type SourcesRenderer = (props: { urls: readonly string[] }) => ReactNode;

function logoInitials(name: string) {
  const letters = [...name].filter((char) => /\p{L}|\p{N}/u.test(char));
  const words = name.split(/\s+/).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => [...word][0] ?? "")
      .join("")
      .toUpperCase();
  }
  return letters.slice(0, 2).join("").toUpperCase();
}

/** Initials on a muted tile; a favicon from the field's own source host replaces them when it loads. */
export function CompanyLogo({ name, host }: { name: string; host?: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-xs font-medium text-muted-foreground"
    >
      {host && !failed ? (
        <img
          src={`https://${host}/favicon.ico`}
          alt=""
          className="size-full object-contain"
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        logoInitials(name)
      )}
    </span>
  );
}

function useDuration() {
  const { t } = useLingui();
  return (months: number) => {
    const years = Math.floor(months / 12);
    const rest = months % 12;
    const y = years ? (years === 1 ? t`${years} yr` : t`${years} yrs`) : "";
    const m = rest || !years ? (rest === 1 ? t`${rest} mo` : t`${rest} mos`) : "";
    return [y, m].filter(Boolean).join(" ");
  };
}

function StatTiles({ entries }: { entries: readonly TimelineEntry[] }) {
  const duration = useDuration();
  const stats = timelineStats(entries);
  if (!stats) return null;
  return (
    <dl className="grid grid-cols-3 gap-2">
      {[
        { key: "avg", label: <Trans>Avg tenure</Trans>, months: stats.average },
        { key: "current", label: <Trans>Current tenure</Trans>, months: stats.current },
        { key: "total", label: <Trans>Total experience</Trans>, months: stats.total },
      ].map((tile) => (
        <div key={tile.key} className="rounded-md bg-muted px-3 py-2">
          <dt className="text-xs text-muted-foreground">{tile.label}</dt>
          <dd className="text-sm font-medium">
            {tile.months === null || tile.months === undefined ? "—" : duration(tile.months)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Row({
  entry,
  kind,
  sourceUrls,
}: {
  entry: TimelineEntry;
  kind: TimelineKind;
  sourceUrls: readonly string[];
}) {
  const duration = useDuration();
  const { t } = useLingui();
  if (!entry.structured) {
    return <li className="whitespace-pre-wrap text-sm">{entry.text}</li>;
  }
  const logoName = kind === "experience" ? (entry.secondary ?? entry.primary) : entry.primary;
  const dateLabel = entry.current ? `${entry.startLabel} – ${t`Present`}` : entry.dateLabel;
  return (
    <li className="flex gap-3">
      <CompanyLogo
        name={logoName}
        host={kind === "experience" ? companyHost(entry.secondary, sourceUrls) : null}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{entry.primary}</p>
            {entry.secondary ? <p className="text-sm">{entry.secondary}</p> : null}
          </div>
          {dateLabel ? (
            <div className="shrink-0 text-right text-xs text-muted-foreground">
              <p>{dateLabel}</p>
              {entry.months ? <p>{duration(entry.months)}</p> : null}
            </div>
          ) : null}
        </div>
        {entry.detail ? <p className="text-xs text-muted-foreground">{entry.detail}</p> : null}
      </div>
    </li>
  );
}

function Timeline({
  fields,
  kind,
  Sources,
}: {
  fields: readonly TimelineField[];
  kind: TimelineKind;
  Sources: SourcesRenderer;
}) {
  const now = useMemo(() => new Date(), []);
  const parsed = useMemo(
    () => fields.map((field) => ({ field, entries: parseTimeline(field.value, kind, now) })),
    [fields, kind, now],
  );
  const all = parsed.flatMap((item) => item.entries);
  return (
    <div className="space-y-4">
      {kind === "experience" ? <StatTiles entries={all} /> : null}
      {parsed.map(({ field, entries }) => (
        <div key={field.label} className="space-y-2">
          <ul className="space-y-4">
            {entries.map((entry, index) => (
              <Row
                key={`${index}-${entry.text}`}
                entry={entry}
                kind={kind}
                sourceUrls={field.sourceUrls}
              />
            ))}
          </ul>
          <Sources urls={field.sourceUrls} />
        </div>
      ))}
    </div>
  );
}

export function ExperienceTimeline(props: {
  fields: readonly TimelineField[];
  Sources: SourcesRenderer;
}) {
  return <Timeline {...props} kind="experience" />;
}

export function EducationTimeline(props: {
  fields: readonly TimelineField[];
  Sources: SourcesRenderer;
}) {
  return <Timeline {...props} kind="education" />;
}
