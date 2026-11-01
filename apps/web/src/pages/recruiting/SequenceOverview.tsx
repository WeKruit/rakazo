import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingRoleCampaign } from "@rakazo/contracts";
import { useState } from "react";

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

/** Historical telemetry is never relabeled as a date-filtered count. */
export function SequenceOverview({
  campaign,
  replied,
  sendDates = null,
  sendContext,
  now = new Date(),
  period = "all",
  detail = false,
  onMetric,
  overviewCounts,
  overviewPartial = false,
}: {
  overviewPartial?: boolean;
  overviewCounts?: Record<
    "contacted" | "active" | "opened" | "clicked" | "replied" | "interested",
    number | null
  >;
  campaign?: RecruitingRoleCampaign;
  replied: number | null;
  sendDates?: readonly string[] | null;
  sendContext?: string | null;
  now?: Date;
  period?: "all" | "30" | "90";
  detail?: boolean;
  onMetric?: (metric: "all" | "active" | "interested" | "bounced") => void;
}) {
  const { t, i18n } = useLingui();
  const locale = i18n?.locale || "en";
  const [chartPeriod, setChartPeriod] = useState(7);
  const observed = sequenceObservations(campaign);
  const ready = campaign?.status === "ready" && campaign.campaign !== null;
  const allTime = period === "all";
  const count = (status: number) => {
    if (!ready) return null;
    const found = campaign.leads.filter((lead) => lead.status === status).length;
    return campaign.leadsComplete ? found : found || null;
  };
  const metrics: {
    label: string;
    value: number | null;
    observed: boolean;
    filter?: "all" | "active" | "interested" | "bounced";
  }[] = [
    {
      label: detail ? t`Contacts` : t`Contacted`,
      value:
        detail && ready
          ? campaign.leadsComplete
            ? campaign.leads.length
            : campaign.leads.length || null
          : null,
      observed: observed.partial,
      ...(detail ? { filter: "all" as const } : {}),
    },
    {
      label: t`Active`,
      value: allTime ? observed.active : null,
      observed: observed.partial,
      filter: "active",
    },
    {
      label: t`Opened`,
      value: allTime && ready ? (campaign.stats?.opened ?? null) : null,
      observed: false,
    },
    { label: t`Clicked`, value: null, observed: false },
    { label: t`Replied`, value: allTime ? replied : null, observed: false },
    {
      label: t`Interested`,
      value: allTime ? observed.interested : null,
      observed: observed.partial,
      filter: "interested",
    },
    ...(detail
      ? [
          {
            label: t`Bounced`,
            value: allTime ? count(-1) : null,
            observed: observed.partial,
            filter: "bounced" as const,
          },
        ]
      : []),
  ];
  if (overviewCounts)
    (["contacted", "active", "opened", "clicked", "replied", "interested"] as const).forEach(
      (key, index) => {
        metrics[index]!.value = allTime ? overviewCounts[key] : null;
        metrics[index]!.observed = overviewPartial;
      },
    );
  const history = datedSends(sendDates ?? [], now, chartPeriod);
  const max = Math.max(1, ...history.map((day) => day.count));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ticks = Array.from(
    { length: chartPeriod * 2 },
    (_, index) => today + (index - chartPeriod + 1) * 86400000,
  );
  const hasDatedSends = history.some((day) => day.count > 0);
  const unknown = t`Not reported`;
  if (
    overviewCounts &&
    !detail &&
    allTime &&
    metrics.every((metric) => metric.value === null) &&
    !sendContext &&
    !hasDatedSends
  )
    return (
      <p role="status" className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
        {t`No saved activity metrics are available for these sequences.`}
      </p>
    );

  return (
    <div className="mb-6 space-y-4">
      <dl
        className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${detail ? "2xl:grid-cols-7" : "xl:grid-cols-6"}`}
      >
        {metrics.map((metric) => (
          <div key={metric.label} className="relative min-w-0 rounded-xl border bg-muted/20 p-4">
            <dt className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
              {onMetric && metric.filter ? (
                <button
                  type="button"
                  className="text-left hover:text-foreground hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-ring"
                  disabled={metric.value === null}
                  onClick={() => onMetric(metric.filter!)}
                >
                  {metric.label}
                </button>
              ) : (
                metric.label
              )}
              <span
                title={t`Change from previous period is not reported`}
                role="img"
                aria-label={t`Change from previous period: not reported`}
                className="after:content-['—']"
              />
            </dt>
            <dd className="mt-3 text-2xl font-semibold tabular-nums">
              {metric.value === null ? (
                <>
                  <span aria-hidden>—</span>
                  <span className="sr-only">{unknown}</span>
                </>
              ) : (
                <>
                  {metric.observed ? "≥ " : ""}
                  {metric.value.toLocaleString(locale)}
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
        {period !== "all" ? (
          <span role="status">
            <Trans>
              Date-filtered sequence metrics are not available. Historical totals stay unchanged
              below.
            </Trans>
          </span>
        ) : null}
        {metrics.some((metric) => metric.observed && metric.value !== null) ? (
          <span>
            <Trans>≥ Observed in loaded records</Trans>
          </span>
        ) : null}
      </div>
      <section
        aria-label={t`Recorded send activity`}
        className="min-w-0 rounded-xl border bg-card p-4 sm:p-5"
      >
        {overviewCounts && sendDates === null ? (
          <>
            <h3 className="mb-3 text-sm font-semibold">
              <Trans>Schedule</Trans>
            </h3>
            {sendContext ? (
              <p className="mb-3 break-words text-sm text-muted-foreground">{sendContext}</p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              <Trans>Send timing is not reported in saved sequence records.</Trans>
            </p>
          </>
        ) : (
          <>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-sm font-semibold">
                  <Trans>Schedule</Trans>
                </h3>
                <label className="text-xs">
                  <span className="sr-only">
                    <Trans>Schedule period</Trans>
                  </span>
                  <select
                    className="rounded-md border bg-background p-1.5 text-foreground"
                    aria-label={t`Schedule period`}
                    value={chartPeriod}
                    onChange={(event) => setChartPeriod(Number(event.target.value))}
                  >
                    <option value={7}>{t`7 day period`}</option>
                    <option value={14}>{t`14 day period`}</option>
                  </select>
                </label>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="size-2 rounded-full bg-primary" />
                  <Trans>Sent</Trans>
                </span>
                <span
                  className="flex items-center gap-1.5"
                  title={t`Scheduled sends are not reported`}
                >
                  <span
                    aria-hidden
                    className="size-2 rounded-full border border-muted-foreground"
                  />
                  <Trans>Scheduled · not reported</Trans>
                </span>
              </div>
            </div>
            {sendContext ? (
              <p className="mb-3 break-words text-sm text-muted-foreground">{sendContext}</p>
            ) : null}
            <div className="overflow-x-auto">
              <div className="min-w-[580px]">
                <div className="relative ms-7 h-40 border-b border-border">
                  {[0, 1, 2, 3].map((line) => (
                    <div
                      key={line}
                      className="absolute inset-x-0 border-t border-border/50"
                      style={{ bottom: `${line * 33}%` }}
                    >
                      <span className="absolute -start-7 -top-2 w-5 text-right text-[10px] text-muted-foreground">
                        {sendDates === null
                          ? "—"
                          : Math.round((max * line) / 3).toLocaleString(locale)}
                      </span>
                    </div>
                  ))}
                  <div className="relative flex h-full items-end">
                    {ticks.map((date) => {
                      const day = history.find((item) => item.start === date);
                      return (
                        <div
                          key={date}
                          className={`relative flex h-full min-w-0 flex-1 items-end justify-center ${date === today ? "border-s border-dashed border-foreground/60" : ""}`}
                        >
                          {date === today ? (
                            <span className="absolute -top-4 start-1 text-[10px] font-medium">
                              <Trans>Today</Trans>
                            </span>
                          ) : null}
                          {day?.count ? (
                            <div
                              className="z-10 w-3/5 max-w-8 rounded-t bg-primary"
                              role="img"
                              aria-label={t`${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date)}: ${day.count} recorded sends`}
                              style={{ height: `${(day.count / max) * 82}%` }}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {!hasDatedSends ? (
                    <div className="absolute inset-0 flex items-center justify-center px-8">
                      <p className="max-w-sm bg-card/90 p-3 text-center text-xs leading-relaxed text-muted-foreground">
                        {sendDates === null ? (
                          overviewCounts ? (
                            <Trans>Send timing is not reported in saved sequence records.</Trans>
                          ) : (
                            <Trans>Recruiter messages are unavailable for this role.</Trans>
                          )
                        ) : (
                          <Trans>No dated sends in the available records.</Trans>
                        )}
                      </p>
                    </div>
                  ) : null}
                </div>
                <div className="ms-7 flex pt-2">
                  {ticks.map((date, index) => (
                    <span
                      key={date}
                      className="min-w-0 flex-1 text-center text-[10px] text-muted-foreground"
                    >
                      {chartPeriod === 7 || index % 2 === 0
                        ? new Intl.DateTimeFormat(locale, {
                            month: "short",
                            day: "numeric",
                            timeZone: "UTC",
                          }).format(date)
                        : ""}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <p className="mt-3 text-right text-[10px] text-muted-foreground">
              <Trans>UTC · only recorded send timestamps are plotted</Trans>
            </p>
          </>
        )}
      </section>
    </div>
  );
}
