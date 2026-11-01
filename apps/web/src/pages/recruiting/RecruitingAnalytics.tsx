import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RecruitingAnalyticsInput,
  RecruitingAnalyticsOutput,
  RecruitingAnalyticsPeopleInput,
  RecruitingAnalyticsPeopleOutput,
} from "@rakazo/contracts";
import { Button, Card, CardContent, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AnalyticsPeopleDialog } from "./AnalyticsPeopleDialog";

function TrendChart({
  title,
  rows,
  metric,
  since,
  until,
}: {
  title: string;
  rows: RecruitingAnalyticsOutput["trend"];
  metric: "contacted" | "replied";
  since: string;
  until: string;
}) {
  const { t } = useLingui();
  const graph = useRef<SVGSVGElement>(null);
  const max = Math.max(1, ...rows.map((row) => row[metric]));
  const from = Date.parse(`${since}T00:00:00Z`);
  const span = Math.max(86400000, Date.parse(`${until}T00:00:00Z`) - from);
  const x = (date: string) =>
    48 + 480 * Math.max(0, Math.min(1, (Date.parse(`${date}T00:00:00Z`) - from) / span));
  const y = (value: number) => 180 - (value / max) * 140;
  return (
    <section className="min-w-0 rounded-xl border bg-card p-4" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t`Download ${title}`}
          onClick={() => {
            if (!graph.current) return;
            const url = URL.createObjectURL(
              new Blob([graph.current.outerHTML], { type: "image/svg+xml" }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = `${metric}-trend.svg`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Trans>Download</Trans>
        </Button>
      </div>
      <svg
        ref={graph}
        xmlns="http://www.w3.org/2000/svg"
        className="mt-4 w-full text-foreground"
        viewBox="0 0 560 220"
        role="img"
        aria-label={title}
      >
        {[0, max / 2, max].map((tick) => (
          <g key={tick}>
            <line
              x1="48"
              x2="536"
              y1={y(tick)}
              y2={y(tick)}
              stroke="currentColor"
              strokeOpacity=".1"
            />
            <text x="38" y={y(tick) + 4} textAnchor="end" fill="currentColor" fontSize="11">
              {Number.isInteger(tick) ? tick : tick.toFixed(1)}
            </text>
          </g>
        ))}
        {rows.length > 1 ? (
          <polyline
            points={rows.map((row) => `${x(row.date)},${y(row[metric])}`).join(" ")}
            stroke="currentColor"
            fill="none"
            strokeWidth="2"
          />
        ) : null}
        {rows.map((row) => (
          <circle key={row.date} cx={x(row.date)} cy={y(row[metric])} r="3" fill="currentColor">
            <title>{`${row.date}: ${row[metric]}`}</title>
          </circle>
        ))}
        <text x="48" y="208" fontSize="11" fill="currentColor">
          {since}
        </text>
        <text x="536" y="208" textAnchor="end" fontSize="11" fill="currentColor">
          {until}
        </text>
        {!rows.length ? (
          <text
            x="280"
            y="105"
            textAnchor="middle"
            fontSize="13"
            fill="currentColor"
          >{t`No observations in this period`}</text>
        ) : null}
      </svg>
    </section>
  );
}

export function RecruitingAnalytics({
  accountKey,
  load,
  onOpenRole,
  scopeRoleId,
  loadPeople,
}: {
  accountKey: string;
  load: (input: RecruitingAnalyticsInput) => Promise<RecruitingAnalyticsOutput>;
  onOpenRole?: (roleId: string) => void;
  scopeRoleId?: string;
  loadPeople?: (input: RecruitingAnalyticsPeopleInput) => Promise<RecruitingAnalyticsPeopleOutput>;
}) {
  const { t } = useLingui();
  const formId = useId();
  const [params, setParams] = useSearchParams();
  const since =
    params.get("analyticsSince") ?? new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const until = params.get("analyticsUntil") ?? new Date().toISOString().slice(0, 10);
  const roleId = params.get("role") === "all" ? "" : (params.get("role") ?? scopeRoleId ?? "");
  const filter = (name: string, value: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (name === "role") next.set(name, value || "all");
      else if (value) next.set(name, value);
      else next.delete(name);
      return next;
    });
  const [grouping, setGrouping] = useState<"day" | "week" | "month">("day");
  const [search, setSearch] = useState("");
  const [tableGroup, setTableGroup] = useState("role");
  const [metric, setMetric] = useState("all");
  const [breakdown, setBreakdown] = useState("none");
  const [people, setPeople] = useState<{
    key: string;
    metric: "contacted" | "replied" | "shortlisted";
    roleId?: string;
  }>();
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data?: RecruitingAnalyticsOutput;
    failed?: boolean;
  }>();
  const key = JSON.stringify([accountKey, since, until, roleId, retry]);
  const valid =
    [since, until].every((date) => {
      const parsed = new Date(`${date}T00:00:00Z`);
      return (
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        Number.isFinite(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === date
      );
    }) && since <= until;
  const data = result?.key === key ? result.data : undefined;
  const failed = result?.key === key && result.failed;
  // Retain role choices only within this account; old metrics never render for new filters.
  const [choices, setChoices] = useState<{
    accountKey: string;
    roles: RecruitingAnalyticsOutput["roles"];
  }>();
  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    void load({
      since: `${since}T00:00:00Z`,
      until: new Date(Date.parse(`${until}T00:00:00Z`) + 86400000).toISOString(),
      ...(roleId ? { roleId } : {}),
    })
      .then((next) => {
        if (cancelled) return;
        setResult({ key, data: next });
        setChoices({ accountKey, roles: next.roles });
      })
      .catch(() => {
        if (!cancelled) setResult({ key, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [key, accountKey, since, until, roleId, load, valid]);
  const roles = choices?.accountKey === accountKey ? choices.roles : [];
  const value = (count: number | null) => (count === null ? t`Unknown` : count.toLocaleString());
  const trend = [
    ...(data?.trend ?? [])
      .reduce((buckets, row) => {
        const date = new Date(`${row.date}T00:00:00Z`);
        if (grouping === "week") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
        if (grouping === "month") date.setUTCDate(1);
        const key = date.toISOString().slice(0, 10);
        const bucket = buckets.get(key) ?? { date: key, contacted: 0, replied: 0 };
        bucket.contacted += row.contacted;
        bucket.replied += row.replied;
        buckets.set(key, bucket);
        return buckets;
      }, new Map<string, RecruitingAnalyticsOutput["trend"][number]>())
      .values(),
  ];
  const tableRows = (
    tableGroup === "role"
      ? (data?.groups ?? []).map((row) => ({
          key: row.roleId,
          roleId: row.roleId,
          label: row.title,
          contacted: row.contacted,
          replied: row.replied,
        }))
      : trend.map((row) => ({
          key: row.date,
          roleId: undefined,
          label: row.date,
          contacted: row.contacted as number | null,
          replied: row.replied as number | null,
        }))
  )
    .flatMap((row) =>
      breakdown === "response" && row.contacted !== null && row.replied !== null
        ? [
            {
              ...row,
              key: `${row.key}:replied`,
              label: `${row.label} · ${t`Observed reply`}`,
              contacted: row.replied,
              replied: row.replied,
            },
            {
              ...row,
              key: `${row.key}:no-reply`,
              label: `${row.label} · ${t`No observed reply`}`,
              contacted: row.contacted - row.replied,
              replied: 0,
            },
          ]
        : [row],
    )
    .filter((row) => row.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const download = () => {
    if (!data) return;
    const csv = [
      [
        tableGroup === "role" ? t`Role` : t`Period`,
        t`Earliest observed contact in period`,
        t`Subsequently replied`,
      ],
      [
        t`Total · deduplicated people`,
        value(data.observedContactedPeople),
        value(data.observedRepliedPeople),
      ],
      ...tableRows.map((row) => [row.label, value(row.contacted), value(row.replied)]),
    ]
      .map((row) =>
        row
          .map(
            (cell) =>
              `"${(/^\s*[=+\-@]/.test(String(cell)) ? "'" : "") + String(cell).replace(/"/g, '""')}"`,
          )
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "outreach-analytics.csv";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="space-y-6 p-4 sm:p-6" aria-label={t`Recruiting analytics`}>
      <div>
        <h1 className="text-xl font-semibold leading-snug">
          <Trans>Analytics</Trans>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <Trans>People, deduplicated by saved identity.</Trans>
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label
          htmlFor={`${formId}-role`}
          className="w-full min-w-0 space-y-1 text-sm sm:w-auto sm:min-w-48 sm:flex-1"
        >
          <span>
            <Trans>Role</Trans>
          </span>
          <NativeSelect
            id={`${formId}-role`}
            name="analytics-role"
            value={roleId}
            onChange={(event) => filter("role", event.target.value)}
            aria-label={t`Role`}
          >
            <NativeSelectOption value="">
              <Trans>All roles</Trans>
            </NativeSelectOption>
            {roles.map((role) => (
              <NativeSelectOption key={role.id} value={role.id}>
                {role.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label htmlFor={`${formId}-since`} className="w-full min-w-0 space-y-1 text-sm sm:w-auto">
          <span>
            <Trans>From (UTC)</Trans>
          </span>
          <Input
            type="date"
            id={`${formId}-since`}
            name="analytics-since"
            autoComplete="off"
            value={since}
            max={until}
            onChange={(event) => filter("analyticsSince", event.target.value)}
          />
        </label>
        <label htmlFor={`${formId}-until`} className="w-full min-w-0 space-y-1 text-sm sm:w-auto">
          <span>
            <Trans>Through (UTC)</Trans>
          </span>
          <Input
            type="date"
            id={`${formId}-until`}
            name="analytics-until"
            autoComplete="off"
            value={until}
            min={since}
            onChange={(event) => filter("analyticsUntil", event.target.value)}
          />
        </label>
      </div>
      {!valid ? (
        <p role="alert">
          <Trans>Choose a valid date range.</Trans>
        </p>
      ) : failed ? (
        <div role="alert">
          <p>
            <Trans>Analytics could not be read.</Trans>
          </p>
          <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : !data ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading analytics…</Trans>
        </p>
      ) : (
        <>
          <details className="text-sm text-muted-foreground">
            <summary className="w-fit cursor-pointer">
              <Trans>Partial coverage</Trans>
            </summary>
            <p className="mt-2">
              <Trans>
                Stored CRM messages only. Native and imported correspondence are not included.
                Complete first-contact and shortlist history, automated-reply classification, and
                unmatched identities are unknown.
              </Trans>
            </p>
          </details>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {[
              [t`Earliest observed contact in period`, data.observedContactedPeople],
              [t`Open rate`, null],
              [t`Click rate`, null],
              [t`Reply rate`, data.replyRate],
              [t`Interest rate`, null],
              [t`Bounce rate`, null],
            ].map(([label, count]) => (
              <Card key={String(label)}>
                <CardContent className="p-4">
                  <dl>
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="mt-2 text-2xl font-semibold tabular-nums">
                      {label === t`Earliest observed contact in period` && count !== null ? (
                        <button
                          type="button"
                          className="hover:underline"
                          aria-label={t`View observed contacted people`}
                          onClick={() =>
                            setPeople({ key, metric: "contacted", roleId: roleId || undefined })
                          }
                        >
                          {value(count as number | null)}
                        </button>
                      ) : (
                        value(count as number | null)
                      )}
                    </dd>
                  </dl>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">
              <Trans>Outreach activity</Trans>
            </h2>
            <NativeSelect
              aria-label={t`Grouped by`}
              value={grouping}
              onChange={(event) => setGrouping(event.target.value as typeof grouping)}
            >
              <NativeSelectOption value="day">{t`Day`}</NativeSelectOption>
              <NativeSelectOption value="week">{t`Week`}</NativeSelectOption>
              <NativeSelectOption value="month">{t`Month`}</NativeSelectOption>
            </NativeSelect>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <TrendChart
              title={t`Observed contact cohort`}
              rows={trend}
              metric="contacted"
              since={since}
              until={until}
            />
            <TrendChart
              title={t`Replies to that cohort`}
              rows={trend}
              metric="replied"
              since={since}
              until={until}
            />
          </div>
          <section
            className="overflow-hidden rounded-xl border bg-card"
            aria-label={t`Analytics by role`}
          >
            <div className="flex flex-wrap items-center gap-3 p-4">
              <Input
                className="w-full sm:w-64"
                aria-label={t`Search analytics`}
                placeholder={t`Search…`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <NativeSelect
                aria-label={t`Metric`}
                value={metric}
                onChange={(event) => setMetric(event.target.value)}
              >
                <NativeSelectOption value="all">{t`All metrics`}</NativeSelectOption>
                <NativeSelectOption value="contacted">{t`Observed contacted`}</NativeSelectOption>
                <NativeSelectOption value="replied">{t`Subsequently replied`}</NativeSelectOption>
              </NativeSelect>
              <NativeSelect
                aria-label={t`Group by`}
                value={tableGroup}
                onChange={(event) => setTableGroup(event.target.value)}
              >
                <NativeSelectOption value="role">{t`Role`}</NativeSelectOption>
                <NativeSelectOption value="period">{t`Period`}</NativeSelectOption>
              </NativeSelect>
              <NativeSelect
                aria-label={t`Breakdown`}
                value={breakdown}
                onChange={(event) => setBreakdown(event.target.value)}
              >
                <NativeSelectOption value="none">{t`No breakdown`}</NativeSelectOption>
                <NativeSelectOption value="response">{t`Reply observation`}</NativeSelectOption>
              </NativeSelect>
              <Button className="sm:ms-auto" variant="outline" onClick={download}>
                <Trans>Download CSV</Trans>
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-start text-sm">
                <thead className="bg-muted text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3 text-start">
                      {tableGroup === "role" ? <Trans>Role</Trans> : <Trans>Period</Trans>}
                    </th>
                    {metric !== "replied" && (
                      <th className="p-3 text-end">
                        <Trans>Observed contacted</Trans>
                      </th>
                    )}
                    {metric !== "contacted" && (
                      <th className="p-3 text-end">
                        <Trans>Subsequently replied</Trans>
                      </th>
                    )}
                    <th className="p-3 text-end">
                      <Trans>Reply rate</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b bg-muted/40 font-medium">
                    <th className="p-3 text-start">
                      {roleId ? (
                        <Trans>Selected role · deduplicated people</Trans>
                      ) : (
                        <Trans>All roles · deduplicated people</Trans>
                      )}
                    </th>
                    {metric !== "replied" && (
                      <td className="p-3 text-end tabular-nums">
                        {value(data.observedContactedPeople)}
                      </td>
                    )}
                    {metric !== "contacted" && (
                      <td className="p-3 text-end tabular-nums">
                        {data.observedRepliedPeople === null ? (
                          value(null)
                        ) : (
                          <button
                            type="button"
                            className="hover:underline"
                            aria-label={t`View observed replies`}
                            onClick={() =>
                              setPeople({ key, metric: "replied", roleId: roleId || undefined })
                            }
                          >
                            {value(data.observedRepliedPeople)}
                          </button>
                        )}
                      </td>
                    )}
                    <td className="p-3 text-end">
                      <Trans>Unknown</Trans>
                    </td>
                  </tr>
                  {tableRows.map((row) => (
                    <tr key={row.key} className="border-b last:border-0">
                      <th className="p-3 text-start font-normal">
                        {onOpenRole && row.roleId ? (
                          <button
                            type="button"
                            className="text-start hover:underline"
                            onClick={() => onOpenRole(row.roleId!)}
                          >
                            {row.label}
                          </button>
                        ) : (
                          row.label
                        )}
                      </th>
                      {metric !== "replied" && (
                        <td className="p-3 text-end tabular-nums">
                          {tableGroup === "role" &&
                          breakdown === "none" &&
                          row.roleId &&
                          row.contacted !== null ? (
                            <button
                              type="button"
                              className="hover:underline"
                              onClick={() =>
                                setPeople({ key, metric: "contacted", roleId: row.roleId })
                              }
                            >
                              {value(row.contacted)}
                            </button>
                          ) : (
                            value(row.contacted)
                          )}
                        </td>
                      )}
                      {metric !== "contacted" && (
                        <td className="p-3 text-end tabular-nums">
                          {tableGroup === "role" &&
                          breakdown === "none" &&
                          row.roleId &&
                          row.replied !== null ? (
                            <button
                              type="button"
                              className="hover:underline"
                              onClick={() =>
                                setPeople({ key, metric: "replied", roleId: row.roleId })
                              }
                            >
                              {value(row.replied)}
                            </button>
                          ) : (
                            value(row.replied)
                          )}
                        </td>
                      )}
                      <td className="p-3 text-end">
                        <Trans>Unknown</Trans>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <p className="text-sm text-muted-foreground">
            <button
              type="button"
              className="hover:underline"
              onClick={() => setPeople({ key, metric: "shortlisted", roleId: roleId || undefined })}
            >
              <Trans>{data.observedShortlistedPeople} people shortlisted in this period.</Trans>
            </button>
          </p>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Replies follow the original observed contact cohort, including replies after this
              period. Automated replies may be included. Rates require complete history.
            </Trans>
          </p>
          {data.shortlistDateUnknownPeople > 0 && (
            <p className="text-sm text-muted-foreground">
              <Trans>
                {data.shortlistDateUnknownPeople} shortlisted people have no recorded shortlist
                date.
              </Trans>
            </p>
          )}
          {data.sources.storedCrmMessages === "unavailable" && (
            <p className="text-sm text-muted-foreground">
              <Trans>No dated CRM messages are available for this scope.</Trans>
            </p>
          )}
          {onOpenRole && roleId && (
            <Button variant="outline" onClick={() => onOpenRole(roleId)}>
              <Trans>Open role</Trans>
            </Button>
          )}
        </>
      )}
      {people?.key === key ? (
        <AnalyticsPeopleDialog
          key={`${key}:${people.metric}:${people.roleId}`}
          input={{
            since: `${since}T00:00:00Z`,
            until: new Date(Date.parse(`${until}T00:00:00Z`) + 86400000).toISOString(),
            metric: people.metric,
            ...(people.roleId ? { roleId: people.roleId } : {}),
          }}
          load={loadPeople}
          onClose={() => setPeople(undefined)}
        />
      ) : null}
    </section>
  );
}
