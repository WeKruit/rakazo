import type { Routine } from "@rakazo/contracts";
import type { CronPreset } from "@rakazo/core";
import { isOneShotRoutineCrons, modelOptionKey, presetFromCron } from "@rakazo/core";

function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultArmRunAtLocal(): string {
  return toDatetimeLocalValue(new Date(Date.now() + 60 * 60 * 1000));
}

export function routineNeedsOneShotArm(
  routine: Pick<Routine, "nextRunAt" | "lastRunAt">,
  crons: string[],
) {
  return isOneShotRoutineCrons(crons) && !routine.nextRunAt && !routine.lastRunAt;
}

export type RoutineDraftState = {
  name: string;
  prompt: string;
  schedules: CronPreset[];
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  active: boolean;
  /** Push a notification when a run finishes. */
  notify: boolean;
  runAtLocal: string;
  /** Empty runs this routine on the bot's model. */
  modelKey: string;
  thinkingLevel: string;
};

export function emptyRoutineDraft(): RoutineDraftState {
  return {
    name: "",
    prompt: "",
    schedules: [],
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    active: true,
    notify: true,
    runAtLocal: "",
    modelKey: "",
    thinkingLevel: "",
  };
}

export function draftFromRoutine(routine: Routine): RoutineDraftState {
  return {
    name: routine.name,
    prompt: routine.prompt,
    schedules: routine.crons.map(presetFromCron),
    webhookEnabled: routine.webhookEnabled,
    githubEnabled: routine.githubEnabled,
    messageProvider: routine.messageProvider,
    active: routine.active,
    notify: routine.notify,
    runAtLocal: routineNeedsOneShotArm(routine, routine.crons) ? defaultArmRunAtLocal() : "",
    modelKey:
      routine.modelProvider && routine.modelId
        ? modelOptionKey(routine.modelProvider, routine.modelId)
        : "",
    thinkingLevel: routine.thinkingLevel ?? "",
  };
}
