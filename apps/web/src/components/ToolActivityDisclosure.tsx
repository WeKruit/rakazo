import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { formatWorkClock } from "@rakazo/core";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  formatToolActivityDuration,
  isThinkingClockBlock,
  toolStepCount,
} from "../lib/tool-activity-view";

type ToolStep = Extract<ThreadMessage["blocks"][number], { kind: "steps" }>["steps"][number];

/** While a run is live, only the most recent steps are listed so a long run does not push the chat down. */
import { LIVE_TOOL_STEP_WINDOW } from "./tool-activity-window";

export { LIVE_TOOL_STEP_WINDOW } from "./tool-activity-window";

/** Only the live step clock ticks; completed tool durations come from its execution receipt. */
export function ToolStepElapsed({
  startedAt,
  durationMs,
  live = false,
}: {
  startedAt?: string;
  durationMs?: number;
  live?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live || !startedAt || durationMs !== undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live, startedAt, durationMs]);
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const duration =
    durationMs !== undefined
      ? formatToolActivityDuration(durationMs)
      : live && Number.isFinite(start)
        ? formatWorkClock(Math.max(0, now - start))
        : null;
  return duration ? (
    <span
      data-testid="tool-step-elapsed"
      className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground"
    >
      {duration}
    </span>
  ) : null;
}

export function ToolSteps({
  steps,
  currentIndex,
  limit,
  live = false,
}: {
  steps: readonly ToolStep[];
  currentIndex?: number;
  /** Show only the last `limit` steps, with a count of the earlier ones above them. */
  limit?: number;
  live?: boolean;
}) {
  const { t } = useLingui();
  const hidden = limit !== undefined && steps.length > limit ? steps.length - limit : 0;
  const shown = hidden > 0 ? steps.slice(hidden) : steps;
  return (
    <div className="space-y-0.5" data-testid="tool-rows">
      {hidden > 0 ? (
        <div className="text-[12px] leading-5 text-muted-foreground" data-testid="tool-rows-hidden">
          <Plural value={hidden} one="+# earlier step" other="+# earlier steps" />
        </div>
      ) : null}
      {shown.map((step, offset) => {
        const index = hidden + offset;
        const isCurrent =
          !step.status &&
          step.durationMs === undefined &&
          (index === currentIndex || (live && Boolean(step.startedAt)));
        return (
          <div key={index} className="flex min-w-0 items-center gap-2 leading-5">
            <span
              className={`text-[12px] ${isCurrent || step.status ? "text-warning" : "text-success"}`}
              aria-hidden
              style={{ animation: isCurrent ? "rkPulse 1.2s ease-in-out infinite" : undefined }}
            >
              {step.status ? "!" : isCurrent ? "◷" : "✓"}
            </span>
            <span
              className={`min-w-0 flex-1 truncate text-[13px] ${
                isCurrent ? "text-foreground" : "text-muted-foreground"
              }`}
              title={step.label}
            >
              {step.status ? (
                <span className="sr-only">
                  {step.status === "failed" ? t`Step failed` : t`Paused`}:{" "}
                </span>
              ) : null}
              {step.label}
              {step.count > 1 ? ` ×${step.count}` : ""}
              {step.peopleWithEmail !== undefined ? (
                <>
                  {" "}
                  ·{" "}
                  <Plural
                    value={step.peopleWithEmail}
                    one="# person with email"
                    other="# people with email"
                  />
                </>
              ) : null}
            </span>
            <ToolStepElapsed
              startedAt={step.startedAt}
              durationMs={step.durationMs}
              live={isCurrent}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The tools still running, latest first: every started step without a result, or else the
 * last step when the runtime has not reported start times.
 */
export function runningToolSteps(steps: readonly ToolStep[]): ToolStep[] {
  const open = steps.filter((step) => !step.status && step.durationMs === undefined);
  const started = open.filter((step) => step.startedAt);
  const last = steps.at(-1);
  return (started.length ? started : open.at(-1) === last && last ? [last] : []).reverse();
}

/**
 * The tool-activity card. It starts open while the run is live and folds when the run
 * ends: the `key` swap remounts the element, so `open` restarts from `live`. A manual
 * collapse during the run holds, because React only rewrites `open` when the prop
 * changes, and it stays `true` for the whole run.
 */
export function ToolActivityDisclosure({
  live,
  steps,
  durationMs,
  children,
}: {
  live: boolean;
  steps: readonly ToolStep[];
  durationMs?: number;
  children: ReactNode;
}) {
  const duration = formatToolActivityDuration(durationMs);
  const stepCount = toolStepCount(steps);
  const running = live ? runningToolSteps(steps) : [];
  return (
    <details
      key={live ? "working" : "actions"}
      open={live}
      data-testid="tool-activity"
      data-live={live || undefined}
      className="group"
    >
      <summary
        className={`flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded-md py-0.5 pe-1.5 text-[13px] font-medium outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
          live ? "text-foreground/75" : "text-muted-foreground"
        }`}
      >
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={1.8}
          className="transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        />
        {running.length ? (
          <span className="max-w-80 truncate" data-testid="tool-activity-running">
            {running[0]!.label}
            {running.length > 1 ? ` +${running.length - 1}` : ""}
          </span>
        ) : live ? (
          <Plural value={stepCount} one="Working… · # tool" other="Working… · # tools" />
        ) : (
          <>
            <Plural value={stepCount} one="Done · # tool" other="Done · # tools" />
            {duration ? ` · ${duration}` : null}
          </>
        )}
      </summary>
      <div className="ms-[7px] mt-0.5 border-s border-border ps-3">{children}</div>
    </details>
  );
}

/**
 * A tools-only message: a plain muted line between messages, not a chat bubble.
 */
export function StandaloneToolActivity({
  live,
  steps,
  durationMs,
}: {
  live: boolean;
  steps: readonly ToolStep[];
  durationMs?: number;
}) {
  return (
    <div className="flex justify-start" dir="ltr" data-testid="tool-activity-line">
      <div className="max-w-[74%] min-w-0 ps-1">
        <ToolActivityDisclosure live={live} steps={steps} durationMs={durationMs}>
          <ToolSteps
            steps={steps}
            currentIndex={live ? steps.length - 1 : undefined}
            limit={live ? LIVE_TOOL_STEP_WINDOW : undefined}
            live={live}
          />
        </ToolActivityDisclosure>
      </div>
    </div>
  );
}

/** Developer view: how long the model has been reasoning in this stretch. */
export function ThinkingClock({ since }: { since: string }) {
  return (
    <div
      className="flex min-h-6 items-center gap-1.5 ps-1 text-[13px] text-foreground/75"
      data-testid="thinking-clock"
    >
      <Trans>Thinking</Trans>
      <ToolStepElapsed startedAt={since} live />
    </div>
  );
}

/** A bot message whose only visible blocks are tool cards: one slim line per card, no bubble. */
export function ToolOnlyNarration({
  blocks,
  live,
}: {
  blocks: readonly ThreadMessage["blocks"][number][];
  live: boolean;
}) {
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === "steps" ? (
          <StandaloneToolActivity
            key={i}
            live={live}
            steps={block.steps}
            durationMs={block.durationMs}
          />
        ) : live && isThinkingClockBlock(block) ? (
          <ThinkingClock key={i} since={block.thinkingSince} />
        ) : null,
      )}
    </>
  );
}
