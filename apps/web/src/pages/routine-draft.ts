import type { Routine, RoutineRecordTrigger, RoutineSessionMode } from "@rakazo/contracts";
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
  sessionMode: RoutineSessionMode;
  condition: string;
  probeCommand: string;
  recordTrigger: RoutineRecordTrigger | null;
  shared: boolean;
  /** Set on a member's copy of a shared routine; copies follow the original. */
  sharedFromId: string | null;
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
    sessionMode: "new",
    condition: "",
    probeCommand: "",
    recordTrigger: null,
    shared: false,
    sharedFromId: null,
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
    sessionMode: routine.sessionMode ?? "new",
    condition: routine.condition ?? "",
    probeCommand: routine.probeCommand ?? "",
    recordTrigger: routine.recordTrigger ?? null,
    shared: routine.shared ?? false,
    sharedFromId: routine.sharedFromId ?? null,
    runAtLocal: routineNeedsOneShotArm(routine, routine.crons) ? defaultArmRunAtLocal() : "",
    modelKey:
      routine.modelProvider && routine.modelId
        ? modelOptionKey(routine.modelProvider, routine.modelId)
        : "",
    thinkingLevel: routine.thinkingLevel ?? "",
  };
}

/** The optional settings to send: every one on create, only the changed ones on update. */
export function routineOptionInput(draft: RoutineDraftState, routine?: Routine | null) {
  const next = {
    sessionMode: draft.sessionMode,
    condition: draft.condition.trim() || null,
    probeCommand: draft.probeCommand.trim() || null,
    recordTrigger: draft.recordTrigger,
    ...(draft.sharedFromId ? {} : { shared: draft.shared }),
  };
  if (!routine) return next;
  const current = {
    sessionMode: routine.sessionMode ?? "new",
    condition: routine.condition ?? null,
    probeCommand: routine.probeCommand ?? null,
    recordTrigger: routine.recordTrigger ?? null,
    shared: routine.shared ?? false,
  };
  return Object.fromEntries(
    Object.entries(next).filter(([key, value]) => value !== current[key as keyof typeof current]),
  ) as Partial<typeof next>;
}
