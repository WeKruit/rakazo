import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Clock, Pause, Plus } from "lucide-react";
import { routineNextRun } from "./routine-next-run";

export {
  draftFromRoutine,
  emptyRoutineDraft,
  type RoutineDraftState,
  routineNeedsOneShotArm,
} from "./routine-draft";
export { routineNextRun } from "./routine-next-run";

export function routineTriggerSummary(routine: Routine): string {
  if (!routine.active) return t`Paused`;
  const parts: string[] = [];
  if (routine.webhookEnabled) parts.push(t`When a webhook fires`);
  if (routine.githubEnabled) parts.push(t`Git event`);
  if (routine.messageProvider === "slack") parts.push(t`Slack message`);
  else if (routine.messageProvider === "teams") parts.push(t`Teams message`);
  else if (routine.messageProvider) parts.push(t`Message event`);
  for (const cron of routine.crons) parts.push(formatCron(cron));
  return parts.length > 0 ? parts.join(" · ") : t`No trigger`;
}

export function RoutineListHeader({ onCreate }: { onCreate: () => void }) {
  const { t } = useLingui();
  return (
    <div className="mt-[30px] mb-3 flex items-center justify-between gap-3">
      <div className="text-sm text-muted-foreground">
        <Trans>Routines</Trans>
      </div>
      <Button
        variant="secondary"
        size="icon-sm"
        data-testid="routine-create-button"
        aria-label={t`Create Routine`}
        title={t`Create Routine`}
        onClick={onCreate}
      >
        <Plus strokeWidth={1.9} />
      </Button>
    </div>
  );
}

export function RoutineListRow({
  routine,
  running,
  onOpen,
  onStop,
}: {
  routine: Routine;
  running: boolean;
  onOpen: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 hover:bg-accent">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-start"
      >
        <span className="grid h-5 w-5 place-items-center">
          {routine.active ? (
            <Clock size={16} strokeWidth={1.6} className="text-success" aria-hidden />
          ) : (
            <Pause size={14} className="text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-medium text-foreground" dir="auto">
            {routine.name}
          </span>
          <span className="block truncate text-[12.5px] text-muted-foreground/80">
            {routineTriggerSummary(routine)}
            {routineNextRun(routine) ? ` · ${routineNextRun(routine)}` : ""}
            {routine.modelProvider && routine.modelId ? ` · ${routine.modelId}` : ""}
          </span>
        </span>
      </button>
      {running ? (
        <Button
          size="xs"
          onClick={onStop}
          className="shrink-0 rounded-full bg-warning/15 text-warning hover:bg-warning/25"
        >
          <Trans>Running · Stop</Trans>
        </Button>
      ) : null}
    </div>
  );
}
