import { RecruitingApprovalToolInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { builtinAgentTools } from "./builtin-tools.js";

describe("native recruiting approval tool", () => {
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
});
