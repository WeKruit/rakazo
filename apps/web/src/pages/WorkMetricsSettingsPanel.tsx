import { Trans, useLingui } from "@lingui/react/macro";
import type { WorkMetrics } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

const count = (value: number) => new Intl.NumberFormat().format(value);
const percent = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 100)}%` : "—";
function duration(ms: number | null) {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}
const spread = (value: { p50Ms: number | null; p95Ms: number | null }) =>
  `${duration(value.p50Ms)} · ${duration(value.p95Ms)}`;

function Stats({ label, rows }: { label: string; rows: [string, string][] }) {
  return (
    <section aria-label={label} className="space-y-2">
      <h3 className="text-sm font-medium">{label}</h3>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-xs sm:grid-cols-3">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="mt-1 tabular-nums text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function WorkMetricsSettingsPanel() {
  const { t } = useLingui();
  const [data, setData] = useState<WorkMetrics | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setError(false);
    rpc.usage.workMetrics().then(
      (value) => {
        if (active) setData(value);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  if (error)
    return (
      <div className="flex items-center justify-between gap-4" role="alert">
        <p className="text-sm text-destructive">
          <Trans>Could not load work metrics</Trans>
        </p>
        <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    );
  if (!data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading metrics…</Trans>
      </p>
    );

  const { completion, longTasks, experience, memory, collaboration, automation } = data;
  const finished = completion.completed + completion.failed + completion.cancelled;
  const corrected = memory.correctedAfterCompaction;
  return (
    <div data-testid="work-metrics-settings" className="space-y-7">
      <p className="text-xs text-muted-foreground">
        <Trans>All accounts, last {data.windowDays} days</Trans>
      </p>
      <div className="overflow-x-auto">
        <table aria-label={t`Finished without help`} className="w-full text-[13px]">
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 text-start font-normal">
                <Trans>Week</Trans>
              </th>
              <th scope="col" className="py-2 text-end font-normal">
                <Trans>Finished without help</Trans>
              </th>
              <th scope="col" className="py-2 ps-4 text-end font-normal">
                <Trans>Tasks</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.unrescuedWeeks.map((week) => (
              <tr key={week.week} className="border-t border-border tabular-nums">
                <th scope="row" className="py-3 text-start font-normal">
                  {week.week}
                </th>
                <td className="py-3 text-end">
                  {count(week.unrescued)}{" "}
                  <span className="text-muted-foreground">
                    {percent(week.unrescued, week.tasks)}
                  </span>
                </td>
                <td className="py-3 ps-4 text-end">{count(week.tasks)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Stats
        label={t`Completion`}
        rows={[
          [t`Completed`, percent(completion.completed, finished)],
          [t`Failed`, count(completion.failed)],
          [t`Stopped by a person`, count(completion.stoppedByPerson)],
        ]}
      />
      {completion.reasons.length ? (
        <ul aria-label={t`Stop reasons`} className="space-y-1 text-xs">
          {completion.reasons.map((reason) => (
            <li
              key={`${reason.status}:${reason.reason}`}
              className="flex gap-3 border-t border-border py-2"
            >
              <span className="min-w-0 flex-1 break-words">{reason.reason}</span>
              <span className="tabular-nums text-muted-foreground">{count(reason.count)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <Stats
        label={t`Long work`}
        rows={[
          [t`Run time p50 · p95`, spread(longTasks.runDuration)],
          [t`Task time p50 · p95`, spread(longTasks.taskDuration)],
          [t`Compactions`, count(longTasks.compactions)],
          [t`Resumed after restart`, percent(longTasks.resumed.count, longTasks.resumed.of)],
        ]}
      />
      <Stats
        label={t`Responsiveness`}
        rows={[
          [t`First reply p50 · p95`, spread(experience.firstReply)],
          [t`Interjection picked up p50 · p95`, spread(experience.interject)],
          [
            t`Unanswered messages`,
            `${count(experience.unansweredInputs)} / ${count(experience.inputs)}`,
          ],
        ]}
      />
      <Stats
        label={t`Memory`}
        rows={[
          [
            t`Corrected after compaction`,
            `${percent(corrected.count, corrected.of)} (${count(corrected.count)} / ${count(corrected.of)})`,
          ],
        ]}
      />
      <Stats
        label={t`Teamwork`}
        rows={[
          [t`Handoffs`, count(collaboration.handoffs)],
          [t`Teammate replies`, percent(collaboration.replied, collaboration.teammateTurns)],
          [t`Nothing to add`, percent(collaboration.silent, collaboration.teammateTurns)],
        ]}
      />
      <Stats
        label={t`Automations`}
        rows={[
          [t`Fired`, count(automation.fired)],
          [t`Skipped`, percent(automation.skipped, automation.fired)],
          [t`Succeeded`, percent(automation.completed, automation.completed + automation.failed)],
        ]}
      />
    </div>
  );
}
