import { Trans, useLingui } from "@lingui/react/macro";
import type { ListRecruitingCandidatesInput, RecruitingCandidate } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useMemo, useState } from "react";
import { rpc } from "../../lib/rpc";
import { candidateSections, withSavedProfile } from "./profile";
import { profileContentFields } from "./profileAssets";
import { parseTimeline, structuredProfileTimeline, timelineStats } from "./profileTimelineModel";
import { RetryNotice } from "./RetryNotice";
import { TabLoading } from "./shared";

/** Counts only supplied facts; one person contributes at most once to each named category. */
export function talentFacts(people: readonly RecruitingCandidate[], now = new Date()) {
  const dimensions = {
    locations: new Map<string, number>(),
    companies: new Map<string, number>(),
    schools: new Map<string, number>(),
    skills: new Map<string, number>(),
    majors: new Map<string, number>(),
    languages: new Map<string, number>(),
  };
  const known = Object.fromEntries(Object.keys(dimensions).map((key) => [key, 0])) as Record<
    keyof typeof dimensions,
    number
  >;
  const experience: number[] = [],
    tenure: number[] = [];
  for (const person of people) {
    const fields = withSavedProfile(person.savedProfile, person.latestSource?.report?.fields ?? []);
    const profile = candidateSections(profileContentFields(fields));
    const timeline = (kind: "experience" | "education") =>
      profile[kind].flatMap((field) =>
        field.structuredValue !== undefined
          ? structuredProfileTimeline(field.structuredValue, kind, now, field.sourceUrlsById)
          : parseTimeline(field.value, kind, now),
      );
    const work = timeline("experience");
    const values = {
      locations: [person.location],
      companies: [person.company],
      schools: [
        ...timeline("education")
          .filter((entry) => entry.structured)
          .map((entry) => entry.organization ?? entry.primary),
        ...fields
          .filter((field) => /^(?:school|university)$/i.test(field.label.trim()))
          .map((field) => field.value),
      ],
      skills: profile.skills,
      majors: person.savedProfile?.education.map((entry) => entry.field_of_study) ?? [],
      languages: fields
        .filter((field) => /^languages?$/i.test(field.label))
        .flatMap((field) => (field.value ?? "").split(/[,;\n]/)),
    };
    for (const key of Object.keys(dimensions) as (keyof typeof dimensions)[]) {
      const unique = new Set(values[key].flatMap((value) => (value?.trim() ? [value.trim()] : [])));
      if (unique.size) known[key]++;
      for (const value of unique) dimensions[key].set(value, (dimensions[key].get(value) ?? 0) + 1);
    }
    const stats = timelineStats(work);
    if (stats) experience.push(stats.total);
    if (stats?.current !== null && stats?.current !== undefined) tenure.push(stats.current);
  }
  return {
    dimensions,
    known,
    experience: experience.sort((a, b) => a - b),
    tenure: tenure.sort((a, b) => a - b),
  };
}

export function TalentInsights({
  roleId,
  roleTitle,
  filters,
  onBack,
}: {
  roleId: string;
  roleTitle: string;
  filters: Omit<ListRecruitingCandidatesInput, "roleId" | "cursor" | "limit">;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const scope = JSON.stringify([roleId, filters]);
  const [retry, setRetry] = useState(0);
  const [read, setRead] = useState<{ scope: string; people: RecruitingCandidate[] }>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    setFailure(undefined);
    void (async () => {
      const people = new Map<string, RecruitingCandidate>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let revision: string | undefined;
      let total: number | undefined;
      do {
        const page = await rpc.recruiting.listCandidates(
          { ...filters, roleId, shortlisted: true, cursor, limit: 200 },
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        if (
          page.roleId !== roleId ||
          (revision !== undefined && revision !== page.roleRevisionId) ||
          (total !== undefined && total !== page.total)
        )
          throw new Error("Shortlist changed during read");
        revision = page.roleRevisionId;
        total = page.total;
        for (const person of page.items) people.set(person.candidateKey, person);
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error("Repeated shortlist cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (people.size !== total) throw new Error("Incomplete shortlist read");
      if (!abort.signal.aborted) setRead({ scope, people: [...people.values()] });
    })().catch(() => {
      if (!abort.signal.aborted) setFailure(scope);
    });
    return () => abort.abort();
  }, [scope, retry]);
  const people = read?.scope === scope ? read.people : undefined;
  const facts = useMemo(() => (people ? talentFacts(people) : null), [people]);
  const labels = {
    locations: t`Top locations`,
    companies: t`Companies`,
    schools: t`Schools`,
    skills: t`Skills`,
    majors: t`Fields of study`,
    languages: t`Languages`,
  };
  const exportCsv = () => {
    if (!facts || !people) return;
    const rows: (string | number)[][] = [
      [t`Role`, roleTitle],
      [t`Sample`, people.length],
      [t`Dimension`, t`Value`, t`People`, t`Known`, t`Unknown`, t`Sample`],
    ];
    for (const key of Object.keys(labels) as (keyof typeof labels)[])
      for (const [value, count] of facts.dimensions[key])
        rows.push([
          labels[key],
          value,
          count,
          facts.known[key],
          people.length - facts.known[key],
          people.length,
        ]);
    for (const [label, values] of [
      [t`Experience (months)`, facts.experience],
      [t`Current tenure (months)`, facts.tenure],
    ] as const)
      for (const value of values)
        rows.push([label, value, 1, values.length, people.length - values.length, people.length]);
    const csv = rows
      .map((row) =>
        row
          .map((value) => {
            const text = String(value);
            return `"${(/^[\s]*[=+\-@]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
          })
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "shortlist-insights.csv";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section aria-label={t`Talent insights`} className="min-w-0 space-y-4">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b bg-background py-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <Trans>Back to shortlist</Trans>
        </Button>
        <h2 className="min-w-0 flex-1 break-words text-base font-semibold">{roleTitle}</h2>
        {people ? (
          <span className="text-sm tabular-nums">
            <Trans>{people.length} shortlisted candidates</Trans>
          </span>
        ) : null}
        <Button size="sm" variant="outline" disabled={!people} onClick={exportCsv}>
          <Trans>Export</Trans>
        </Button>
      </header>
      {failure === scope ? (
        <RetryNotice
          onRetry={() => {
            setRead(undefined);
            setRetry((value) => value + 1);
          }}
        >
          <Trans>Could not load the complete shortlist</Trans>
        </RetryNotice>
      ) : !people ? (
        <TabLoading />
      ) : null}
      {people && facts ? (
        <>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Saved facts from the current shortlist and filters. People may appear in more than one
              category.
            </Trans>
          </p>
          {!people.length ? (
            <p>
              <Trans>No shortlisted candidates match these filters.</Trans>
            </p>
          ) : (
            <>
              <section aria-label={t`Key takeaways`} className="space-y-2 rounded-lg border p-4">
                <h3 className="font-medium">
                  <Trans>Key takeaways</Trans>
                </h3>
                <p className="text-sm">
                  <Trans>{people.length} people in the complete filtered shortlist.</Trans>
                </p>
                <ul className="space-y-1 text-sm">
                  {(["locations", "companies", "schools"] as const).flatMap((key) => {
                    const top = [...facts.dimensions[key]].sort(
                      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
                    )[0];
                    return top
                      ? [
                          <li key={key} className="break-words">
                            {labels[key]}: {top[0]} · {top[1]}/{people.length}
                          </li>,
                        ]
                      : [];
                  })}
                </ul>
              </section>
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                {(Object.keys(labels) as (keyof typeof labels)[]).map((key) => (
                  <section
                    key={key}
                    aria-label={labels[key]}
                    className="min-w-0 space-y-3 rounded-lg border p-4"
                  >
                    <h3 className="font-medium">{labels[key]}</h3>
                    <p className="text-xs text-muted-foreground">
                      <Trans>
                        {facts.known[key]} known · {people.length - facts.known[key]} unknown ·{" "}
                        {people.length} people
                      </Trans>
                    </p>
                    <ol className="space-y-2">
                      {[...facts.dimensions[key]]
                        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                        .slice(0, 10)
                        .map(([value, count]) => (
                          <li
                            key={value}
                            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm"
                          >
                            <span className="truncate" title={value}>
                              {value}
                            </span>
                            <span className="tabular-nums">{count}</span>
                            <meter
                              aria-label={value}
                              min={0}
                              max={people.length}
                              value={count}
                              className="col-span-2 h-2 w-full"
                            />
                          </li>
                        ))}
                    </ol>
                    {!facts.known[key] ? (
                      <p className="text-xs text-muted-foreground">
                        <Trans>No saved data</Trans>
                      </p>
                    ) : null}
                  </section>
                ))}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  [t`Experience`, facts.experience],
                  [t`Current tenure`, facts.tenure],
                ].map(([label, data]) => {
                  const values = data as number[];
                  return (
                    <section key={String(label)} className="space-y-3 rounded-lg border p-4">
                      <h3 className="font-medium">{String(label)}</h3>
                      <p className="text-xs text-muted-foreground">
                        <Trans>
                          {values.length} known · {people.length - values.length} unknown ·{" "}
                          {people.length} people
                        </Trans>
                      </p>
                      {values.length ? (
                        <dl className="grid grid-cols-3 gap-3">
                          {[25, 50, 75].map((percentile) => (
                            <div key={percentile}>
                              <dt className="text-xs text-muted-foreground">P{percentile}</dt>
                              <dd className="tabular-nums">
                                {Math.round(
                                  values[
                                    Math.max(0, Math.ceil((values.length * percentile) / 100) - 1)
                                  ]!,
                                )}{" "}
                                <Trans>months</Trans>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          <Trans>No dated work history</Trans>
                        </p>
                      )}
                    </section>
                  );
                })}
              </div>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
