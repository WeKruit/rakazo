import * as z from "zod";
import { Id, IsoDate, RunStatus } from "./ids.js";
import { RUN_TRIGGERS } from "./run-triggers.js";

export { RUN_TRIGGERS } from "./run-triggers.js";

export const RunTriggerSchema = z.enum(RUN_TRIGGERS);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

const RoutineRunFields = {
  id: Id,
  botId: Id,
  groupId: Id.nullable(),
  status: RunStatus,
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  messageId: Id.nullable(),
};
export const RoutineDelegationSchema = z.object({
  ...RoutineRunFields,
  parentRunId: Id,
  botName: z.string().min(1),
});
export type RoutineDelegation = z.infer<typeof RoutineDelegationSchema>;
export const RoutineRunSchema = z.object({
  ...RoutineRunFields,
  delegations: z.array(RoutineDelegationSchema),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

export const RoutineRunCursorSchema = z.object({ id: Id, createdAt: IsoDate });
export type RoutineRunCursor = z.infer<typeof RoutineRunCursorSchema>;
export const RoutineHistorySchema = z.object({
  runs: z.array(RoutineRunSchema),
  nextCursor: RoutineRunCursorSchema.nullable(),
});
export type RoutineHistory = z.infer<typeof RoutineHistorySchema>;

export const RunActivityRowSchema = z.object({
  runId: Id,
  botId: Id,
  botName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  threadId: Id,
  status: RunStatus,
  trigger: RunTriggerSchema,
  notificationsEnabled: z.boolean(),
  promptSnippet: z.string(),
  updatedAt: z.string(),
});
export type RunActivityRow = z.infer<typeof RunActivityRowSchema>;

export const RunsListOutputSchema = z.object({
  runs: z.array(RunActivityRowSchema),
});
export type RunsListOutput = z.infer<typeof RunsListOutputSchema>;
