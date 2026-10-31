import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine, SharedRoutine } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Clock, Pause, Plus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { formatTimeUntil } from "../lib/relative-time";
import { rpc } from "../lib/rpc";

export {
  draftFromRoutine,
  emptyRoutineDraft,
  type RoutineDraftState,
  routineNeedsOneShotArm,
  routineOptionInput,
} from "./routine-draft";

export function routineTriggerSummary(routine: Routine): string {
  if (!routine.active) return t`Paused`;
  const parts: string[] = [];
  if (routine.webhookEnabled) parts.push(t`When a webhook fires`);
  if (routine.githubEnabled) parts.push(t`Git event`);
  if (routine.messageProvider === "slack") parts.push(t`Slack message`);
  else if (routine.messageProvider === "teams") parts.push(t`Teams message`);
  else if (routine.messageProvider) parts.push(t`Message event`);
  if (routine.recordTrigger === "recruiting_role") parts.push(t`When a role changes`);
  else if (routine.recordTrigger === "recruiting_candidate") parts.push(t`When people are saved`);
  for (const cron of routine.crons) parts.push(formatCron(cron));
  if (routine.nextRunAt) {
    const next = formatTimeUntil(routine.nextRunAt);
    if (next) parts.push(t`Next ${next}`);
  }
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
          <span
            className="block truncate text-[12.5px] text-muted-foreground/80"
            title={
              routine.active && routine.nextRunAt
                ? new Date(routine.nextRunAt).toLocaleString()
                : undefined
            }
          >
            {routineTriggerSummary(routine)}
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

/** Routines teammates shared with the Space; adding one makes the member's own copy. */
export function SharedRoutineOffers({
  botId,
  onAdded,
}: {
  botId: string;
  onAdded: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const [offers, setOffers] = useState<SharedRoutine[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rpc.routines
      .shared()
      .then((rows) => {
        if (!cancelled) setOffers(rows.filter((row) => !row.added));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId]);
  if (offers.length === 0) return null;
  return (
    <div className="mt-4" data-testid="shared-routine-offers">
      <div className="mb-1 px-2.5 text-[12.5px] text-muted-foreground">
        <Trans>Shared by your team</Trans>
      </div>
      {offers.map((offer) => (
        <div key={offer.id} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2">
          <span className="grid h-5 w-5 place-items-center">
            <Users size={15} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14.5px] text-foreground" dir="auto">
              {offer.name}
            </span>
            <span className="block truncate text-[12.5px] text-muted-foreground/80" dir="auto">
              {offer.ownerName}
            </span>
          </span>
          <Button
            size="xs"
            variant="secondary"
            disabled={adding !== null}
            aria-label={t`Add ${offer.name}`}
            onClick={async () => {
              setAdding(offer.id);
              try {
                await rpc.routines.addShared({ routineId: offer.id, botId });
                setOffers((rows) => rows.filter((row) => row.id !== offer.id));
                await onAdded();
              } catch {
                // The offer stays so the member can try again.
              } finally {
                setAdding(null);
              }
            }}
          >
            <Trans>Add</Trans>
          </Button>
        </div>
      ))}
    </div>
  );
}
