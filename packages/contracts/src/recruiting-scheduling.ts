import * as z from "zod";
import { Id, IsoDate } from "./ids.js";
import { RecruitingCorrespondenceReferenceSchema } from "./recruiting.js";

/** Explicit participant timezone; never inferred from another participant or browser. */
export const SchedulingTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
      return value.includes("/") || value === "UTC";
    } catch {
      return false;
    }
  }, "An explicit IANA timezone is required");
const Participant = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.email(),
  timeZone: SchedulingTimeZoneSchema,
});
export const RecruitingSchedulingSlotSchema = z
  .strictObject({
    sourceId: Id,
    sourceRevision: z.number().int().positive(),
    eventTypeId: z.number().int().positive(),
    availabilityEffectId: Id,
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    lengthInMinutes: z.number().int().positive(),
  })
  .refine(
    (value) => Date.parse(value.end) - Date.parse(value.start) === value.lengthInMinutes * 60_000,
    "The selected interval must match its explicit duration",
  );
export const RecruitingSchedulingPlanInputSchema = z.strictObject({
  threadId: Id,
  roleId: Id,
  expectedRoleRevision: z.number().int().positive(),
  originalEmail: RecruitingCorrespondenceReferenceSchema,
  candidate: Participant.extend({ candidateKey: Id }),
  interviewer: Participant,
  calendar: RecruitingSchedulingSlotSchema,
});
export type RecruitingSchedulingPlanInput = z.infer<typeof RecruitingSchedulingPlanInputSchema>;
export const RecruitingSchedulingPlanSchema = RecruitingSchedulingPlanInputSchema.extend({
  id: Id,
  createdAt: IsoDate,
  roleTitle: z.string().min(1),
  mailSourceId: Id,
  mailSourceRevision: z.number().int().positive(),
  mailRead: z.strictObject({ effectId: Id, linkedRunId: Id, messageId: Id }),
  bookingStatus: z.enum(["pending", "completed", "failed", "uncertain"]).nullable(),
  confirmationStatus: z.enum(["pending", "completed", "failed", "uncertain"]).nullable(),
  bookingEffectId: Id.nullable(),
  confirmationEffectId: Id.nullable(),
});
export type RecruitingSchedulingPlan = z.infer<typeof RecruitingSchedulingPlanSchema>;
/** This wrapper selects an existing plan; only native action approval grants dispatch. */
export const RecruitingSchedulingToolInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("read"), planId: Id }),
  z.strictObject({ operation: z.literal("draft"), plan: RecruitingSchedulingPlanInputSchema }),
  z.strictObject({
    operation: z.literal("book"),
    planId: Id,
    arguments: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    operation: z.literal("confirm"),
    planId: Id,
    subject: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !/[\r\n\0]/.test(value)),
    body: z
      .strictObject({ text: z.string().optional(), html: z.string().optional() })
      .refine((value) => Boolean(value.text?.trim() || value.html?.trim())),
  }),
]);
export type RecruitingSchedulingToolInput = z.infer<typeof RecruitingSchedulingToolInputSchema>;

/** Immutable internal binding shown on a native approval card, never a provider outcome. */
export const RecruitingSchedulingApprovalEvidenceSchema = z
  .strictObject({
    kind: z.literal("recruiting_scheduling"),
    version: z.literal(1),
    planId: Id,
    operation: z.enum(["book", "confirm"]),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    bookingEffectId: Id.nullable(),
  })
  .refine((value) =>
    value.operation === "book" ? value.bookingEffectId === null : value.bookingEffectId !== null,
  );
