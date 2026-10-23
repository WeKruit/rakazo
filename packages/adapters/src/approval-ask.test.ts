import { RecruitingApprovalToolInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
  it("confirms exact server-owned requirements in the original one-time card without model display fields", () => {
    const request = RecruitingApprovalToolInputSchema.parse({
      stage: "brief",
      roleId: "internal-role",
      expectedRoleRevision: 3,
    });
    const requirements = `Salary range: GBP 90,000 to 120,000\n${"Exact saved requirement. ".repeat(220)}`;
    const block = buildApprovalAskBlock(
      "original-effect",
      "recruiting_request_approval",
      request,
      [],
      {
        reviewReason: "Model-supplied substitute requirements",
        recruiting: { roleTitle: "Platform engineer", requirements },
      },
    );
    expect(block.text).toBe("Confirm requirements");
    expect(block.actions).toEqual([
      { id: "allow", label: "Confirm requirements" },
      { id: "deny", label: "Deny" },
    ]);
    expect(block.detail).toBe(`Role: Platform engineer\nRole version: 3\n${requirements}`);
    expect(block.detail).not.toContain("internal-role");
    expect(block.detail!.length).toBeGreaterThan(4_000);
    expect(() =>
      buildApprovalAskBlock("original-effect", "recruiting_request_approval", request, []),
    ).toThrow(/verified/i);
    expect(
      RecruitingApprovalToolInputSchema.safeParse({
        ...request,
        requirements: "Model-supplied substitute",
      }).success,
    ).toBe(false);
  });
  it.each([false, true])("shows the complete trusted routine update (%s)", (active) => {
    const prompt = `  Exact instruction.\n${"Keep this paragraph. ".repeat(240)}Ending token-secret  `;
    const args = {
      routineName: "Saved review",
      name: "Updated review",
      prompt,
      crons: ["0 9 * * 1", "15 14 * * 5"],
      timezone: "America/Chicago",
      active,
      notify: !active,
      runAt: "2026-10-20T18:00:00-05:00",
      routineId: "internal-routine-id",
      expectedRevision: 7,
    };
    const block = buildApprovalAskBlock("routine-effect", "schedule_update", args, [
      "token-secret",
    ]);
    expect(block.text).toBe("Review routine change");
    expect(block.detail).toBe(
      `Routine: Saved review\nName: Updated review\nPrompt:\n${prompt.replace("token-secret", "[redacted]")}\nSchedules: Every Monday at 9:00 AM; Every Friday at 2:15 PM\nTimezone: America/Chicago\nStatus: ${active ? "Active" : "Paused"}\nNotifications: ${active ? "Off" : "On"}\nRun at: 2026-10-20T18:00:00-05:00`,
    );
    expect(block.detail!.length).toBeGreaterThan(4_000);
    expect(block.detail).not.toMatch(/internal-|expectedRevision|routineId|token-secret/);
    expect(block.approvalEffectId).toBe("routine-effect");
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "always", "deny"]);
    expect(args.prompt).toBe(prompt);
  });
  it("shows only requested routine changes and keeps the one-time approval option", () => {
    const block = buildApprovalAskBlock(
      "routine-effect",
      "schedule_update",
      { routineName: "Saved review", active: false, crons: [] },
      [],
      { oneTimeOnly: true },
    );
    expect(block.detail).toBe("Routine: Saved review\nSchedules: None\nStatus: Paused");
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
  });
  it.each([undefined, null, "", "   ", 42])(
    "rejects routine approval without a verified name: %s",
    (routineName) => {
      expect(() =>
        buildApprovalAskBlock(
          "routine-effect",
          "schedule_update",
          { routineName, routineId: "internal-routine-id", active: false },
          [],
        ),
      ).toThrow("Schedule approval requires a verified routine name.");
    },
  );
  it.each([true, false])("shows only the trusted shortlist change (%s)", (shortlisted) => {
    const args = {
      candidateName: "Ada Example",
      roleTitle: "Platform Engineer",
      shortlisted,
      candidateKey: "internal-candidate-key",
      roleId: "internal-role-id",
      expectedRevision: 7,
    };
    for (const oneTimeOnly of [false, true]) {
      const block = buildApprovalAskBlock("original-effect", "recruiting_shortlist", args, [], {
        oneTimeOnly,
      });
      expect(block.text).toBe("Review shortlist change");
      expect(block.detail).toBe(
        `Candidate: Ada Example\nRole: Platform Engineer\n\n${shortlisted ? "Add to shortlist" : "Remove from shortlist"}`,
      );
      expect(block.approvalEffectId).toBe("original-effect");
      expect(block.actions?.map((action) => action.id)).toEqual(
        oneTimeOnly ? ["allow", "deny"] : ["allow", "always", "deny"],
      );
      expect(block.detail).not.toMatch(/internal-|Revision|Key|CRM/);
    }
    expect(args.candidateKey).toBe("internal-candidate-key");
  });
  it.each([
    {},
    { candidateKey: "internal-candidate-key", roleId: "internal-role-id", expectedRevision: 7 },
    { candidateName: "", roleTitle: "Platform Engineer", shortlisted: true },
    { candidateName: "Ada Example", roleTitle: " ", shortlisted: true },
    { candidateName: 42, roleTitle: "Platform Engineer", shortlisted: true },
    { candidateName: "Ada Example", roleTitle: [], shortlisted: true },
    { candidateName: "Ada Example", roleTitle: "Platform Engineer", shortlisted: "true" },
  ])("rejects a shortlist approval without a valid display target: %j", (args) => {
    expect(() => buildApprovalAskBlock("effect", "recruiting_shortlist", args, [])).toThrow(
      "Shortlist approval requires a verified candidate, role and action.",
    );
  });
  it.each([
    { operation: "hold", action: "Pause consideration" },
    { operation: "pass", action: "Stop considering" },
    { operation: "resume", action: "Resume consideration" },
  ] as const)(
    "shows only the trusted consideration change for $operation",
    ({ operation, action }) => {
      const args = {
        candidateNames: ["Ada Example", "Grace Example"],
        roleTitle: "Platform Engineer",
        operation,
        candidateKeys: ["internal-candidate-a", "internal-candidate-b"],
        roleId: "internal-role-id",
        quote: "Unrelated private quote",
        model: "Unrelated model output",
      };
      for (const oneTimeOnly of [false, true]) {
        const block = buildApprovalAskBlock("original-effect", "recruiting_feedback", args, [], {
          oneTimeOnly,
          reviewReason: "Unrelated review reason",
        });
        expect(block.text).toBe("Review consideration change");
        expect(block.detail).toBe(
          `Candidates: Ada Example, Grace Example\nRole: Platform Engineer\n\n${action}`,
        );
        expect(block.approvalEffectId).toBe("original-effect");
        expect(block.actions?.map((item) => item.id)).toEqual(
          oneTimeOnly ? ["allow", "deny"] : ["allow", "always", "deny"],
        );
        expect(block.detail).not.toMatch(/internal-|candidateKeys|roleId|quote|model|Unrelated/);
      }
      expect(args.operation).toBe(operation);
      expect(args.candidateKeys).toEqual(["internal-candidate-a", "internal-candidate-b"]);
    },
  );
  it.each([
    {},
    { candidateNames: [] },
    { candidateNames: "Ada Example" },
    { candidateNames: [""] },
    { candidateNames: ["Ada Example", " "] },
    { candidateNames: [42] },
    { candidateNames: ["Ada Example"], roleTitle: "" },
    { candidateNames: ["Ada Example"], roleTitle: " " },
    { candidateNames: ["Ada Example"], roleTitle: [] },
  ])("rejects consideration approval without actual names and role: %j", (invalid) => {
    expect(() =>
      buildApprovalAskBlock(
        "effect",
        "recruiting_feedback",
        {
          roleTitle: "Platform Engineer",
          ...invalid,
          operation: "hold",
        },
        [],
      ),
    ).toThrow("Consideration approval requires verified candidates, role and action.");
  });
  it("keeps all verified consideration targets and redacts secrets", () => {
    const candidateNames = Array.from(
      { length: 250 },
      (_, index) => `Synthetic candidate ${index}`,
    );
    const block = buildApprovalAskBlock(
      "effect",
      "recruiting_feedback",
      {
        candidateNames,
        roleTitle: "Platform Engineer token-secret",
        operation: "hold",
      },
      ["token-secret"],
    );
    expect(block.detail).toBe(
      `Candidates: ${candidateNames.join(", ")}\nRole: Platform Engineer [redacted]\n\nPause consideration`,
    );
    expect(block.detail!.length).toBeGreaterThan(4_000);
  });
  it("shows the verified recruiting role and CRM destination without the frozen binding internals", () => {
    const args = {
      operation: "bind",
      roleId: "internal-recruiting-role",
      expectedRoleRevision: 3,
      expectedBindingEffectId: "internal-prior-binding",
      crmRoleReadEffectId: "internal-role-read",
      roleTitle: "Platform Engineer",
      target: {
        mcpServerId: "internal-server",
        serverRevision: 2,
        organizationId: "10000000-0000-4000-8000-000000000001",
        crmRoleId: "20000000-0000-4000-8000-000000000001",
        crmClientId: "30000000-0000-4000-8000-000000000001",
        clientLabel: "Example Company",
        roleLabel: "Backend Engineer",
      },
    };
    const frozen = structuredClone(args);
    const block = buildApprovalAskBlock("original-binding", "recruiting_crm_target", args, []);
    expect(block.text).toBe("Review CRM role connection");
    expect(block.detail).toBe(
      "Role: Platform Engineer\nCRM client: Example Company\nCRM role: Backend Engineer\n\nConnect this recruiting role to the CRM role pool",
    );
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
    expect(block.approvalEffectId).toBe("original-binding");
    expect(block.status).toBe("pending");
    expect(`${block.text}\n${block.detail}`).not.toMatch(
      /internal-|[0-9a-f]{8}-|Revision|EffectId|recruiting_crm|operation|target:/,
    );
    expect(args).toEqual(frozen);
  });
  it("shows the exact saved candidate facts and verified CRM pool for a renamed native import", () => {
    const args = {
      p_org: "10000000-0000-4000-8000-000000000001",
      p_role: "20000000-0000-4000-8000-000000000001",
      p_name: "Ada Example",
      p_linkedin_url: "https://www.linkedin.com/in/ada-example",
      p_source_file: "rakazo:artifact:internal-artifact:sha256:internal-hash:row:0",
      p_title: "Platform Engineer",
      p_company: "Example Company",
      p_location: "Chicago",
    };
    const target = {
      mcpServerId: "internal-server",
      serverRevision: 2,
      organizationId: args.p_org,
      crmRoleId: args.p_role,
      crmClientId: "30000000-0000-4000-8000-000000000001",
      clientLabel: "Example Robotics",
      roleLabel: "Backend Engineer",
    };
    const frozen = structuredClone(args);
    const block = buildApprovalAskBlock("original-import", "renamed_write", args, [], {
      crmImportTarget: target,
    });
    expect(block.text).toBe("Review CRM import");
    expect(block.detail).toBe(
      "Candidate: Ada Example\nLinkedIn: https://www.linkedin.com/in/ada-example\nCRM client: Example Robotics\nCRM role: Backend Engineer\nSource: Saved research result\nTitle: Platform Engineer\nCompany: Example Company\nLocation: Chicago\n\nSave these supplied facts and add this person to the CRM role pool",
    );
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
    expect(block.approvalEffectId).toBe("original-import");
    expect(block.status).toBe("pending");
    expect(`${block.text}\n${block.detail}`).not.toMatch(
      /internal-|[0-9a-f]{8}-|p_org|p_role|p_source_file|rakazo:|renamed_write/,
    );
    expect(args).toEqual(frozen);
  });
  it.each([
    ["recruiting_crm_target", { operation: "read", roleTitle: "Engineer" }],
    ["recruiting_crm_target", { operation: "unknown", roleTitle: "Engineer" }],
    ["recruiting_crm_target", { operation: "bind", roleTitle: " " }],
    ["recruiting_crm_target", { operation: "bind", roleTitle: "Engineer", target: {} }],
    ["recruiting_crm_import", { p_name: "Ada Example" }],
  ])("rejects an unverifiable native CRM approval preview for %s: %j", (tool, args) => {
    expect(() => buildApprovalAskBlock("effect", tool, args, [])).toThrow(/verified/i);
  });
  it("shows only the verified candidate, canonical role and client for a CRM role binding", () => {
    const args = {
      candidateName: "Ada Example",
      roleTitle: "Platform Engineer",
      clientName: "Example Company",
      p_org: "internal-org",
      p_candidate: "internal-candidate",
      p_role: "internal-role",
    };
    const block = buildApprovalAskBlock("binding-effect", "renamed_write", args, [], {
      crmOperation: "crm_bind_candidate_role",
    });
    expect(block.text).toBe("Review CRM role binding");
    expect(block.detail).toBe(
      "Candidate: Ada Example\nRole: Platform Engineer\nClient: Example Company\n\nBind candidate to this role",
    );
    expect(block.detail).not.toMatch(/internal-|p_org|p_candidate|p_role/);
    expect(block.actions).toEqual([
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ]);
    expect(block.approvalEffectId).toBe("binding-effect");
  });
  it.each(["crm_update_candidate_stage", "crm_append_candidate_note"] as const)(
    "shows only the trusted CRM target and complete approved change for %s",
    (tool) => {
      const note = `  Exact factual note.\n${"Preserve this paragraph. ".repeat(230)}  `;
      const args = {
        candidateName: "Ada *Example*",
        roleTitle: "Platform Engineer",
        ...(tool === "crm_append_candidate_note"
          ? { note }
          : { currentStage: null, newStage: "Interview" }),
        p_candidate: "internal-candidate-id",
        p_expected_updated_at: "internal-cas-token",
        p_expected_notes: "Unrelated old private notes",
      };
      const block = buildApprovalAskBlock("original-effect", tool, args, [], {
        crmOperation: tool,
      });
      expect(block.text).toBe(
        tool === "crm_append_candidate_note" ? "Review CRM note" : "Review CRM stage change",
      );
      expect(block.detail).toBe(
        "Candidate: Ada *Example*\nRole: Platform Engineer\n\n" +
          (tool === "crm_append_candidate_note"
            ? `Visible to organization members.\nNote to append:\n${note}`
            : "Stage: None → Interview"),
      );
      expect(block.detail).not.toMatch(/internal-|expected_|Unrelated|crm_/);
      expect(block.approvalEffectId).toBe("original-effect");
      expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
      expect(args.p_expected_notes).toBe("Unrelated old private notes");
    },
  );
  it("does not infer a CRM target from another tool's display name", () => {
    const block = buildApprovalAskBlock(
      "effect",
      "crm_append_candidate_note",
      { p_note: "Other tool content" },
      [],
    );
    expect(block.text).toBe("Review before Crm append candidate note");
    expect(block.detail).toBe("p_note: Other tool content");
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "always", "deny"]);
  });

  it.each(["recruiting_feedback", "remember", "save_memory", "save_shared_memory"])(
    "shows the exact recruiting preference and scope for %s without internal routing fields",
    (tool) => {
      const content = `Keep facts, inference and missing evidence separate.\n${"Exact preference. ".repeat(260)}token-secret`;
      const preference = {
        target: "preference",
        operation: "add",
        scope: tool === "remember" ? "bot" : "user",
        path: "recruiting/preferences.md",
        expectedRevision: 7,
        content,
        intent: { basis: "direct", quote: "Remember this preference." },
        sourceRefs: [
          {
            id: "source-reference",
            kind: "recruiter_verified",
            anchor: { kind: "message", messageId: "source-message", locator: "text:0" },
            readState: "read",
            readAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
      const args =
        tool === "recruiting_feedback"
          ? preference
          : {
              path: preference.path,
              expectedRevision: preference.expectedRevision,
              content: `Other existing preferences.\n\n${content}`,
              recruitingFeedback: preference,
            };
      const block = buildApprovalAskBlock("original-effect", tool, args, ["token-secret"], {
        oneTimeOnly: tool === "recruiting_feedback",
      });

      expect(block.text).toBe("Review before saving a recruiting preference");
      expect(block.detail).toBe(
        `Applies to: ${preference.scope === "user" ? "your bots in this space" : "this bot"}\n\nPreference:\n${content.replace("token-secret", "[redacted]")}`,
      );
      expect(block.approvalEffectId).toBe("original-effect");
      expect(block.actions).toEqual([
        { id: "allow", label: "Allow once" },
        ...(tool === "recruiting_feedback"
          ? []
          : [{ id: "always", label: "Always allow this tool" }]),
        { id: "deny", label: "Deny" },
      ]);
      expect(block.detail).not.toMatch(
        /source-message|preferences\.md|expectedRevision|sourceRefs|basis/,
      );
      expect(preference.content).toBe(content);
    },
  );

  it.each(["replace", "revoke"] as const)(
    "shows the exact preference being changed for %s",
    (operation) => {
      const block = buildApprovalAskBlock(
        "preference-effect",
        "recruiting_feedback",
        {
          target: "preference",
          operation,
          scope: "bot",
          path: "preferences.md",
          expectedRevision: 2,
          anchor: { start: 11, end: 35, quote: "Keep this exact wording. " },
          ...(operation === "replace" ? { content: "Use the replacement\nexactly. 😀" } : {}),
          intent: { basis: "direct", quote: "Change my preference." },
          sourceRefs: [],
        },
        [],
      );

      expect(block.text).toBe(
        `Review before ${operation === "replace" ? "updating" : "removing"} a recruiting preference`,
      );
      expect(block.detail).toBe(
        `Applies to: this bot\n\nCurrent preference:\nKeep this exact wording. ${operation === "replace" ? "\n\nNew preference:\nUse the replacement\nexactly. 😀" : ""}`,
      );
      expect(block.approvalEffectId).toBe("preference-effect");
      expect(block.actions?.map((action) => action.id)).toEqual(["allow", "always", "deny"]);
    },
  );

  it.each([
    ["mcp__autumn__research", "Review before Autumn: Research"],
    ["gmail_send_email", "Confirm sending email"],
    ["instantly_instantly_activate_campaign", "Confirm sending the first email"],
    ["mcp__instantly__instantly_activate_campaign", "Confirm sending the first email"],
  ])("names %s readably while preserving the exact consent and destination", (tool, label) => {
    const args = {
      to: "Exact Recipient <recipient+review@example.test>",
      subject: "Candidate review",
      body: "Original scope\nKeep this exact text 😀.",
      token: "token-secret",
    };
    const block = buildApprovalAskBlock("original-effect", tool, args, ["token-secret"], {
      reviewReason: "Review this exact destination and content.",
    });
    expect(block.text).toBe(`${label} → ${args.to}`);
    expect(block.detail).toBe(
      `Review this exact destination and content.\nto: ${args.to}\nsubject: ${args.subject}\nbody: ${args.body}\ntoken: [redacted]`,
    );
    expect(block.approvalEffectId).toBe("original-effect");
    expect(block.actions).toEqual([
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow this tool" },
      { id: "deny", label: "Deny" },
    ]);
    expect(args.token).toBe("token-secret");
  });

  it("shows live campaign facts on the Instantly activation card", () => {
    const block = buildApprovalAskBlock(
      "activate-effect",
      "instantly__demo__activate_campaign",
      { campaign_id: "c-1" },
      [],
      {
        oneTimeOnly: true,
        instantlyActivation: {
          campaignName: "Founding Engineer",
          status: "Draft",
          mailbox: "team@example.test",
          recipients: [
            { name: "Ada Lovelace", email: "ada@example.test" },
            { name: null, email: "bob@example.test" },
          ],
          recipientCount: 2,
          stopOnReply: true,
          schedule: "Weekdays 09:00-17:00 America/Chicago",
        },
      },
    );
    expect(block.text).toBe("Confirm sending the first email");
    expect(block.detail).toBe(
      [
        "岗位: Founding Engineer",
        "发件人: team@example.test",
        "收件人 (2):",
        "- Ada Lovelace <ada@example.test>",
        "- bob@example.test",
        "发送时间: Weekdays 09:00-17:00 America/Chicago",
        "",
        "Confirm sending the first email to these recipients",
      ].join("\n"),
    );
    expect(block.detail).not.toContain("c-1");
    expect(`${block.text}\n${block.detail}`).not.toContain("Instantly");
  });

  it("shows a vendor-free reply card that sends only on confirmation", () => {
    const block = buildApprovalAskBlock(
      "reply-effect",
      "instantly__demo__reply_to_email",
      { reply_to_uuid: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69", body: { text: "收到，谢谢" } },
      [],
      {
        oneTimeOnly: true,
        instantlyReply: {
          to: "ada@example.test",
          from: "team@example.test",
          subject: "Re: Founding Engineer",
          inReplyTo: "Founding Engineer, 2026-10-22T00:59:00Z",
          body: "收到，谢谢",
        },
      },
    );
    expect(block.text).toBe("Confirm reply");
    expect(block.detail).toBe(
      [
        "To: ada@example.test",
        "From: team@example.test",
        "Subject: Re: Founding Engineer",
        "In reply to: Founding Engineer, 2026-10-22T00:59:00Z",
        "Body:",
        "收到，谢谢",
        "",
        "Confirm sending this reply",
      ].join("\n"),
    );
    expect(`${block.text}\n${block.detail}`).not.toContain("Instantly");
    expect(block.detail).not.toContain("7a0a8e6e");
    expect(block.actions).toEqual([
      { id: "allow", label: "Confirm and send" },
      { id: "deny", label: "Cancel" },
    ]);
  });

  it("never names the mail server on a remote reply_to_email card", () => {
    const block = buildApprovalAskBlock(
      "reply-effect",
      "mcp__Instantly__reply_to_email",
      { reply_to_uuid: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69", body: { text: "ok" } },
      [],
      { oneTimeOnly: true },
    );
    expect(block.text).toBe("Confirm reply");
    expect(block.text).not.toContain("Instantly");
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
    const pending = buildApprovalAskBlock("e", "instantly__demo__activate_campaign", {}, [], {
      oneTimeOnly: true,
      instantlyActivation: {
        campaignName: null,
        status: null,
        mailbox: "team@example.test",
        recipients: [],
        recipientCount: null,
        stopOnReply: null,
        schedule: null,
      },
    });
    expect(pending.detail).toContain("岗位: this role");
    expect(pending.detail).toContain("收件人 (unknown):");
    expect(pending.detail).not.toMatch(/crm|campaign|lead|stop on reply/i);
  });

  it("redacts known secrets before changing the tool name's case and underscores", () => {
    const block = buildApprovalAskBlock(
      "synthetic-effect",
      "mcp__demo__send_TOKEN_SECRET",
      { to: "recipient@example.test" },
      ["TOKEN_SECRET"],
    );
    expect(block.text).toBe("Review before Demo: Send [redacted] → recipient@example.test");
    expect(block.detail).toBe("to: recipient@example.test");
    expect(JSON.stringify(block)).not.toMatch(/TOKEN_SECRET|token secret/);
    expect(block.approvalEffectId).toBe("synthetic-effect");
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "always", "deny"]);
  });

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

  it.each(["remember", "save_shared_memory"])(
    "shows the complete native memory document and actual scope for %s",
    (tool) => {
      const shared = tool === "save_shared_memory";
      const content = `${shared ? "x".repeat(3_950) : "Exact memory 😀.\n".repeat(350)}\nComplete ending 😀 token-secret`;
      const args = {
        path: " notes/working-preferences.md ",
        content,
        expectedRevision: 1,
        context: { task: "unrelated-metadata", apiKey: "private-key" },
      };
      const block = buildApprovalAskBlock("effect-memory", tool, args, ["token-secret"], {
        reviewReason: "Review this complete replacement.",
        oneTimeOnly: shared,
      });

      expect(block.text).toBe(`Review before saving ${shared ? "shared" : "private"} memory`);
      expect(block.detail).toBe(
        `Review this complete replacement.\n\nMemory note: notes/working-preferences.md\n\nApplies to: ${shared ? "your bots in this space" : "this bot"}\n\nContent:\n${content.replace("token-secret", "[redacted]")}`,
      );
      expect(block.detail!.length).toBeGreaterThan(4_000);
      expect(block.detail).not.toMatch(
        /expectedRevision|unrelated-metadata|private-key|token-secret/,
      );
      expect(block.approvalEffectId).toBe("effect-memory");
      expect(block.status).toBe("pending");
      expect(block.actions).toEqual([
        { id: "allow", label: "Allow once" },
        ...(shared ? [] : [{ id: "always", label: "Always allow this tool" }]),
        { id: "deny", label: "Deny" },
      ]);
      expect(args.content).toBe(content);
      expect(args.context.apiKey).toBe("private-key");
    },
  );

  it("shows the find and replace text for a memory edit", () => {
    const block = buildApprovalAskBlock(
      "effect-memory",
      "remember",
      { edit: { find: "Mondays", replace: "Tuesdays" }, expectedRevision: 2 },
      [],
    );
    expect(block.detail).toBe(
      "Memory note: MEMORY.md\n\nApplies to: this bot\n\nReplace:\nMondays\n\nWith:\nTuesdays",
    );
  });

  it("shows the native default document for a private memory write", () => {
    const block = buildApprovalAskBlock(
      "effect-memory",
      "remember",
      { content: "Keep my working note.", expectedRevision: 0 },
      [],
    );
    expect(block.detail).toBe(
      "Memory note: MEMORY.md\n\nApplies to: this bot\n\nContent:\nKeep my working note.",
    );
  });

  it.each([
    ["remember", { path: "", content: "Keep this.", expectedRevision: 0 }],
    ["remember", { path: "note.md", content: "Keep this." }],
    ["save_shared_memory", { path: "note.md", content: "x".repeat(4_001), expectedRevision: 0 }],
    ["save_memory", { content: "A semantic fact." }],
  ])("keeps generic details for unrecognized or invalid %s arguments", (tool, args) => {
    const block = buildApprovalAskBlock("effect-memory", tool, args, []);
    expect(block.detail).not.toContain("Memory note:");
    expect(block.detail).toContain("content:");
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
      detail: [
        "Role version: 3",
        "Job description: attached",
        "Named JD PDF: attached",
        "Anonymous JD PDF: not provided",
        "Deck: not provided",
      ].join("\n"),
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    for (const value of [request.roleId, "named-pdf", "a".repeat(64), "b".repeat(64)])
      expect(block.detail).not.toContain(value);
  });

  it("shows all ten calibration profiles and every rule beyond the generic detail limit", () => {
    const request = RecruitingApprovalToolInputSchema.parse({
      stage: "calibration",
      roleId: "role",
      expectedRoleRevision: 3,
      documentsApprovalEffectId: "documents-effect",
      profiles: Array.from({ length: 10 }, (_, index) => ({
        candidateKey: `candidate-${index}`,
        source: {
          effectId: "saved-page",
          rowIndex: index,
          providerTaskId: "task",
          roleRevisionId: "revision",
          artifactRef: { artifactId: "artifact", sha256: "a".repeat(64) },
        },
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
      {
        recruiting: {
          roleTitle: "Systems engineer",
          profiles: request.profiles.map((profile, index) => ({
            name: `Verified person ${index}`,
            linkedinUrl: profile.linkedinUrl,
            evidenceUrl: profile.evidenceUrl,
          })),
        },
      },
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
    expect(block.detail).toContain("Role version: 3");
    expect(block.detail).not.toContain("token-secret");
    expect(block.detail).not.toContain("documents-effect");
    expect(block.detail).not.toContain("candidateKey");
    expect(block.detail).toContain("Role: Systems engineer");
    for (let index = 0; index < 10; index++)
      expect(block.detail).toContain(`Verified person ${index}`);
    for (const internal of ["saved-page", "artifact", "providerTaskId", "roleRevisionId"])
      expect(block.detail).not.toContain(internal);
    for (const profile of request.profiles) {
      expect(block.detail).toContain(profile.linkedinUrl);
      expect(block.detail).toContain(profile.evidenceUrl);
      expect(block.detail).not.toContain("Assessment version");
    }
    for (const rule of request.ruleChanges)
      expect(block.detail).toContain(rule.replace("token-secret", "[redacted]"));
  });
});
