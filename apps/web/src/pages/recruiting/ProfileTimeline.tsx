import { Trans, useLingui } from "@lingui/react/macro";
import { recruitingCandidateSourceText } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { CompanyLogo, OrgBadge } from "./OrgBadge";
import type { ProfileAssets } from "./profileAssets";
import { organizationLogo, profileImageUrl } from "./profileAssets";
import type { TimelineEntry, TimelineKind } from "./profileTimelineModel";
import { parseTimeline, structuredProfileTimeline, timelineStats } from "./profileTimelineModel";
import { organizationKey } from "./quickOutput";

type TimelineField = {
  label: string;
  value: string | null;
  sourceUrls: readonly string[];
  timelineEntries?: readonly TimelineEntry[];
  sourceText?: string;
  evidence?: string;
  reasoning?: string;
  structuredValue?: unknown;
  sourceUrlsById?: Record<string, readonly string[]>;
};
type SourcesRenderer = (props: { urls: readonly string[] }) => ReactNode;

/** The organization's own site, from a website the entry itself supplied. */
function websiteUrl(host: string | undefined) {
  return host ? `https://${host}/` : null;
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
  hosts,
  Sources,
}: {
  entry: TimelineEntry;
  kind: TimelineKind;
  asset?: ProfileAssets["company"];
  link?: ProfileAssets["companyLink"];
  hosts?: ReadonlyMap<string, string>;
  Sources: SourcesRenderer;
}) {
  const duration = useDuration();
  const { t } = useLingui();
  if (!entry.structured) {
    return <li className="break-words whitespace-pre-wrap text-sm">{entry.text}</li>;
  }
  const logoName =
    entry.organization !== undefined
      ? entry.organization
      : kind === "experience"
        ? (entry.secondary ?? entry.primary)
        : entry.primary;
  // An entry without its own site uses the site returned for the same organization elsewhere.
  const website = entry.website ?? (logoName ? hosts?.get(organizationKey(logoName)) : undefined);
  const href =
    profileImageUrl(entry.organizationUrl) ??
    websiteUrl(website) ??
    organizationLogo(logoName ?? undefined, link ?? null);
  const organization = (name: string) => {
    const badge = <OrgBadge name={name} host={website} logo={false} />;
    return href ? (
      <a href={href} target="_blank" rel="noreferrer">
        {badge}
      </a>
    ) : (
      badge
    );
  };
  const dateLabel = entry.current ? `${entry.startLabel} – ${t`Present`}` : entry.dateLabel;
  return (
    <li className="flex gap-3">
      {logoName ? (
        <CompanyLogo
          name={logoName}
          src={profileImageUrl(entry.logoUrl) ?? organizationLogo(logoName, asset ?? null)}
          host={website}
        />
      ) : (
        <span aria-hidden className="size-10 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0 break-words">
            <p className="text-sm font-semibold">
              {kind === "education" || (entry.organization && !entry.secondary)
                ? organization(entry.primary)
                : entry.primary}
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
        {entry.sourceUrls?.length ? (
          <div className="mt-2">
            <Sources urls={entry.sourceUrls} />
          </div>
        ) : null}
        {entry.description ? (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              <Trans>Description</Trans>
            </summary>
            <p className="mt-2 break-words whitespace-pre-wrap leading-relaxed">
              {entry.description}
            </p>
          </details>
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
  hosts,
}: {
  fields: readonly TimelineField[];
  kind: TimelineKind;
  Sources: SourcesRenderer;
  asset?: ProfileAssets["company"];
  link?: ProfileAssets["companyLink"];
  hosts?: ReadonlyMap<string, string>;
}) {
  const now = useMemo(() => new Date(), []);
  const parsed = useMemo(
    () =>
      fields.map((field) => ({
        field,
        entries:
          field.timelineEntries ??
          (field.structuredValue !== undefined
            ? structuredProfileTimeline(field.structuredValue, kind, now, field.sourceUrlsById)
            : parseTimeline(field.value, kind, now)),
      })),
    [fields, kind, now],
  );
  const all = parsed.flatMap((item) => item.entries);
  const structured = parsed.some(
    ({ field, entries }) =>
      (field.timelineEntries || field.structuredValue !== undefined) &&
      entries.some((entry) => entry.structured),
  );
  return (
    <div className="space-y-4">
      {kind === "experience" ? <StatTiles entries={all} /> : null}
      {parsed.map(({ field, entries }, fieldIndex) =>
        structured &&
        !field.timelineEntries &&
        field.structuredValue === undefined &&
        !entries.some((entry) => entry.structured) ? (
          <details key={`${fieldIndex}-${field.label}`} className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">{field.label}</summary>
            <div className="mt-2 space-y-2 break-words whitespace-pre-wrap leading-relaxed">
              {[field.value, field.evidence, field.reasoning].filter(Boolean).map((text, index) => (
                <p key={index}>{text}</p>
              ))}
              <Sources urls={field.sourceUrls} />
            </div>
          </details>
        ) : (
          <div key={`${fieldIndex}-${field.label}`} className="space-y-2">
            <ul className="space-y-4">
              {entries.map((entry, index) => (
                <Row
                  key={`${index}-${entry.text}`}
                  entry={entry}
                  kind={kind}
                  asset={asset}
                  link={link}
                  hosts={hosts}
                  Sources={Sources}
                />
              ))}
            </ul>
            {field.evidence ? (
              <p className="break-words whitespace-pre-wrap text-sm">{field.evidence}</p>
            ) : null}
            {field.reasoning ? (
              <p className="break-words whitespace-pre-wrap text-sm text-muted-foreground">
                {field.reasoning}
              </p>
            ) : null}
            {field.timelineEntries || field.structuredValue !== undefined ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  <Trans>Source text</Trans>
                </summary>
                <p className="mt-2 break-words whitespace-pre-wrap leading-relaxed">
                  {field.sourceText ??
                    (field.structuredValue !== undefined
                      ? recruitingCandidateSourceText(field.structuredValue)
                      : field.value)}
                </p>
              </details>
            ) : null}
            <Sources urls={field.sourceUrls} />
          </div>
        ),
      )}
    </div>
  );
}

export function ExperienceTimeline(props: {
  fields: readonly TimelineField[];
  Sources: SourcesRenderer;
  asset?: ProfileAssets["company"];
  link?: ProfileAssets["companyLink"];
  hosts?: ReadonlyMap<string, string>;
}) {
  return <Timeline {...props} kind="experience" />;
}

export function EducationTimeline(props: {
  fields: readonly TimelineField[];
  Sources: SourcesRenderer;
  asset?: ProfileAssets["company"];
  link?: ProfileAssets["companyLink"];
  hosts?: ReadonlyMap<string, string>;
}) {
  return <Timeline {...props} kind="education" />;
}
