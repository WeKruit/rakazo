import { Trans } from "@lingui/react/macro";
import type { RunTrace } from "@rakazo/contracts";
import { formatWorkDuration } from "@rakazo/core";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

/** Deployment-owner diagnostics only; the API independently checks both owner and account. */
export function RunTraceDisclosure({ runId, enabled }: { runId: string; enabled: boolean }) {
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  return (
    <details
      open={open}
      data-testid="run-trace"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="w-fit cursor-pointer rounded py-1 text-xs text-muted-foreground focus-visible:outline-ring">
        <Trans>Run trace</Trans>
      </summary>
      {open ? <RunTraceContent key={runId} runId={runId} /> : null}
    </details>
  );
}

function RunTraceContent({ runId }: { runId: string }) {
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const result = await rpc.runs.trace({ runId, includeDiagnostics: true });
        if (!active) return;
        setTrace(result);
        setFailed(false);
        if (!result.completedAt) timer = setTimeout(load, 5000);
      } catch {
        if (active) setFailed(true);
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [runId]);
  if (failed)
    return (
      <p role="alert" className="text-xs text-warning">
        <Trans>Trace unavailable</Trans>
      </p>
    );
  if (!trace)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        <Trans>Loading trace…</Trans>
      </p>
    );
  const start = Date.parse(trace.startedAt);
  const end = Math.max(
    start + 1,
    ...trace.rows.map((row) => Date.parse(row.startedAt) + (row.durationMs ?? 0)),
    trace.completedAt ? Date.parse(trace.completedAt) : start,
  );
  return (
    <div className="space-y-2 rounded-lg border border-border p-3" data-testid="run-trace-timeline">
      <div className="break-all font-mono text-xs text-muted-foreground">
        {trace.runId} · {trace.status}
      </div>
      {trace.rows.length ? (
        <ul className="space-y-2" aria-label="Run trace">
          {trace.rows.map((row) => {
            const offset = Math.max(0, ((Date.parse(row.startedAt) - start) / (end - start)) * 100);
            const width =
              row.durationMs === null ? 0 : Math.max(0, (row.durationMs / (end - start)) * 100);
            const detail = `${row.kind} · ${row.status} · ${row.durationMs === null ? "Duration not recorded" : formatWorkDuration(row.durationMs)} · ${row.tokens === null ? "Tokens not recorded" : `${row.tokens} tokens`} · ${row.costUsd === null ? "Cost not recorded" : `$${row.costUsd.toFixed(4)}`}`;
            return (
              <li
                key={row.id}
                title={detail}
                aria-label={`${row.label} · ${detail}`}
                className="space-y-1 text-xs"
              >
                <div className="flex min-w-0 justify-between gap-2">
                  <span className="truncate font-mono">{row.label}</span>
                  <span
                    className={row.status === "failed" ? "text-warning" : "text-muted-foreground"}
                  >
                    {row.status}
                  </span>
                </div>
                <div className="relative h-2 rounded bg-muted" aria-hidden>
                  <span
                    className={`absolute h-2 min-w-1 rounded ${row.status === "failed" ? "bg-warning" : "bg-foreground/60"}`}
                    style={{
                      left: `${Math.min(99, offset)}%`,
                      width: `${Math.min(100 - offset, width)}%`,
                    }}
                  />
                </div>
                {row.durationMs === null ? (
                  <span className="text-muted-foreground">
                    <Trans>Duration not recorded</Trans>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          <Trans>No recorded calls</Trans>
        </p>
      )}
    </div>
  );
}
