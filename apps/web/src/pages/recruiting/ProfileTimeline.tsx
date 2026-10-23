import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { ProfileImage } from "./ProfileImage";
import type { ProfileAssets } from "./profileAssets";
import { organizationLogo } from "./profileAssets";
import type { TimelineEntry, TimelineKind } from "./profileTimeline";
import { parseTimeline, timelineStats } from "./profileTimeline";

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

/** An explicitly supplied company/school image, otherwise initials. */
export function CompanyLogo({ name, src }: { name: string; src?: string | null }) {
  return (
    <ProfileImage
      src={src}
      fallback={logoInitials(name)}
      className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-xs font-medium text-muted-foreground"
    />
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
  asset,
  link,
}: {
  entry: TimelineEntry;
  kind: TimelineKind;
  asset?: ProfileAssets["company"];
  link?: ProfileAssets["companyLink"];
}) {
  const duration = useDuration();
  const { t } = useLingui();
  if (!entry.structured) {
    return <li className="break-words whitespace-pre-wrap text-sm">{entry.text}</li>;
  }
  const logoName = kind === "experience" ? (entry.secondary ?? entry.primary) : entry.primary;
  const href = organizationLogo(logoName, link ?? null);
  const organization = (name: string) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
        {name}
      </a>
    ) : (
      name
    );
  const dateLabel = entry.current ? `${entry.startLabel} – ${t`Present`}` : entry.dateLabel;
  return (
    <li className="flex gap-3">
      <CompanyLogo name={logoName} src={organizationLogo(logoName, asset ?? null)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0 break-words">
            <p className="text-sm font-semibold">
              {kind === "education" ? organization(entry.primary) : entry.primary}
            </p>
            {entry.secondary ? (
              <p className="text-sm">
                {kind === "experience" ? organization(entry.secondary) : entry.secondary}
              </p>
            ) : null}
          </div>
          {dateLabel ? (
            <div className="text-xs text-muted-foreground">
              <p>{dateLabel}</p>
              {entry.months ? <p>{duration(entry.months)}</p> : null}
            </div>
          ) : null}
        </div>
        {entry.detail ? (
          <p className="mt-1 break-words text-xs text-muted-foreground">{entry.detail}</p>
        ) : null}
      </div>
    </li>
  );
}

function Timeline({
  fields,
  kind,
  Sources,
  asset,
  link,
}: {
  fields: readonly TimelineField[];
  kind: TimelineKind;
  Sources: SourcesRenderer;
  asset?: ProfileAssets["company"];
  link?: ProfileAssets["companyLink"];
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
                asset={asset}
                link={link}
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
  asset?: ProfileAssets["company"];
  link?: ProfileAssets["companyLink"];
}) {
  return <Timeline {...props} kind="experience" />;
}

export function EducationTimeline(props: {
  fields: readonly TimelineField[];
  Sources: SourcesRenderer;
  asset?: ProfileAssets["company"];
  link?: ProfileAssets["companyLink"];
}) {
  return <Timeline {...props} kind="education" />;
}
