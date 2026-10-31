import type {
  MessageBlock,
  RecruitingCrmTarget,
  RecruitingPreferenceFeedbackInput,
} from "@rakazo/contracts";
import {
  RecruitingCrmImportArgsSchema,
  RecruitingCrmTargetSchema,
  RecruitingPreferenceFeedbackSchema,
  RetainedRecruitingApprovalRequestSchema,
} from "@rakazo/contracts";
import { formatCron, humanizeToolName, redactSecrets } from "@rakazo/core";
import { redactToolArgsForReview } from "./auto-review.js";
import { sharedMemorySaveError } from "./builtin-tools.js";
import type {
  InstantlyActivationDisplay,
  InstantlyReplyDisplay,
} from "./instantly-native-writes.js";
import { htmlToPlainText } from "./keyless-http-web.js";
import { nativeMemorySaveError } from "./memory-tools.js";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;
type CrmApprovalOperation =
  | "crm_bind_candidate_role"
  | "crm_update_candidate_stage"
  | "crm_append_candidate_note";

type RecruitingApprovalDisplay = {
  roleTitle: string;
  requirements?: string;
  profiles?: { name: string; linkedinUrl: string; evidenceUrl: string }[];
};

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: {
    reviewReason?: string;
    oneTimeOnly?: boolean;
    /** An email send: offer the recruiter's "send when I say send" preference. */
    sendPreference?: boolean;
    crmOperation?: CrmApprovalOperation;
    recruiting?: RecruitingApprovalDisplay;
    crmImportTarget?: RecruitingCrmTarget;
    instantlyActivation?: InstantlyActivationDisplay;
    instantlyReply?: InstantlyReplyDisplay;
  },
): Extract<MessageBlock, { kind: "ask" }> {
  const scheduleUpdate = toolName === "schedule_update";
  if (scheduleUpdate && (typeof args.routineName !== "string" || !args.routineName.trim()))
    throw new Error("Schedule approval requires a verified routine name.");
  const shortlist = toolName === "recruiting_shortlist";
  if (
    shortlist &&
    (typeof args.candidateName !== "string" ||
      !args.candidateName.trim() ||
      typeof args.roleTitle !== "string" ||
      !args.roleTitle.trim() ||
      typeof args.shortlisted !== "boolean")
  )
    throw new Error("Shortlist approval requires a verified candidate, role and action.");
  const considerationOperation =
    toolName === "recruiting_feedback" &&
    (args.operation === "hold" || args.operation === "pass" || args.operation === "resume")
      ? args.operation
      : undefined;
  if (
    considerationOperation &&
    (!Array.isArray(args.candidateNames) ||
      args.candidateNames.length === 0 ||
      args.candidateNames.some((name) => typeof name !== "string" || !name.trim()) ||
      typeof args.roleTitle !== "string" ||
      !args.roleTitle.trim())
  )
    throw new Error("Consideration approval requires verified candidates, role and action.");
  const crmTarget = toolName === "recruiting_crm_target";
  const crmImport = options?.crmImportTarget !== undefined;
  const target = RecruitingCrmTargetSchema.safeParse(
    crmTarget ? args.target : options?.crmImportTarget,
  );
  if (
    crmTarget &&
    (args.operation !== "bind" ||
      typeof args.roleTitle !== "string" ||
      !args.roleTitle.trim() ||
      !target.success)
  )
    throw new Error("CRM connection approval requires a verified role and destination.");
  const importArgs = crmImport ? RecruitingCrmImportArgsSchema.safeParse(args) : undefined;
  if (
    (toolName === "recruiting_crm_import" && !crmImport) ||
    (crmImport &&
      (!target.success ||
        !importArgs?.success ||
        importArgs.data.p_org !== target.data.organizationId ||
        importArgs.data.p_role !== target.data.crmRoleId))
  )
    throw new Error("CRM import approval requires verified candidate facts and destination.");
  const crmOperation = options?.crmOperation;
  const oneTimeOnly = Boolean(crmTarget || crmImport || crmOperation || options?.oneTimeOnly);
  const recruitingApproval = !crmOperation && toolName === "recruiting_request_approval";
  const parsedPreference = RecruitingPreferenceFeedbackSchema.safeParse(
    toolName === "recruiting_feedback"
      ? args
      : ["remember", "save_memory", "save_shared_memory"].includes(toolName)
        ? args.recruitingFeedback
        : undefined,
  );
  const preference = parsedPreference.success ? parsedPreference.data : undefined;
  const nativeMemory =
    args.recruitingFeedback === undefined &&
    ["remember", "save_shared_memory"].includes(toolName) &&
    !nativeMemorySaveError(args) &&
    (toolName !== "save_shared_memory" || !sharedMemorySaveError(args));
  const summary = preference
    ? `${{ add: "saving", replace: "updating", revoke: "removing" }[preference.operation]} a recruiting preference`
    : nativeMemory
      ? `saving ${toolName === "save_shared_memory" ? "shared" : "private"} memory`
      : describeApprovalAction(toolName, args, redactSecrets(toolName, secrets));
  const detail = options?.instantlyActivation
    ? formatInstantlyActivation(options.instantlyActivation)
    : options?.instantlyReply
      ? formatInstantlyReply(options.instantlyReply)
      : formatApprovalDetail(
          toolName,
          redactToolArgsForReview(args, secrets),
          options?.reviewReason,
          preference,
          nativeMemory,
          crmOperation,
          considerationOperation,
          options?.recruiting,
          options?.crmImportTarget,
        );
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
  const outboundAction = outboundTitle(toolName);
  const outboundTarget =
    outboundAction && (bookingAttendee(toolName, args)?.name ?? pickScopeLabel(args));
  const outbound = outboundTarget ? `${outboundAction} → ${outboundTarget}` : outboundAction;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(
      redactSecrets(
        scheduleUpdate
          ? "Review routine change"
          : options?.instantlyActivation
            ? "Confirm sending the first email"
            : outbound
              ? outbound
              : crmTarget
                ? "Review CRM role connection"
                : crmImport
                  ? "Review CRM import"
                  : shortlist
                    ? "Review shortlist change"
                    : considerationOperation
                      ? "Review consideration change"
                      : crmOperation === "crm_bind_candidate_role"
                        ? "Review CRM role binding"
                        : crmOperation === "crm_update_candidate_stage"
                          ? "Review CRM stage change"
                          : crmOperation === "crm_append_candidate_note"
                            ? "Review CRM note"
                            : recruitingApproval
                              ? summary
                              : toolName === "create_space"
                                ? `${summary}?`
                                : `Review before ${summary}`,
        secrets,
      ),
      MAX_APPROVAL_SUMMARY_LENGTH,
    ),
    detail:
      safeDetail &&
      !scheduleUpdate &&
      !considerationOperation &&
      !recruitingApproval &&
      !preference &&
      !nativeMemory &&
      !oneTimeOnly
        ? truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH)
        : safeDetail,
    status: "pending",
    // A real send is confirmed each time; it is never "always allowed".
    actions: options?.sendPreference
      ? [
          { id: "allow", label: "Confirm and send" },
          { id: "always", label: "Send when I say send" },
          { id: "deny", label: "Cancel" },
        ]
      : options?.instantlyActivation || options?.instantlyReply
        ? [
            { id: "allow", label: "Confirm and send" },
            { id: "deny", label: "Cancel" },
          ]
        : !crmOperation && toolName === "create_space"
          ? [
              { id: "allow", label: "Create space", outcome: "created" },
              { id: "deny", label: "Cancel", outcome: "cancelled" },
            ]
          : recruitingApproval
            ? [
                {
                  id: "allow",
                  label:
                    args.stage === "brief"
                      ? "Looks good, start searching"
                      : args.stage === "documents"
                        ? "Approve documents"
                        : "Approve calibration",
                },
                { id: "deny", label: args.stage === "brief" ? "Needs changes" : "Deny" },
              ]
            : [
                { id: "allow", label: "Allow once" },
                ...(oneTimeOnly ? [] : [{ id: "always", label: "Always allow this tool" }]),
                { id: "deny", label: "Deny" },
              ],
  };
}

const MAX_RECIPIENT_LINES = 20;
/** The send-confirmation card body: no ids, only what the human is approving. */
function formatInstantlyActivation(display: InstantlyActivationDisplay) {
  const unknown = (value: string | number | null) => (value === null ? "unknown" : String(value));
  const count =
    display.recipientCount === null
      ? "unknown"
      : display.recipientCount >= 100
        ? "100+"
        : String(display.recipientCount);
  const shown = display.recipients.slice(0, MAX_RECIPIENT_LINES);
  return [
    `Role: ${display.campaignName ?? "this role"}`,
    `From: ${unknown(display.mailbox)}`,
    `To (${count}):`,
    ...shown.flatMap((r) => [
      `- ${r.name ? `${r.name} <${r.email}>` : r.email}${r.emailType ? ` (${r.emailType} email)` : ""}`,
      ...(r.personalization ? [`  Opening: ${r.personalization}`] : []),
      ...(r.firstEmail
        ? [
            `  Subject: ${r.firstEmail.subject}`,
            "  Body:",
            ...htmlToPlainText(r.firstEmail.body)
              .split("\n")
              .map((line) => (line ? `  ${line}` : "")),
          ]
        : []),
    ]),
    ...(display.recipients.length > shown.length
      ? [`- and ${display.recipients.length - shown.length} more`]
      : []),
    `Send time: ${unknown(display.schedule)}`,
    ...(display.firstEmail === undefined
      ? []
      : display.firstEmail
        ? [
            `Subject: ${display.firstEmail.subject}`,
            "Body:",
            htmlToPlainText(display.firstEmail.body),
          ]
        : ["Body: no email content yet"]),
    ...(display.status && display.status !== "Draft" ? [`Status: ${display.status}`] : []),
    "",
    "Confirm sending the first email to these recipients",
  ].join("\n");
}

// Recruiter-facing titles for outbound mail and calendar actions; never the
// provider or tool name.
const OUTBOUND_TITLES: Record<string, string> = {
  activate_campaign: "Confirm sending the first email",
  reply_to_email: "Confirm reply",
  gmail_reply_to_thread: "Confirm reply",
  gmail_send_email: "Confirm sending email",
  gmail_send_draft: "Confirm sending email",
  gmail_forward_message: "Confirm forwarding email",
  create_lead: "Confirm adding candidates to the campaign",
  add_leads_to_campaign_or_list_bulk: "Confirm adding candidates to the campaign",
  create_booking: "Confirm interview booking",
  reschedule_booking: "Confirm interview change",
  cancel_booking: "Confirm interview cancellation",
  googlecalendar_create_event: "Confirm interview booking",
  googlecalendar_quick_add: "Confirm interview booking",
  googlecalendar_events_import: "Confirm interview booking",
  googlecalendar_update_event: "Confirm interview change",
  googlecalendar_patch_event: "Confirm interview change",
  googlecalendar_events_move: "Confirm interview change",
  googlecalendar_delete_event: "Confirm interview cancellation",
  googlecalendar_remove_attendee: "Confirm interview change",
};

function outboundTitle(toolName: string): string | undefined {
  const operation = (toolName.split("__").at(-1) ?? toolName)
    .toLowerCase()
    .replace(/^(native_)?(instantly_)*/, "");
  return OUTBOUND_TITLES[operation];
}

/** The reply confirmation card body: recipient, sender mailbox, subject, original and full text; no vendor, no ids. */
function formatInstantlyReply(display: InstantlyReplyDisplay) {
  return [
    `To: ${display.to ?? "unknown"}`,
    `From: ${display.from ?? "unknown"}`,
    `Subject: ${display.subject}`,
    `In reply to: ${display.inReplyTo ?? "unknown"}`,
    "Body:",
    display.body,
    "",
    "Confirm sending this reply",
  ].join("\n");
}

function describeApprovalAction(
  toolName: string,
  args: Record<string, unknown>,
  displayToolName: string,
): string {
  if (toolName === "recruiting_request_approval") {
    return args.stage === "brief"
      ? "Role requirements"
      : args.stage === "documents"
        ? "Approve documents"
        : "Approve calibration";
  }
  if (toolName === "destination.write") {
    const collection = args.collection ? String(args.collection) : "records";
    const title = args.title ? ` "${String(args.title)}"` : "";
    return `writing${title} to ${collection}`;
  }
  if (toolName === "delete_bot" || toolName === "archive_bot") {
    const name = args.confirm_name ?? args.confirmName;
    return name
      ? `${displayToolName.replace("_", " ")} (${String(name)})`
      : displayToolName.replace("_", " ");
  }
  if (toolName === "allow_computer_site")
    return `Let the computer reach ${String(args.site ?? "")}`;
  if (toolName === "create_space") {
    const name = args.name ? String(args.name) : "Untitled";
    return `Create space “${name}”`;
  }
  const mcp = displayToolName.match(/^mcp__(.+?)__(.+)$/);
  const action = mcp
    ? `${humanizeToolName(mcp[1]!)}: ${humanizeToolName(mcp[2]!.replace(new RegExp(`^${mcp[1]!.replace(/[^\w]/g, "")}_`, "i"), ""))}`
    : humanizeToolName(displayToolName);
  const target = pickScopeLabel(args);
  return target ? `${action} → ${target}` : action;
}

function formatApprovalDetail(
  toolName: string,
  args: Record<string, unknown>,
  reviewReason?: string,
  preference?: RecruitingPreferenceFeedbackInput,
  nativeMemory = false,
  crmOperation?: CrmApprovalOperation,
  considerationOperation?: "hold" | "pass" | "resume",
  recruiting?: RecruitingApprovalDisplay,
  crmImportTarget?: RecruitingCrmTarget,
): string | undefined {
  const booking = formatBooking(toolName, args) ?? formatBookingChange(toolName, args);
  if (booking) return booking;
  if (toolName === "allow_computer_site") return String(args.reason ?? "") || undefined;
  if (toolName === "recruiting_crm_target") {
    const target = args.target as RecruitingCrmTarget;
    return [
      `Role: ${args.roleTitle}`,
      `CRM client: ${target.clientLabel}`,
      `CRM role: ${target.roleLabel}`,
      "",
      "Connect this recruiting role to the CRM role pool",
    ].join("\n");
  }
  if (crmImportTarget)
    return [
      `Candidate: ${args.p_name}`,
      `LinkedIn: ${args.p_linkedin_url}`,
      `CRM client: ${crmImportTarget.clientLabel}`,
      `CRM role: ${crmImportTarget.roleLabel}`,
      "Source: Saved research result",
      ...(args.p_title === undefined ? [] : [`Title: ${args.p_title}`]),
      ...(args.p_company === undefined ? [] : [`Company: ${args.p_company}`]),
      ...(args.p_location === undefined ? [] : [`Location: ${args.p_location}`]),
      "",
      "Save these supplied facts and add this person to the CRM role pool",
    ].join("\n");
  const lines: string[] = [];
  if (
    reviewReason?.trim() &&
    !(toolName === "recruiting_request_approval" && args.stage === "brief")
  ) {
    lines.push(reviewReason.trim().replace(/\u2014|\u2013/g, "-"));
  }
  if (toolName === "schedule_update") {
    lines.push(`Routine: ${args.routineName}`);
    if (args.name !== undefined) lines.push(`Name: ${args.name}`);
    if (args.prompt !== undefined) lines.push(`Prompt:\n${args.prompt}`);
    if (Array.isArray(args.crons))
      lines.push(`Schedules: ${args.crons.map(formatCron).join("; ") || "None"}`);
    if (args.timezone !== undefined) lines.push(`Timezone: ${args.timezone}`);
    if (args.active !== undefined) lines.push(`Status: ${args.active ? "Active" : "Paused"}`);
    if (args.notify !== undefined) lines.push(`Notifications: ${args.notify ? "On" : "Off"}`);
    if (args.runAt !== undefined) lines.push(`Run at: ${args.runAt}`);
    return lines.join("\n");
  }
  if (toolName === "recruiting_shortlist")
    return [
      `Candidate: ${args.candidateName}`,
      `Role: ${args.roleTitle}`,
      "",
      args.shortlisted ? "Add to shortlist" : "Remove from shortlist",
    ].join("\n");
  if (considerationOperation)
    return [
      `Candidates: ${(args.candidateNames as string[]).join(", ")}`,
      `Role: ${args.roleTitle}`,
      "",
      {
        hold: "Pause consideration",
        pass: "Stop considering",
        resume: "Resume consideration",
      }[considerationOperation],
    ].join("\n");
  if (crmOperation) {
    return [
      `Candidate: ${args.candidateName}`,
      `Role: ${args.roleTitle}`,
      ...(crmOperation === "crm_bind_candidate_role" ? [`Client: ${args.clientName}`] : []),
      "",
      crmOperation === "crm_bind_candidate_role"
        ? "Bind candidate to this role"
        : crmOperation === "crm_append_candidate_note"
          ? `Visible to organization members.\nNote to append:\n${args.note}`
          : `Stage: ${args.currentStage ?? "None"} → ${args.newStage ?? "None"}`,
    ].join("\n");
  }
  if (preference) {
    lines.push(
      `Applies to: ${preference.scope === "user" ? "your bots in this space" : "this bot"}`,
    );
    if (preference.operation !== "add")
      lines.push(`Current preference:\n${preference.anchor.quote}`);
    if (preference.operation !== "revoke")
      lines.push(
        `${preference.operation === "replace" ? "New preference" : "Preference"}:\n${preference.content}`,
      );
    return lines.join("\n\n");
  }
  if (nativeMemory) {
    lines.push(
      `Memory note: ${typeof args.path === "string" ? args.path.trim() : "MEMORY.md"}`,
      `Applies to: ${toolName === "save_shared_memory" ? "your bots in this space" : "this bot"}`,
      args.edit !== undefined
        ? `Replace:\n${(args.edit as { find: string }).find}\n\nWith:\n${(args.edit as { replace: string }).replace}`
        : `Content:\n${args.content}`,
    );
    return lines.join("\n\n");
  }
  if (toolName === "recruiting_request_approval") {
    const request = RetainedRecruitingApprovalRequestSchema.parse(args);
    if (recruiting) lines.push(`Role: ${recruiting.roleTitle}`);
    if (request.stage !== "brief") lines.push(`Role version: ${request.expectedRoleRevision}`);
    if (request.stage === "brief") {
      if (!recruiting?.roleTitle.trim() || !recruiting.requirements?.trim())
        throw new Error("Requirements confirmation requires verified role requirements.");
      lines.push(recruiting.requirements);
    } else if (request.stage === "documents") {
      lines.push(
        "Job description: attached",
        "Named JD PDF: attached",
        `Anonymous JD PDF: ${request.documents.anonymousPdf ? "attached" : "not provided"}`,
        `Deck: ${request.documents.deck ? "attached" : "not provided"}`,
      );
    } else {
      for (const [index, profile] of request.profiles.entries()) {
        if ("source" in profile) {
          const verified = recruiting?.profiles?.[index];
          if (
            !recruiting?.roleTitle.trim() ||
            recruiting.profiles?.length !== 10 ||
            !verified?.name.trim() ||
            verified.linkedinUrl !== profile.linkedinUrl ||
            verified.evidenceUrl !== profile.evidenceUrl
          )
            throw new Error("Calibration approval requires verified role and candidate evidence.");
          lines.push(
            `${index + 1}. ${verified.name}`,
            verified.linkedinUrl,
            `Evidence: ${verified.evidenceUrl}`,
          );
        } else
          lines.push(
            `${index + 1}. ${profile.linkedinUrl}`,
            `Evidence: ${profile.evidenceUrl}`,
            `Assessment version: ${profile.assessmentVersion}`,
          );
      }
      lines.push(
        request.ruleChanges.length ? "Rule changes:" : "Rule changes: none",
        ...request.ruleChanges,
      );
    }
    return lines.join("\n");
  }
  if (toolName === "create_space") {
    lines.push(
      "Bots, groups, chats, files, memory, and integrations in this space stay separate from other spaces.",
    );
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    lines.push(
      `${key}: ${typeof value === "string" && value ? value : JSON.stringify(value, null, 2)}`,
    );
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

type BookingAttendee = { name?: string; email?: string; timeZone?: string };

/** The invitee of a calendar booking request, or of the booking a change or cancellation targets. */
function bookingAttendee(toolName: string, args: Record<string, unknown>) {
  const original = args.originalBooking as { attendees?: unknown } | undefined;
  const attendee = /create_booking$/i.test(toolName)
    ? args.attendee
    : /(reschedule|cancel)_booking$/i.test(toolName) && Array.isArray(original?.attendees)
      ? original.attendees[0]
      : undefined;
  return attendee && typeof attendee === "object" && !Array.isArray(attendee)
    ? (attendee as BookingAttendee)
    : undefined;
}

function bookingTime(value: string, zone: string) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  try {
    return `${new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: zone,
      timeZoneName: "short",
    }).format(time)} (${zone})`;
  } catch {
    return value;
  }
}

/**
 * A change or cancellation card: who, the current time and the new one in the candidate's zone,
 * then the full original booking the approval is bound to.
 */
function formatBookingChange(toolName: string, args: Record<string, unknown>) {
  const cancel = /cancel_booking$/i.test(toolName);
  if (!cancel && !/reschedule_booking$/i.test(toolName)) return undefined;
  const attendee = bookingAttendee(toolName, args);
  const original = args.originalBooking as { start?: unknown } | undefined;
  if (!attendee || typeof original?.start !== "string") return undefined;
  const zone = attendee.timeZone ?? "UTC";
  const reason = args.cancellationReason ?? args.reschedulingReason;
  const known = new Set([
    "bookingUid",
    "start",
    "originalBooking",
    "cancellationReason",
    "reschedulingReason",
    "lengthInMinutes",
  ]);
  return [
    `Candidate: ${attendee.name ?? "unknown"}${attendee.email ? ` <${attendee.email}>` : ""}`,
    cancel
      ? `Cancel: ${bookingTime(original.start, zone)}`
      : `From: ${bookingTime(original.start, zone)}`,
    ...(!cancel && typeof args.start === "string" ? [`To: ${bookingTime(args.start, zone)}`] : []),
    ...(typeof args.lengthInMinutes === "number" ? [`Length: ${args.lengthInMinutes} min`] : []),
    ...(typeof reason === "string" && reason ? [`Reason: ${reason}`] : []),
    ...Object.entries(args)
      .filter(([key, value]) => !known.has(key) && value !== undefined)
      .map(
        ([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
      ),
    "",
    cancel
      ? "The candidate is told the interview is cancelled once you confirm."
      : "The candidate gets the new time once you confirm.",
    "",
    "Original booking:",
    JSON.stringify(args.originalBooking, null, 2),
  ].join("\n");
}

/**
 * A booking card in the recruiter's terms: who is invited, when in their time zone, and what the
 * invite says. Every other field is still listed, so the card shows all that will be sent.
 */
function formatBooking(toolName: string, args: Record<string, unknown>) {
  if (!/create_booking$/i.test(toolName)) return undefined;
  const attendee = bookingAttendee(toolName, args);
  if (!attendee || typeof args.start !== "string") return undefined;
  if (Number.isNaN(Date.parse(args.start))) return undefined;
  const when = bookingTime(args.start, attendee.timeZone ?? "UTC");
  const fields =
    args.bookingFieldsResponses && typeof args.bookingFieldsResponses === "object"
      ? (args.bookingFieldsResponses as Record<string, unknown>)
      : {};
  const location = args.location as { type?: unknown; integration?: unknown } | undefined;
  const meeting =
    location?.type === "integration" || /video/i.test(String(location?.integration ?? ""))
      ? "Video call"
      : location
        ? JSON.stringify(location)
        : undefined;
  const known = new Set([
    "eventTypeId",
    "start",
    "attendee",
    "bookingFieldsResponses",
    "location",
    "lengthInMinutes",
  ]);
  const other = Object.entries(args).filter(([key]) => !known.has(key));
  const otherFields = Object.entries(fields).filter(([key]) => key !== "title" && key !== "notes");
  return [
    `Candidate: ${attendee.name ?? "unknown"}${attendee.email ? ` <${attendee.email}>` : ""}`,
    `When: ${when}`,
    ...(typeof args.lengthInMinutes === "number" ? [`Length: ${args.lengthInMinutes} min`] : []),
    ...(fields.title ? [`Title: ${String(fields.title)}`] : []),
    ...(fields.notes ? [`Notes: ${String(fields.notes)}`] : []),
    ...(meeting ? [`Meeting: ${meeting}`] : []),
    ...[...otherFields, ...other].map(
      ([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    ),
    "",
    "The candidate gets a calendar invitation once you confirm.",
  ].join("\n");
}

function pickScopeLabel(args: Record<string, unknown>): string | undefined {
  for (const key of ["to", "title", "collection", "subject", "amount"]) {
    const value = args[key];
    if (value != null && value !== "") return String(value);
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
