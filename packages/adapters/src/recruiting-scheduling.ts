import type { ConnectorRoute } from "@rakazo/adapter-kit";
import type { RecruitingSchedulingPlan } from "@rakazo/contracts";
import {
  RecruitingSchedulingApprovalEvidenceSchema,
  RecruitingSchedulingPlanInputSchema,
} from "@rakazo/contracts";
import type { z } from "zod";
import { calendarEvidenceHash } from "./calendar-approval.js";

export const SchedulingApprovalEvidenceSchema = RecruitingSchedulingApprovalEvidenceSchema;
export type SchedulingApprovalEvidence = z.infer<typeof SchedulingApprovalEvidenceSchema>;
export function schedulingPlanHash(plan: RecruitingSchedulingPlan) {
  const {
    id: _id,
    createdAt: _created,
    bookingEffectId: _booking,
    confirmationEffectId: _confirmation,
    bookingStatus: _bs,
    confirmationStatus: _cs,
    roleTitle,
    mailSourceRevision,
    mailSourceId,
    mailRead,
    ...input
  } = plan;
  return calendarEvidenceHash({
    input: RecruitingSchedulingPlanInputSchema.parse(input),
    roleTitle,
    mailSourceRevision,
    mailSourceId,
    mailRead,
  });
}
const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const sameEmail = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
export function assertSchedulingCall(
  plan: RecruitingSchedulingPlan,
  operation: "book" | "confirm",
  route: ConnectorRoute,
  args: Record<string, unknown>,
) {
  if (route.connectorId !== "mcp")
    throw new Error("This scheduling plan requires its exact assigned native source");
  if (operation === "book") {
    const attendee = object(args.attendee);
    if (
      route.resourceId !== plan.calendar.sourceId ||
      route.resourceRevision !== plan.calendar.sourceRevision ||
      route.toolName !== "create_booking" ||
      args.eventTypeId !== plan.calendar.eventTypeId ||
      args.start !== plan.calendar.start ||
      (args.lengthInMinutes !== undefined &&
        args.lengthInMinutes !== plan.calendar.lengthInMinutes) ||
      !attendee ||
      !sameEmail(attendee.email, plan.candidate.email) ||
      attendee.name !== plan.candidate.name ||
      attendee.timeZone !== plan.candidate.timeZone ||
      Object.keys(attendee).some(
        (key) => !["name", "email", "timeZone", "language"].includes(key),
      ) ||
      [
        "attendees",
        "guests",
        "hosts",
        "routingFormResponseId",
        "rescheduledBy",
        "allowConflicts",
      ].some((key) => key in args)
    )
      throw new Error(
        "Booking arguments do not match the exact reviewed candidate, interval and participant scope",
      );
  } else if (
    route.resourceId !== plan.mailSourceId ||
    route.resourceRevision !== plan.mailSourceRevision ||
    route.toolName !== "native_instantly_reply_to_email" ||
    args.reply_to_uuid !== plan.originalEmail.providerMessageId ||
    args.eaccount !== plan.originalEmail.eaccount ||
    ["cc", "bcc", "cc_address_email_list", "bcc_address_email_list"].some((key) => key in args)
  ) {
    throw new Error(
      "Confirmation must use the reviewed original message and mailbox without additional recipients",
    );
  }
}
export function schedulingPlanReview(
  plan: RecruitingSchedulingPlan,
  operation: "book" | "confirm",
) {
  const local = (timeZone: string, instant: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "longOffset",
      hourCycle: "h23",
    }).format(new Date(instant));
  return [
    "Scheduling plan",
    `Role: ${plan.roleTitle}`,
    `Candidate: ${plan.candidate.name} <${plan.candidate.email}>`,
    `Requested interviewer: ${plan.interviewer.name} <${plan.interviewer.email}>${operation === "book" ? " (actual calendar host must be verified after booking)" : ""}`,
    `Candidate time: ${local(plan.candidate.timeZone, plan.calendar.start)} – ${local(plan.candidate.timeZone, plan.calendar.end)} (${plan.candidate.timeZone})`,
    `Interviewer time: ${local(plan.interviewer.timeZone, plan.calendar.start)} – ${local(plan.interviewer.timeZone, plan.calendar.end)} (${plan.interviewer.timeZone})`,
    `UTC interval: ${plan.calendar.start} – ${plan.calendar.end}; ${plan.calendar.lengthInMinutes} minutes`,
    `Original conversation: ${plan.originalEmail.subject}`,
    `Sending mailbox: ${plan.originalEmail.eaccount}`,
    operation === "confirm"
      ? "This message confirms the specific verified booking linked to this plan, in the original conversation."
      : "Saving this plan did not authorize this invitation. Review the exact invitation below.",
  ].join("\n");
}
