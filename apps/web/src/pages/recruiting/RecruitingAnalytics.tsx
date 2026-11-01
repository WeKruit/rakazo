import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingAnalyticsInput, RecruitingAnalyticsOutput } from "@rakazo/contracts";
import { Button, Card, CardContent, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router-dom";

export function RecruitingAnalytics({
  accountKey,
  load,
  onOpenRole,
}: {
  accountKey: string;
  load: (input: RecruitingAnalyticsInput) => Promise<RecruitingAnalyticsOutput>;
  onOpenRole?: (roleId: string) => void;
}) {
  const { t } = useLingui();
  const formId = useId();
  const [params, setParams] = useSearchParams();
  const since =
    params.get("analyticsSince") ?? new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const until = params.get("analyticsUntil") ?? new Date().toISOString().slice(0, 10);
  const roleId = params.get("role") === "all" ? "" : (params.get("role") ?? "");
  const filter = (name: string, value: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(name, value);
      else next.delete(name);
      return next;
    });
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
          <p className="text-sm text-muted-foreground">
            <Trans>
              Partial coverage · Stored CRM messages only. Native and imported correspondence are
              not included. Complete first-contact and shortlist history, automated-reply
              classification, and unmatched identities are unknown.
            </Trans>
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              [t`Shortlisted in period`, data.observedShortlistedPeople],
              [t`Earliest observed contact in period`, data.observedContactedPeople],
              [t`Subsequently replied`, data.observedRepliedPeople],
              [t`Reply rate`, data.replyRate],
            ].map(([label, count]) => (
              <Card key={String(label)}>
                <CardContent className="p-4">
                  <dl>
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="mt-2 text-2xl font-semibold tabular-nums">
                      {value(count as number | null)}
                    </dd>
                  </dl>
                </CardContent>
              </Card>
            ))}
          </div>
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
    </section>
  );
}
