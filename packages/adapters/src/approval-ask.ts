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
  const outboundTarget = outboundAction && pickScopeLabel(args);
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
                            : toolName === "create_space" || recruitingApproval
                              ? args.stage === "brief" && recruitingApproval
                                ? summary
                                : `${summary}?`
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
    actions:
      options?.instantlyActivation || options?.instantlyReply
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
                      ? "Confirm requirements"
                      : args.stage === "documents"
                        ? "Approve documents"
                        : "Approve calibration",
                },
                { id: "deny", label: "Deny" },
              ]
            : [
                { id: "allow", label: "Allow once" },
                ...(oneTimeOnly ? [] : [{ id: "always", label: "Always allow this tool" }]),
                { id: "deny", label: "Deny" },
              ],
  };
}

const MAX_RECIPIENT_LINES = 20;
/** The 「确认发送」 card body: no ids, only what the human is approving. */
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
    `岗位: ${display.campaignName ?? "this role"}`,
    `发件人: ${unknown(display.mailbox)}`,
    `收件人 (${count}):`,
    ...shown.map((r) => `- ${r.name ? `${r.name} <${r.email}>` : r.email}`),
    ...(display.recipients.length > shown.length
      ? [`- and ${display.recipients.length - shown.length} more`]
      : []),
    `发送时间: ${unknown(display.schedule)}`,
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
      ? "Confirm requirements"
      : args.stage === "documents"
        ? "Approve role documents"
        : "Approve 10-profile calibration";
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
    lines.push(`Role version: ${request.expectedRoleRevision}`);
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
