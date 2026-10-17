import {
  RecruitingCrmBindingInputSchema,
  RecruitingCrmCandidateSyncSchema,
  RecruitingCrmImportArgsSchema,
  RecruitingCrmImportInputSchema,
  RecruitingCrmTargetToolInputSchema,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { boundDirectApprovalRequest, catalogApprovalRequest } from "./action-approval.js";
import {
  deriveRecruitingCrmImportStatus,
  extractRecruitingCrmTarget,
  parseRecruitingCrmImportReceipt,
} from "./recruiting-crm.js";

const marker = "__rakazoCatalogTool";
const org = "10000000-0000-4000-8000-000000000001";
const role = "20000000-0000-4000-8000-000000000002";
const client = "30000000-0000-4000-8000-000000000003";
const route = {
  connectorId: "mcp",
  resourceId: "crm-server",
  resourceRevision: 2,
  toolName: "get_crm_role",
};
const target = {
  mcpServerId: route.resourceId,
  serverRevision: 2,
  organizationId: org,
  crmRoleId: role,
  crmClientId: client,
  clientLabel: " Example Client ",
  roleLabel: " Engineer ",
};
const roleArgs = { p_org: org, p_role: role };
const roleData = {
  role_spec_id: role,
  client_id: client,
  client_label: target.clientLabel,
  role_label: target.roleLabel,
  jd_text: "Additional stored role fields are allowed",
};
const args = {
  ...roleArgs,
  p_name: " Example Person ",
  p_linkedin_url: "https://www.linkedin.com/in/example-person",
  p_source_file: "source-artifact:row:0",
  p_title: " Engineer ",
  p_company: " Example ",
  p_location: " Example City ",
};
const receipt = {
  candidate_id: "40000000-0000-4000-8000-000000000004",
  source_id: "50000000-0000-4000-8000-000000000005",
  membership_id: "60000000-0000-4000-8000-000000000006",
  organization_id: org,
  role_spec_id: role,
  linkedin_identity: "/in/example-person",
  source_file: args.p_source_file,
};
function readEffect() {
  return {
    status: "completed",
    request: boundDirectApprovalRequest(route, roleArgs, marker),
    result: { structuredContent: { data: roleData } },
  };
}
function importEffect() {
  return {
    status: "completed",
    request: boundDirectApprovalRequest(
      { ...route, toolName: "crm_import_candidate" },
      args,
      marker,
    ),
    result: { structuredContent: { data: receipt } },
  };
}

describe("recruiting CRM contracts", () => {
  it("preserves exact source facts and freezes the human binding effect", () => {
    expect(RecruitingCrmImportArgsSchema.parse(args)).toEqual(args);
    expect(
      RecruitingCrmBindingInputSchema.parse({
        operation: "bind",
        roleId: "native-role",
        expectedRoleRevision: 1,
        expectedBindingEffectId: null,
        crmRoleReadEffectId: "read-effect",
      }).operation,
    ).toBe("bind");
    expect(
      RecruitingCrmTargetToolInputSchema.parse({ operation: "read", roleId: "native-role" }),
    ).toEqual({ operation: "read", roleId: "native-role" });
    const input = {
      roleId: "native-role",
      bindingEffectId: "binding-effect",
      candidateKey: "candidate",
      sourceEffectId: "source-effect",
      rowIndex: 0,
    };
    expect(RecruitingCrmImportInputSchema.parse(input)).toEqual(input);
    for (const invalid of [
      { ...input, bindingEffectId: " " },
      { ...input, rowIndex: -1 },
      { ...input, candidate_id: receipt.candidate_id },
    ])
      expect(RecruitingCrmImportInputSchema.safeParse(invalid).success).toBe(false);
    for (const invalid of [
      { ...args, p_stage: "Hired" },
      { ...args, p_name: " " },
      { ...args, p_title: "x".repeat(1001) },
    ])
      expect(RecruitingCrmImportArgsSchema.safeParse(invalid).success).toBe(false);
  });

  it("permits a synced DTO only with a validated receipt", () => {
    const sync = {
      effectId: "effect",
      bindingEffectId: "binding",
      sourceEffectId: "source",
      rowIndex: 0,
      status: "synced",
      receipt,
      target,
    };
    expect(RecruitingCrmCandidateSyncSchema.safeParse(sync).success).toBe(true);
    expect(RecruitingCrmCandidateSyncSchema.safeParse({ ...sync, receipt: null }).success).toBe(
      false,
    );
    expect(RecruitingCrmCandidateSyncSchema.safeParse({ ...sync, status: "unknown" }).success).toBe(
      false,
    );
  });
});

describe("trusted CRM role read receipts", () => {
  it("extracts exact IDs and labels from a completed native role read", () => {
    expect(extractRecruitingCrmTarget(readEffect())).toEqual(target);
  });

  it("accepts the two bound native MCP catalog envelopes", () => {
    for (const tool of ["connectors_execute_tool", "mcp_execute_tool"]) {
      const request = catalogApprovalRequest(
        tool,
        { id: "crm-server:get_crm_role", arguments: roleArgs },
        marker,
        route,
      );
      expect(extractRecruitingCrmTarget({ ...readEffect(), request })).toEqual(target);
    }
  });

  it("rejects unbound foreign changed and unsuccessful role reads", () => {
    const direct = (patch: Record<string, unknown>) =>
      boundDirectApprovalRequest({ ...route, ...patch }, roleArgs, marker);
    for (const effect of [
      { ...readEffect(), status: "approved" },
      { ...readEffect(), request: roleArgs },
      {
        ...readEffect(),
        request: catalogApprovalRequest(
          "mcp_execute_tool",
          { id: "crm-server:get_crm_role", arguments: roleArgs },
          marker,
        ),
      },
      {
        ...readEffect(),
        request: catalogApprovalRequest(
          "foreign_execute_tool",
          { id: "crm-server:get_crm_role", arguments: roleArgs },
          marker,
          route,
        ),
      },
      {
        ...readEffect(),
        request: catalogApprovalRequest(
          "connectors_execute_tool",
          { id: "other:get_crm_role", arguments: roleArgs },
          marker,
          route,
        ),
      },
      ...[
        { connectorId: "other" },
        { toolName: "list_crm_roles" },
        { resourceRevision: 0 },
        { resourceRevision: "2" },
        { resourceId: " " },
      ].map((patch) => ({ ...readEffect(), request: direct(patch) })),
      {
        ...readEffect(),
        request: boundDirectApprovalRequest(route, { ...roleArgs, p_role: "bad" }, marker),
      },
      {
        ...readEffect(),
        result: { content: [{ type: "text", text: JSON.stringify({ data: roleData }) }] },
      },
      ...[true, "false", null].map((isError) => ({
        ...readEffect(),
        result: { isError, structuredContent: { data: roleData } },
      })),
      ...[
        { ...roleData, role_spec_id: client },
        { ...roleData, client_id: "bad" },
        { ...roleData, role_label: " " },
        [roleData],
        null,
      ].map((data) => ({ ...readEffect(), result: { structuredContent: { data } } })),
    ])
      expect(extractRecruitingCrmTarget(effect)).toBeNull();
  });
});

describe("trusted CRM candidate import receipts", () => {
  it("accepts only the actual scoped structured receipt and preserves the database identity", () => {
    expect(parseRecruitingCrmImportReceipt(importEffect(), target, args)).toEqual(receipt);
    const unicode = { ...receipt, linkedin_identity: "/in/database-owned-Unicode-case" };
    expect(
      parseRecruitingCrmImportReceipt(
        { ...importEffect(), result: { isError: false, structuredContent: { data: unicode } } },
        target,
        args,
      ),
    ).toEqual(unicode);
    const request = catalogApprovalRequest(
      "connectors_execute_tool",
      { id: "crm-server:crm_import_candidate", arguments: args },
      marker,
      { ...route, toolName: "crm_import_candidate" },
    );
    expect(parseRecruitingCrmImportReceipt({ ...importEffect(), request }, target, args)).toEqual(
      receipt,
    );
  });

  it("rejects any changed saved scalar argument including omitted professional facts", () => {
    for (const [key, value] of Object.entries(args)) {
      const changed = { ...args, [key]: `${value}changed` };
      const request = boundDirectApprovalRequest(
        { ...route, toolName: "crm_import_candidate" },
        changed,
        marker,
      );
      expect(
        parseRecruitingCrmImportReceipt({ ...importEffect(), request }, target, args),
      ).toBeNull();
    }
    const { p_title: _title, ...omitted } = args;
    const request = boundDirectApprovalRequest(
      { ...route, toolName: "crm_import_candidate" },
      omitted,
      marker,
    );
    expect(
      parseRecruitingCrmImportReceipt({ ...importEffect(), request }, target, args),
    ).toBeNull();
    expect(
      parseRecruitingCrmImportReceipt(importEffect(), { ...target, organizationId: client }, args),
    ).toBeNull();
    expect(
      parseRecruitingCrmImportReceipt(importEffect(), { ...target, crmRoleId: client }, args),
    ).toBeNull();
  });

  it("rejects failed malformed mismatched or model-text import success", () => {
    for (const effect of [
      { ...importEffect(), status: "executing" },
      { ...importEffect(), request: args },
      {
        ...importEffect(),
        request: boundDirectApprovalRequest(
          { ...route, toolName: "crm_import_candidate", resourceRevision: 3 },
          args,
          marker,
        ),
      },
      {
        ...importEffect(),
        request: boundDirectApprovalRequest(
          { ...route, toolName: "crm_import_candidate", resourceId: "other" },
          args,
          marker,
        ),
      },
      {
        ...importEffect(),
        result: { content: [{ type: "text", text: JSON.stringify({ data: receipt }) }] },
      },
      ...[true, "false", null].map((isError) => ({
        ...importEffect(),
        result: { isError, structuredContent: { data: receipt } },
      })),
      ...[
        null,
        [receipt],
        { ...receipt, candidate_id: "bad" },
        { ...receipt, source_id: "bad" },
        { ...receipt, membership_id: "bad" },
        { ...receipt, organization_id: client },
        { ...receipt, role_spec_id: client },
        { ...receipt, source_file: "changed" },
        { ...receipt, linkedin_identity: "/in/ " },
        { ...receipt, linkedin_identity: "/in/a/b" },
        { ...receipt, invented: true },
      ].map((data) => ({ ...importEffect(), result: { structuredContent: { data } } })),
    ])
      expect(parseRecruitingCrmImportReceipt(effect, target, args)).toBeNull();
  });

  it("validates an explicit HTTPS LinkedIn profile in core without case rewriting", () => {
    for (const p_linkedin_url of [
      "https://linkedin.com/in/%C4%B0%CE%9F%CE%A3",
      "https://linkedin.com:443/in/example-person/?source=round#profile",
    ]) {
      const expected = { ...args, p_linkedin_url };
      const effect = {
        ...importEffect(),
        request: boundDirectApprovalRequest(
          { ...route, toolName: "crm_import_candidate" },
          expected,
          marker,
        ),
      };
      expect(parseRecruitingCrmImportReceipt(effect, target, expected)).toEqual(receipt);
    }
    for (const p_linkedin_url of [
      "http://linkedin.com/in/person",
      "https://linkedin.com.evil.test/in/person",
      "https://person@linkedin.com/in/person",
      "https://linkedin.com:444/in/person",
      "https://linkedin.com/in/a%2Fb",
      "https://linkedin.com/in/%00",
      "https://linkedin.com/in/%FF",
      "https://linkedin.com/in/%20",
    ]) {
      const expected = { ...args, p_linkedin_url };
      const effect = {
        ...importEffect(),
        request: boundDirectApprovalRequest(
          { ...route, toolName: "crm_import_candidate" },
          expected,
          marker,
        ),
      };
      expect(parseRecruitingCrmImportReceipt(effect, target, expected)).toBeNull();
    }
  });

  it("stops undispatched intents without rewriting the native approval decision", () => {
    for (const ownerRunStatus of ["cancelled", "failed", "completed"]) {
      for (const status of ["intended", "approved"])
        expect(
          deriveRecruitingCrmImportStatus(
            { ...importEffect(), status, ownerRunStatus },
            target,
            args,
          ),
        ).toBe("stopped");
      expect(
        deriveRecruitingCrmImportStatus({ ...importEffect(), ownerRunStatus }, target, args),
      ).toBe("synced");
    }
    expect(
      RecruitingCrmCandidateSyncSchema.safeParse({
        effectId: "effect",
        bindingEffectId: "binding",
        sourceEffectId: "source",
        rowIndex: 0,
        target,
        status: "stopped",
        receipt: null,
      }).success,
    ).toBe(true);
  });

  it("reports a dispatch as syncing only while its native owner is running", () => {
    for (const ownerRunStatus of [
      undefined,
      "cancelled",
      "failed",
      "completed",
      "queued",
      "leased",
      "waiting_input",
      "unknown",
    ])
      expect(
        deriveRecruitingCrmImportStatus(
          { ...importEffect(), status: "executing", ownerRunStatus },
          target,
          args,
        ),
      ).toBe("unknown");
    expect(
      deriveRecruitingCrmImportStatus(
        { ...importEffect(), status: "executing", ownerRunStatus: "running" },
        target,
        args,
      ),
    ).toBe("syncing");
    expect(
      deriveRecruitingCrmImportStatus(
        { ...importEffect(), status: "approved", ownerRunStatus: "waiting_input" },
        target,
        args,
      ),
    ).toBe("approved");
  });

  it("derives honest status without treating completion alone as a saved candidate", () => {
    for (const [status, expected] of [
      ["intended", "pending"],
      ["approved", "approved"],
      ["executing", "syncing"],
      ["denied", "denied"],
      ["uncertain", "unknown"],
      ["failed", "unknown"],
      ["unexpected", "unknown"],
    ] as const)
      expect(
        deriveRecruitingCrmImportStatus(
          { ...importEffect(), status, ownerRunStatus: "running" },
          target,
          args,
        ),
      ).toBe(expected);
    expect(deriveRecruitingCrmImportStatus(importEffect(), target, args)).toBe("synced");
    expect(
      deriveRecruitingCrmImportStatus(
        { ...importEffect(), result: { error: "not saved" } },
        target,
        args,
      ),
    ).toBe("unknown");
  });
});
