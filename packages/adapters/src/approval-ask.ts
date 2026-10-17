import type { MessageBlock } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { redactToolArgsForReview } from "./auto-review.js";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: { reviewReason?: string; oneTimeOnly?: boolean },
): MessageBlock {
  const recruitingApproval = toolName === "recruiting_request_approval";
  const summary = describeApprovalAction(toolName, args);
  const detail = formatApprovalDetail(
    toolName,
    redactToolArgsForReview(args, secrets),
    options?.reviewReason,
  );
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(
      redactSecrets(
        toolName === "create_space" || recruitingApproval
          ? `${summary}?`
          : `Review before ${summary}`,
        secrets,
      ),
      MAX_APPROVAL_SUMMARY_LENGTH,
    ),
    detail:
      safeDetail && !recruitingApproval && !options?.oneTimeOnly
        ? truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH)
        : safeDetail,
    status: "pending",
    actions:
      toolName === "create_space"
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
              ...(options?.oneTimeOnly ? [] : [{ id: "always", label: "Always allow this tool" }]),
              { id: "deny", label: "Deny" },
            ],
  };
}

function describeApprovalAction(toolName: string, args: Record<string, unknown>): string {
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
    return name ? `${toolName.replace("_", " ")} (${String(name)})` : toolName.replace("_", " ");
  }
  if (toolName === "create_space") {
    const name = args.name ? String(args.name) : "Untitled";
    return `Create space “${name}”`;
  }
  const target = pickScopeLabel(args);
  return target ? `${toolName} → ${target}` : toolName;
}

function formatApprovalDetail(
  toolName: string,
  args: Record<string, unknown>,
  reviewReason?: string,
): string | undefined {
  const lines: string[] = [];
  if (reviewReason?.trim()) {
    lines.push(reviewReason.trim().replace(/\u2014|\u2013/g, "-"));
  }
  if (toolName === "recruiting_request_approval") {
    lines.push(JSON.stringify(args, null, 2));
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
