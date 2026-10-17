import { RecruitingApprovalToolInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
  it("keeps an exact one-time import request visible without permanent permission", () => {
    const source = `artifact-row:${"x".repeat(5000)}`;
    const block = buildApprovalAskBlock(
      "effect-import",
      "renamed_import",
      { p_name: "Synthetic candidate", p_source_file: source },
      [],
      { oneTimeOnly: true },
    );
    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-import",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
    if (block.kind !== "ask") throw new Error("Expected approval");
    expect(block.detail).toContain(source);
  });

  it("binds the approval to its effect and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", body: "token-secret" },
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token-secret");
  });

  it("bounds model-controlled summaries and details", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "destination.write",
      { title: "t".repeat(1_000), body: "b".repeat(10_000) },
      [],
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(block.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("includes an optional review reason as the first detail line", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", subject: "Hi" },
      [],
      { reviewReason: "Sends email outside the draft-only task." },
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.startsWith("Sends email outside the draft-only task.")).toBe(true);
    expect(block.detail).toContain("to: person@example.test");
  });

  it("shows the actual arguments for native memory and nested MCP actions without exposing credentials", () => {
    const block = buildApprovalAskBlock(
      "effect-memory",
      "save_shared_memory",
      {
        path: "recruiting/review-guidelines.md",
        content: "Separate facts, inference and missing evidence.",
        context: { task: "existing-task", apiKey: "private-key" },
      },
      [],
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("path: recruiting/review-guidelines.md");
    expect(block.detail).toContain("content: Separate facts, inference and missing evidence.");
    expect(block.detail).toContain('"task": "existing-task"');
    expect(block.detail).toContain("[redacted]");
    expect(JSON.stringify(block)).not.toContain("private-key");
  });

  it("uses a one-time create or cancel choice for a new security boundary", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "create_space",
      { name: "Customer support" },
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Create space “Customer support”?",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("stay separate from other spaces");
  });

  it("offers only one-time approval or denial of the exact document package", () => {
    const request = RecruitingApprovalToolInputSchema.parse({
      stage: "documents",
      roleId: "role",
      expectedRoleRevision: 3,
      documents: {
        jdText: { artifactId: "jd", sha256: "a".repeat(64) },
        namedPdf: { artifactId: "named-pdf", sha256: "b".repeat(64) },
        anonymousPdf: null,
        deck: null,
      },
    });
    const block = buildApprovalAskBlock(
      "documents-effect",
      "recruiting_request_approval",
      request,
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "documents-effect",
      text: "Approve role documents?",
      actions: [
        { id: "allow", label: "Approve documents" },
        { id: "deny", label: "Deny" },
      ],
      detail: JSON.stringify(request, null, 2),
    });
  });

  it("shows all ten calibration profiles and every rule beyond the generic detail limit", () => {
    const request = RecruitingApprovalToolInputSchema.parse({
      stage: "calibration",
      roleId: "role",
      expectedRoleRevision: 3,
      documentsApprovalEffectId: "documents-effect",
      profiles: Array.from({ length: 10 }, (_, index) => ({
        candidateKey: `candidate-${index}`,
        assessmentVersion: index + 1,
        linkedinUrl: `https://www.linkedin.com/in/candidate-${index}`,
        evidenceUrl: `https://example.test/evidence/${index}?source=${"context".repeat(80)}`,
      })),
      ruleChanges: Array.from(
        { length: 5 },
        (_, index) => `Rule ${index}: ${"retain exact evidence; ".repeat(30)}token-secret`,
      ),
    });
    if (request.stage !== "calibration") throw new Error("expected calibration request");
    const block = buildApprovalAskBlock(
      "calibration-effect",
      "recruiting_request_approval",
      request,
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "calibration-effect",
      text: "Approve 10-profile calibration?",
      actions: [
        { id: "allow", label: "Approve calibration" },
        { id: "deny", label: "Deny" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.length).toBeGreaterThan(4_000);
    expect(block.detail).toBe(
      JSON.stringify(
        {
          ...request,
          ruleChanges: request.ruleChanges.map((rule) =>
            rule.replace("token-secret", "[redacted]"),
          ),
        },
        null,
        2,
      ),
    );
    expect(block.detail).not.toContain("token-secret");
    for (const profile of request.profiles) expect(block.detail).toContain(profile.candidateKey);
    for (let index = 0; index < request.ruleChanges.length; index++) {
      expect(block.detail).toContain(`Rule ${index}:`);
    }
  });
});
