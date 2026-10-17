import type {
  RecruitingCrmCandidateSync,
  RecruitingCrmImportArgs,
  RecruitingCrmImportReceipt,
  RecruitingCrmTarget,
} from "@rakazo/contracts";
import {
  RecruitingCrmImportArgsSchema,
  RecruitingCrmImportReceiptSchema,
  RecruitingCrmTargetSchema,
  RunStatus,
} from "@rakazo/contracts";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "./action-approval.js";
import { recruitingCalibrationIdentity } from "./recruiting-playbook.js";
import { isTerminal } from "./run-state.js";

export type RecruitingCrmEffect = {
  status: string;
  request: unknown;
  result?: unknown;
  ownerRunStatus?: string;
};
const marker = "__rakazoCatalogTool";
const RoleArgs = RecruitingCrmImportArgsSchema.pick({ p_org: true, p_role: true });
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function structuredData(result: unknown): unknown {
  if (
    !record(result) ||
    (result.isError !== undefined && result.isError !== false) ||
    !record(result.structuredContent)
  )
    return null;
  return result.structuredContent.data;
}

function crmRequest(request: unknown, operation: "get_crm_role" | "crm_import_candidate") {
  const direct = boundDirectApprovalDetails(request, marker);
  const catalog = catalogApprovalDetails(request, marker);
  const route = direct?.route ?? catalog?.route;
  if (
    route?.connectorId !== "mcp" ||
    route.toolName !== operation ||
    !route.resourceId.trim() ||
    typeof route.resourceRevision !== "number" ||
    !Number.isSafeInteger(route.resourceRevision) ||
    route.resourceRevision < 1
  )
    return null;
  if (direct) return { route, args: direct.args };
  if (
    !catalog ||
    !["connectors_execute_tool", "mcp_execute_tool"].includes(catalog.toolName) ||
    catalog.args.id !== `${route.resourceId}:${encodeURIComponent(operation)}`
  )
    return null;
  return { route, args: catalog.args.arguments };
}

export function extractRecruitingCrmTarget(
  effect: RecruitingCrmEffect,
): RecruitingCrmTarget | null {
  if (effect.status !== "completed") return null;
  const call = crmRequest(effect.request, "get_crm_role");
  const args = RoleArgs.safeParse(call?.args);
  const role = structuredData(effect.result);
  if (!call || !args.success || !record(role) || role.role_spec_id !== args.data.p_role)
    return null;
  const target = RecruitingCrmTargetSchema.safeParse({
    mcpServerId: call.route.resourceId,
    serverRevision: call.route.resourceRevision,
    organizationId: args.data.p_org,
    crmRoleId: role.role_spec_id,
    crmClientId: role.client_id,
    clientLabel: role.client_label,
    roleLabel: role.role_label,
  });
  return target.success ? target.data : null;
}

function linkedinProfile(value: string): boolean {
  const identity = recruitingCalibrationIdentity(value);
  if (!identity) return false;
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.port &&
    !Array.from(identity).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}

export function parseRecruitingCrmImportReceipt(
  effect: RecruitingCrmEffect,
  target: RecruitingCrmTarget,
  expectedArgs: RecruitingCrmImportArgs,
): RecruitingCrmImportReceipt | null {
  if (effect.status !== "completed" || !RecruitingCrmTargetSchema.safeParse(target).success)
    return null;
  const call = crmRequest(effect.request, "crm_import_candidate");
  const saved = RecruitingCrmImportArgsSchema.safeParse(call?.args);
  const expected = RecruitingCrmImportArgsSchema.safeParse(expectedArgs);
  if (
    !call ||
    !saved.success ||
    !expected.success ||
    call.route.resourceId !== target.mcpServerId ||
    call.route.resourceRevision !== target.serverRevision ||
    expected.data.p_org !== target.organizationId ||
    expected.data.p_role !== target.crmRoleId ||
    !linkedinProfile(expected.data.p_linkedin_url) ||
    (Object.keys(RecruitingCrmImportArgsSchema.shape) as Array<keyof RecruitingCrmImportArgs>).some(
      (key) => saved.data[key] !== expected.data[key],
    )
  )
    return null;
  const receipt = RecruitingCrmImportReceiptSchema.safeParse(structuredData(effect.result));
  return receipt.success &&
    receipt.data.organization_id === target.organizationId &&
    receipt.data.role_spec_id === target.crmRoleId &&
    receipt.data.source_file === expected.data.p_source_file
    ? receipt.data
    : null;
}

export function deriveRecruitingCrmImportStatus(
  effect: RecruitingCrmEffect,
  target: RecruitingCrmTarget,
  expectedArgs: RecruitingCrmImportArgs,
): RecruitingCrmCandidateSync["status"] {
  const owner = RunStatus.safeParse(effect.ownerRunStatus);
  const stopped = owner.success && isTerminal(owner.data);
  switch (effect.status) {
    case "intended":
      return stopped ? "stopped" : "pending";
    case "approved":
      return stopped ? "stopped" : "approved";
    case "executing":
      return effect.ownerRunStatus === "running" ? "syncing" : "unknown";
    case "denied":
      return "denied";
    case "completed":
      return parseRecruitingCrmImportReceipt(effect, target, expectedArgs) ? "synced" : "unknown";
    default:
      return "unknown";
  }
}
