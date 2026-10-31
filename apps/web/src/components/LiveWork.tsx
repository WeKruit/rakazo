import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type {
  WorkActivity,
  WorkEstimate,
  WorkSession,
  WorkStage,
  WorkStageKind,
  WorkStep,
} from "@rakazo/core";
import {
  formatWorkClock,
  formatWorkDuration,
  workCountdownLeftMs,
  workProgressLabel,
  workSessionElapsedMs,
  workSessionStages,
  workTimeline,
} from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { LoadingState, Shimmer } from "./ai/primitives";
import { ToolStepElapsed, ToolSteps } from "./ToolActivityDisclosure";
import { LIVE_TOOL_STEP_WINDOW } from "./tool-activity-window";

function useWorkActivityLabels(): Record<WorkActivity, string> {
  const { t } = useLingui();
  return {
    files: t`Reading files`,
    search: t`Searching the web`,
    page: t`Reading a page`,
    context: t`Checking saved context`,
    memory: t`Saving notes`,
    connections: t`Checking connections`,
    connected_action: t`Using a connected app`,
    emails: t`Checking email`,
    availability: t`Checking availability`,
    drafting: t`Drafting email`,
    role: t`Reviewing the role`,
    candidates: t`Reviewing candidates`,
    research: t`Searching candidates`,
    feedback: t`Recording feedback`,
    crm: t`Checking candidate records`,
    question: t`Preparing a question`,
    specialist: t`Asking a specialist`,
    working: t`Working on it`,
  };
}

function useWorkStageLabels(): Record<WorkStageKind, string> {
  const { t } = useLingui();
  return {
    sourcing: t`Finding candidates`,
    quality: t`Checking candidates`,
    outreach: t`Preparing outreach`,
    scheduling: t`Scheduling interviews`,
    other: t`Delegated task`,
  };
}

type LabeledStep = WorkStep & { label: string };

/**
 * Work handed to a teammate, as one entry named for its purpose. It stays open with its
 * latest steps while it runs and folds once it is done; the key swap resets `open`.
 */
function WorkStageEntry({
  label,
  running,
  steps,
  onOpen,
  onCancel,
}: {
  label: string;
  running: boolean;
  steps: LabeledStep[];
  onOpen?: () => void;
  onCancel?: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [cancelling, setCancelling] = useState(false);
  const actions =
    onOpen || (running && onCancel) ? (
      <div className="flex gap-1">
        {onOpen ? (
          <Button variant="ghost" size="xs" onClick={onOpen}>
            <Trans>View</Trans>
          </Button>
        ) : null}
        {running && onCancel ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await onCancel();
              } finally {
                setCancelling(false);
              }
            }}
          >
            <Trans>Cancel task</Trans>
          </Button>
        ) : null}
      </div>
    ) : null;
  const title = (
    <>
      <span
        aria-hidden
        className={`text-[12px] ${running ? "text-warning" : "text-success"}`}
        style={{ animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined }}
      >
        {running ? "◷" : "✓"}
      </span>
      <span className="sr-only">{running ? t`Working…` : t`Done`}: </span>
      <span dir="auto" className={`truncate ${running ? "text-foreground/75" : ""}`}>
        {label}
      </span>
    </>
  );
  const row = "flex min-h-6 w-fit max-w-full items-center gap-2 py-0.5 pe-1.5 text-[13px]";
  if (!steps.length)
    return (
      <div
        data-testid="work-stage"
        data-running={running || undefined}
        className={`${row} ps-[22px] text-muted-foreground`}
      >
        {title}
        {actions}
      </div>
    );
  return (
    <details
      key={running ? "running" : "done"}
      open={running}
      data-testid="work-stage"
      data-running={running || undefined}
      className="group/stage"
    >
      <summary
        className={`${row} cursor-pointer list-none rounded-md text-muted-foreground outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background`}
      >
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={1.8}
          className="shrink-0 transition-transform duration-150 group-open/stage:rotate-90 motion-reduce:transition-none"
        />
        {title}
      </summary>
      <div className="ms-[7px] mt-0.5 border-s border-border ps-3">
        <ToolSteps
          steps={steps}
          limit={running ? LIVE_TOOL_STEP_WINDOW : undefined}
          live={running}
        />
        {actions}
      </div>
    </details>
  );
}

/**
 * When teammates worked side by side, where each one's part fell within the turn: a small
 * Gantt view so parallel and waiting work reads at a glance. Hidden for a single stage.
 */
function WorkTimeline({
  session,
  labelFor,
}: {
  session: WorkSession;
  labelFor: (botId: string) => string;
}) {
  const now = useNow();
  const { rows } = workTimeline(session, now);
  if (rows.length < 2) return null;
  return (
    <ul data-testid="work-timeline" className="mt-1 grid w-full max-w-md gap-1">
      {rows.map((row) => (
        <li key={row.botId} className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span dir="auto" className="w-32 shrink-0 truncate">
            {labelFor(row.botId)}
          </span>
          <span className="relative h-1.5 flex-1 rounded-full bg-muted">
            <span
              aria-hidden
              className={`absolute inset-y-0 rounded-full ${row.running ? "bg-warning" : "bg-foreground/40"}`}
              style={{
                left: `${row.start * 100}%`,
                width: `max(4px, ${(row.end - row.start) * 100}%)`,
              }}
            />
          </span>
          <span className="w-14 shrink-0 text-end font-mono tabular-nums">
            {formatWorkDuration(row.durationMs)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Seconds since the turn began; only the clock re-renders. */
function WorkClock({ session }: { session: WorkSession }) {
  const now = useNow();
  return (
    <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
      {formatWorkClock(workSessionElapsedMs(session, now))}
    </span>
  );
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Big work counts down from its estimate and starts over if it runs past; small work counts up
 * from its start. The note says once, under a countdown, that this one takes longer.
 */
function EstimateClock({ estimate }: { estimate: WorkEstimate }) {
  const now = useNow();
  const left = workCountdownLeftMs(estimate, now);
  return (
    <span
      data-testid="work-countdown"
      data-counting={left === null ? "up" : "down"}
      className="font-mono text-[12px] tabular-nums text-muted-foreground"
    >
      {left === null ? (
        formatWorkClock(now - Date.parse(estimate.startedAt))
      ) : (
        <Trans>{formatWorkClock(left)} left</Trans>
      )}
    </span>
  );
}

function EstimateNote({ estimate }: { estimate: WorkEstimate }) {
  if (!estimate.estimateMs) return null;
  const minutes = Math.round(estimate.estimateMs / 60_000);
  return (
    <p data-testid="work-countdown-note" className="text-[12px] text-muted-foreground">
      <Plural
        value={minutes}
        one="This one takes longer, about # minute. You can keep chatting or come back later."
        other="This one takes longer, about # minutes. You can keep chatting or come back later."
      />
    </p>
  );
}

/** Work still going after its turn ended: a search waiting at the provider. */
export function BackgroundWork({ estimate }: { estimate: WorkEstimate }) {
  const { t } = useLingui();
  const headline =
    estimate.kind === "emails"
      ? t`Looking up emails`
      : estimate.estimateMs
        ? t`Finding about ${estimate.people} people`
        : t`Finding people`;
  return (
    <div data-testid="background-work" className="space-y-0.5">
      <LoadingState
        label={headline}
        indicator={
          <span aria-hidden className="flex min-w-0 flex-wrap items-center gap-2">
            <Shimmer>{headline}</Shimmer>
            <EstimateClock estimate={estimate} />
          </span>
        }
      />
      <EstimateNote estimate={estimate} />
    </div>
  );
}

/**
 * The work behind the current turn in plain words: finished steps, then the step in
 * flight with a clock from the run's start. Once the turn ends it folds into one line.
 */
export function LiveWork({
  session,
  live,
  label,
  detail,
  showSteps = true,
  stageKind = () => "other",
  estimate,
  onOpenStage,
  onCancelStage,
}: {
  session: WorkSession | null;
  live: boolean;
  /** Headline while no step is in flight, e.g. "Working…". */
  label: string;
  /** Off where tool cards already list the steps. */
  showSteps?: boolean;
  /** Business progress beside the headline, e.g. people added so far. */
  detail?: ReactNode;
  /** What each handed-off stage is for, from the member doing it. */
  stageKind?: (botId: string) => WorkStageKind;
  /** Big work this turn is part of: its countdown replaces the turn's clock. */
  estimate?: WorkEstimate | null;
  onOpenStage?: (botId: string) => void;
  onCancelStage?: (botId: string) => Promise<void>;
}) {
  const labels = useWorkActivityLabels();
  const stageLabels = useWorkStageLabels();
  const labelSteps = (list: readonly WorkStep[]) =>
    list.map((step) => ({ ...step, label: labels[step.activity] }));
  const split = showSteps ? workSessionStages(session) : { own: [], stages: [] as WorkStage[] };
  const steps = labelSteps(split.own);
  const stages = split.stages.length ? (
    <div className="space-y-0.5">
      {split.stages.map((stage) => (
        <WorkStageEntry
          key={stage.botId}
          label={stageLabels[stageKind(stage.botId)]}
          running={stage.running}
          steps={labelSteps(stage.steps)}
          onOpen={onOpenStage ? () => onOpenStage(stage.botId) : undefined}
          onCancel={onCancelStage ? () => onCancelStage(stage.botId) : undefined}
        />
      ))}
      {session ? (
        <WorkTimeline session={session} labelFor={(botId) => stageLabels[stageKind(botId)]} />
      ) : null}
    </div>
  ) : null;
  if (live) {
    const headline = session?.progress
      ? workProgressLabel(session.progress)
      : session?.current
        ? `${labels[session.current]}…`
        : label;
    return (
      <div data-testid="live-work" className="space-y-1">
        {steps.length ? <ToolSteps steps={steps} limit={LIVE_TOOL_STEP_WINDOW} live /> : null}
        {stages}
        {/* The status names the step; the ticking clock stays out of announcements. */}
        <LoadingState
          label={headline}
          indicator={
            <span aria-hidden className="flex min-w-0 flex-wrap items-center gap-2">
              <Shimmer>{headline}</Shimmer>
              {detail ? (
                <span data-testid="live-work-detail" className="text-[12px] text-muted-foreground">
                  {detail}
                </span>
              ) : null}
              {estimate ? (
                <EstimateClock estimate={estimate} />
              ) : session ? (
                session.currentStartedAt ? (
                  <ToolStepElapsed startedAt={session.currentStartedAt} live />
                ) : (
                  <WorkClock session={session} />
                )
              ) : null}
            </span>
          }
        />
        {estimate ? <EstimateNote estimate={estimate} /> : null}
      </div>
    );
  }
  if (!session?.endedAt) return null;
  const duration = formatWorkDuration(workSessionElapsedMs(session, Date.now()));
  if (!steps.length && !stages)
    return (
      <div data-testid="work-summary" className="text-[13px] text-muted-foreground">
        <Trans>Worked for {duration}</Trans>
      </div>
    );
  return (
    <details data-testid="work-summary" className="group">
      <summary className="flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded-md py-0.5 pe-1.5 text-[13px] font-medium text-muted-foreground outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={1.8}
          className="transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        />
        <Trans>Worked for {duration}</Trans>
      </summary>
      <div className="ms-[7px] mt-0.5 border-s border-border ps-3">
        {steps.length ? <ToolSteps steps={steps} /> : null}
        {stages}
      </div>
    </details>
  );
}
