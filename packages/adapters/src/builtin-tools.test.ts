import {
  DisabledBuiltinToolsSchema,
  disabledBuiltinToolSet,
  RecruitingApprovalToolInputSchema,
  RecruitingCandidatesToolInputSchema,
  RecruitingCrmImportInputSchema,
  RecruitingCrmTargetToolInputSchema,
  RecruitingReplyInputSchema,
} from "@rakazo/contracts";
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
      z.toJSONSchema(RecruitingApprovalToolInputSchema, { io: "input" }),
    );
    expect(tool?.readOnly).not.toBe(true);
    expect(tool?.description).toMatch(/one-time human confirmation/i);
    expect(tool?.description).toMatch(/exact current package/i);
    expect(tool?.description).toMatch(/never self-approve/i);
  });

  it("binds research to the matching playbook gate and keeps continuations in their phase", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_research");

    expect(tool?.description).toContain("purpose, approvalEffectId");
    expect(tool?.description).toContain("calibration uses the G1 documents approval receipt");
    expect(tool?.description).toContain("scale uses the G2 calibration approval receipt");
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
