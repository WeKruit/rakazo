import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingRoleCampaign } from "@rakazo/contracts";
import { Badge } from "@rakazo/ui-web";
import { CalendarDays, MousePointer2, Send } from "lucide-react";

/** Counts of the supplied observations only, never campaign reach or conversion rates. */
export function sequenceObservations(campaign: RecruitingRoleCampaign | undefined) {
  if (campaign?.status !== "ready" || !campaign.campaign) {
    return { active: null, interested: null, partial: false };
  }
  const active = campaign.leads.filter((lead) => lead.status === 1).length;
  const interested = campaign.leads.filter(
    (lead) => lead.interestStatus !== null && [1, 2, 3, 4].includes(lead.interestStatus),
  ).length;
  const complete = campaign.leadsComplete === true;
  return {
    active: complete ? active : active || null,
    interested: complete ? interested : interested || null,
    partial: !complete,
  };
}

export function datedSends(dates: readonly string[], now: Date, days = 7) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const start = end - (days - index - 1) * 86_400_000;
    return {
      start,
      count: dates.filter((value) => {
        // A date without its source timezone cannot establish an exact send instant.
        if (!/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return false;
        const timestamp = Date.parse(value);
        return (
          Number.isFinite(timestamp) &&
          timestamp <= now.getTime() &&
          timestamp >= start &&
          timestamp < start + 86_400_000
        );
      }).length,
    };
  });
}

/** Presentation over existing saved reads; unreported mail telemetry remains visibly unknown. */
export function SequenceOverview({
  campaign,
  replied,
  sendDates = null,
  sendContext,
  now = new Date(),
}: {
  campaign?: RecruitingRoleCampaign;
  /** A complete authorized CRM count, or null while partial/unavailable. */
  replied: number | null;
  /** Exact role-proven sentAt timestamps only; null means role activity is unavailable. */
  sendDates?: readonly string[] | null;
  /** Exact record scope for the supplied send dates, such as the selected contact. */
  sendContext?: string | null;
  now?: Date;
}) {
  const { t, i18n } = useLingui();
  const locale = i18n?.locale || "en";
  const observed = sequenceObservations(campaign);
  const metrics = [
    { label: t`Contacted`, value: null, observed: false },
    { label: t`Active`, value: observed.active, observed: observed.partial },
    { label: t`Opened`, value: null, observed: false },
    { label: t`Clicked`, value: null, observed: false },
    { label: t`Replied`, value: replied, observed: false },
    { label: t`Interested`, value: observed.interested, observed: observed.partial },
  ];
  const days = datedSends(sendDates ?? [], now);
  const max = Math.max(1, ...days.map((day) => day.count));
  const hasDatedSends = days.some((day) => day.count > 0);
  return (
    <div className="mb-6 space-y-4">
      <dl className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-xl border bg-card sm:grid-cols-3 xl:grid-cols-6">
        {metrics.map((metric) => (
          <div key={metric.label} className="min-w-0 px-4 py-4">
            <dt className="text-xs text-muted-foreground">{metric.label}</dt>
            <dd className="mt-2 text-2xl font-semibold tabular-nums">
              {metric.value === null ? (
                <>
                  <span aria-hidden>—</span>
                  <span className="sr-only">
                    <Trans>Not reported</Trans>
                  </span>
                </>
              ) : (
                <>
                  {metric.observed ? "≥ " : ""}
                  {metric.value}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <Trans>— Not reported</Trans>
        </span>
        {metrics.some((metric) => metric.observed && metric.value !== null) ? (
          <span>
            <Trans>≥ Observed in loaded records</Trans>
          </span>
        ) : null}
      </div>
      <section aria-label={t`Recorded send activity`} className="rounded-xl border bg-card p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Send size={15} aria-hidden /> <Trans>Recorded send activity</Trans>
          </h3>
          <Badge variant="outline">
            <CalendarDays size={12} aria-hidden /> <Trans>Last 7 days · UTC</Trans>
          </Badge>
        </div>
        {sendContext ? (
          <p className="mb-3 break-words text-sm text-muted-foreground">{sendContext}</p>
        ) : null}
        {hasDatedSends ? (
          <ol className="grid h-36 grid-cols-7 items-end gap-2">
            {days.map((day) => {
              const label = new Intl.DateTimeFormat(locale, {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              }).format(day.start);
              return (
                <li
                  key={day.start}
                  className="flex h-full min-w-0 flex-col items-center justify-end gap-1"
                >
                  <span className="text-xs tabular-nums">{day.count}</span>
                  <span
                    aria-hidden
                    className="w-full max-w-12 rounded-t bg-primary"
                    style={{ height: `${(day.count / max) * 75}%`, minHeight: day.count ? 2 : 0 }}
                  />
                  <span className="text-xs text-muted-foreground">{label}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground">
            <MousePointer2 size={20} aria-hidden />
            <p>
              {sendDates === null ? (
                <Trans>Recruiter messages are unavailable for this role.</Trans>
              ) : (
                <Trans>No dated sends in the available records.</Trans>
              )}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
