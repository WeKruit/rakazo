import {
  DisabledBuiltinToolsSchema,
  disabledBuiltinToolSet,
  RecruitingApprovalToolCallSchema,
  RecruitingCandidatesToolInputSchema,
  RecruitingCrmImportInputSchema,
  RecruitingCrmTargetToolInputSchema,
  RecruitingReplyInputSchema,
  RecruitingShortlistToolInputSchema,
} from "@rakazo/contracts";
import { RECRUITING_BRIEF_CHECKLIST } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { builtinAgentTools } from "./builtin-tools.js";

describe("native recruiting approval tool", () => {
  it("offers scoped saved candidate reads as a disableable read-only tool", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_candidates");
    expect(tool).toBeDefined();
    expect(tool?.readOnly).toBe(true);
    expect(tool?.inputSchema).toEqual(
      z.toJSONSchema(RecruitingCandidatesToolInputSchema, { io: "input" }),
    );
    expect(DisabledBuiltinToolsSchema.parse(["recruiting_candidates"])).toEqual([
      "recruiting_candidates",
    ]);
    expect(tool?.description).toContain("artifact_read");
    expect(tool?.description).toContain("never choose the first match");
  });

  it("uses the shared CRM contracts and honors native tool disable settings", () => {
    const contracts = [
      ["recruiting_crm_target", RecruitingCrmTargetToolInputSchema],
      ["recruiting_crm_import", RecruitingCrmImportInputSchema],
      ["recruiting_reply", RecruitingReplyInputSchema],
      ["recruiting_shortlist", RecruitingShortlistToolInputSchema],
    ] as const;
    const names = contracts.map(([name]) => name);
    expect(DisabledBuiltinToolsSchema.parse(names)).toEqual(names);
    expect([...disabledBuiltinToolSet(names)]).toEqual(names);
    for (const [name, schema] of contracts) {
      const tool = builtinAgentTools.find((entry) => entry.name === name);
      expect(tool?.inputSchema).toEqual(z.toJSONSchema(schema, { io: "input" }));
      expect(tool?.readOnly).not.toBe(true);
    }
  });

  it("exposes the shared strict staged request as a one-time human approval", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_request_approval");

    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toEqual(
      z.toJSONSchema(RecruitingApprovalToolCallSchema, { io: "input" }),
    );
    expect(tool?.readOnly).not.toBe(true);
    expect(tool?.description).toContain("a documents call is refused");
    expect(tool?.description).toMatch(/never self-approve/i);
    expect(
      RecruitingApprovalToolCallSchema.parse({
        stage: "brief",
        roleId: "role",
        expectedRoleRevision: 3,
      }),
    ).toEqual({ stage: "brief", roleId: "role", expectedRoleRevision: 3 });
    expect(tool?.description).toContain('stage:"brief"');
    expect(tool?.description).toContain("Generic ask_user answers never confirm requirements");
    const role = builtinAgentTools.find((entry) => entry.name === "recruiting_role");
    expect(role?.description).toContain('recruiting_request_approval stage:"brief"');
    expect(role?.description).not.toContain("in the Role panel");
  });

  it("binds research to the matching playbook gate and keeps continuations in their phase", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_research");

    expect(tool?.description).toContain("purpose, approvalEffectId");
    expect(tool?.description).toContain("calibration uses the G1 documents approval receipt");
    expect(tool?.description).toContain("Calibration rounds are never approved on a card");
    expect(tool?.description).toContain("continue keeps the same task and phase");
  });
  it("reuses indexed native row identities when assessing research results", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_assess");
    expect(tool?.description).toContain("reuse the exact candidateKey");
    expect(tool?.description).toContain("candidateRows entry for that rowIndex");
  });
  it("offers optional native result saving without making it a search prerequisite", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_research");
    expect(tool?.description).toContain("save_results");
    expect(tool?.description).toContain("same run");
    expect(tool?.description).toContain("not a prerequisite");
    expect(tool?.description).toContain("linkedin_url");
  });

  it("guides reusable preferences through one exact edit without confusing it with a full document", () => {
    const feedback = builtinAgentTools.find((tool) => tool.name === "recruiting_feedback");
    expect(feedback?.description).toContain(
      'prefer one recruiting_feedback call with target:"preference"',
    );
    expect(feedback?.description).toContain(
      'operation:"add" appends the full exact preference text',
    );
    expect(feedback?.description).toContain('operation:"replace" replaces only the anchored span');
    expect(feedback?.description).toContain('operation:"revoke" removes only that span');
    expect(feedback?.description).toContain("unknown write outcome");

    for (const name of ["remember", "save_shared_memory"]) {
      const tool = builtinAgentTools.find((entry) => entry.name === name)!;
      expect(tool.description).toContain("prefer edit:{find,replace}");
      expect(tool.inputSchema.required).not.toContain("content");
      expect((tool.inputSchema.properties as Record<string, unknown>).edit).toMatchObject({
        required: ["find", "replace"],
      });
    }
    const search = builtinAgentTools.find((entry) => entry.name === "search_history")!;
    expect(
      (search.inputSchema.properties as Record<string, { enum?: string[] }>).scope?.enum,
    ).toEqual(["conversation", "mine"]);
    expect(search.description).toContain("never other people's");
    for (const name of ["remember", "save_shared_memory", "save_memory"]) {
      const tool = builtinAgentTools.find((entry) => entry.name === name);
      expect(tool?.description).toContain(
        'prefer one recruiting_feedback call with target:"preference"',
      );
      expect(tool?.description).toContain(
        "top-level content must be the complete resulting native document",
      );
      expect(tool?.description).toContain(
        "recruitingFeedback.content is the full exact text added or replacing an anchored span, never a summary",
      );
    }
  });
});

describe("recruiting brief checklist", () => {
  it("reaches every account through the role and brief-approval tools", () => {
    const description = (name: string) =>
      builtinAgentTools.find((tool) => tool.name === name)!.description;
    expect(description("recruiting_role")).toContain(RECRUITING_BRIEF_CHECKLIST);
    expect(description("recruiting_request_approval")).toContain(
      "ask the unstated language requirement before this card",
    );
    expect(description("recruiting_request_approval")).toContain(
      "plus the one parallel deep evidence request the calibration rule describes",
    );
  });
});
