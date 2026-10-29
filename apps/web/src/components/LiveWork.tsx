import { Trans, useLingui } from "@lingui/react/macro";
import type { WorkActivity, WorkSession } from "@rakazo/core";
import {
  formatWorkClock,
  formatWorkDuration,
  workProgressLabel,
  workSessionElapsedMs,
  workSessionSteps,
} from "@rakazo/core";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { LoadingState, Shimmer } from "./ai/primitives";
import { ToolSteps } from "./ToolActivityDisclosure";
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

/** Seconds since the turn began; only the clock re-renders. */
function WorkClock({ session }: { session: WorkSession }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
      {formatWorkClock(workSessionElapsedMs(session, now))}
    </span>
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
}: {
  session: WorkSession | null;
  live: boolean;
  /** Headline while no step is in flight, e.g. "Working…". */
  label: string;
  /** Off where tool cards already list the steps. */
  showSteps?: boolean;
  /** Business progress beside the headline, e.g. people added so far. */
  detail?: ReactNode;
}) {
  const labels = useWorkActivityLabels();
  const steps = (showSteps ? workSessionSteps(session) : []).map((step) => ({
    ...step,
    label: labels[step.activity],
  }));
  if (live) {
    const headline = session?.progress
      ? workProgressLabel(session.progress)
      : session?.current
        ? `${labels[session.current]}…`
        : label;
    return (
      <div data-testid="live-work" className="space-y-1">
        {steps.length ? <ToolSteps steps={steps} limit={LIVE_TOOL_STEP_WINDOW} /> : null}
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
              {session ? <WorkClock session={session} /> : null}
            </span>
          }
        />
      </div>
    );
  }
  if (!session?.endedAt) return null;
  const duration = formatWorkDuration(workSessionElapsedMs(session, Date.now()));
  if (!steps.length)
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
        <ToolSteps steps={steps} />
      </div>
    </details>
  );
}
