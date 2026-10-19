import type { MessageBlock, RecruitingPreferenceFeedbackInput } from "@rakazo/contracts";
import {
  RecruitingApprovalToolInputSchema,
  RecruitingPreferenceFeedbackSchema,
} from "@rakazo/contracts";
import { humanizeToolName, redactSecrets } from "@rakazo/core";
import { redactToolArgsForReview } from "./auto-review.js";
import { sharedMemorySaveError } from "./builtin-tools.js";
import { nativeMemorySaveError } from "./memory-tools.js";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;
type CrmApprovalOperation = "crm_update_candidate_stage" | "crm_append_candidate_note";

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: { reviewReason?: string; oneTimeOnly?: boolean; crmOperation?: CrmApprovalOperation },
): Extract<MessageBlock, { kind: "ask" }> {
  const crmOperation = options?.crmOperation;
  const oneTimeOnly = Boolean(crmOperation || options?.oneTimeOnly);
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
  const detail = formatApprovalDetail(
    toolName,
    redactToolArgsForReview(args, secrets),
    options?.reviewReason,
    preference,
    nativeMemory,
    crmOperation,
  );
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(
      redactSecrets(
        crmOperation === "crm_update_candidate_stage"
          ? "Review CRM stage change"
          : crmOperation === "crm_append_candidate_note"
            ? "Review CRM note"
            : toolName === "create_space" || recruitingApproval
              ? `${summary}?`
              : `Review before ${summary}`,
        secrets,
      ),
      MAX_APPROVAL_SUMMARY_LENGTH,
    ),
    detail:
      safeDetail && !recruitingApproval && !preference && !nativeMemory && !oneTimeOnly
        ? truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH)
        : safeDetail,
    status: "pending",
    actions:
      !crmOperation && toolName === "create_space"
        ? [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ]
        : recruitingApproval
          ? [
              {
                id: "allow",
                label: args.stage === "documents" ? "Approve documents" : "Approve calibration",
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

function describeApprovalAction(
  toolName: string,
  args: Record<string, unknown>,
  displayToolName: string,
): string {
  if (toolName === "recruiting_request_approval") {
    return args.stage === "documents" ? "Approve role documents" : "Approve 10-profile calibration";
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
    ? `${humanizeToolName(mcp[1]!)}: ${humanizeToolName(mcp[2]!)}`
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
): string | undefined {
  const lines: string[] = [];
  if (reviewReason?.trim()) {
    lines.push(reviewReason.trim().replace(/\u2014|\u2013/g, "-"));
  }
  if (crmOperation) {
    return [
      `Candidate: ${args.candidateName}`,
      `Role: ${args.roleTitle}`,
      "",
      crmOperation === "crm_append_candidate_note"
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
      `Content:\n${args.content}`,
    );
    return lines.join("\n\n");
  }
  if (toolName === "recruiting_request_approval") {
    const request = RecruitingApprovalToolInputSchema.parse(args);
    lines.push(`Role version: ${request.expectedRoleRevision}`);
    if (request.stage === "documents") {
      lines.push(
        "Job description: attached",
        "Named JD PDF: attached",
        `Anonymous JD PDF: ${request.documents.anonymousPdf ? "attached" : "not provided"}`,
        `Deck: ${request.documents.deck ? "attached" : "not provided"}`,
      );
    } else {
      for (const [index, profile] of request.profiles.entries())
        lines.push(
          `${index + 1}. ${profile.linkedinUrl}`,
          `Evidence: ${profile.evidenceUrl}`,
          `Assessment version: ${profile.assessmentVersion}`,
        );
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
