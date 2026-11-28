import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
  it.each([false, true])("shows the exact sender and fixed human outcomes (%s)", (select) => {
    const block = buildApprovalAskBlock("sender-effect", "native_instantly_ensure_sender", {}, [], {
      instantlySender: { email: "team@example.test", displayName: "Chosen Company", select },
    });
    expect(block.text).toBe("Use this sending address?");
    expect(block.detail).toBe("Chosen Company <team@example.test>");
    expect(block.actions).toEqual([
      { id: "allow", label: "Use this address", outcome: "created" },
      { id: "deny", label: "Change the address", outcome: "cancelled" },
    ]);
    expect(JSON.stringify(block)).not.toMatch(/instantly|always/i);
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
            {
              name: "Ada Lovelace",
              email: "ada@example.test",
              emailType: "work",
              personalization: "Your engine notes stood out.",
            },
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
        "Role: Founding Engineer",
        "From: team@example.test",
        "To (2):",
        "- Ada Lovelace <ada@example.test> (work email)",
        "  Opening: Your engine notes stood out.",
        "- bob@example.test",
        "Send time: Weekdays 09:00-17:00 America/Chicago",
        "",
        "Confirm sending the first email to these recipients",
      ].join("\n"),
    );
    expect(block.detail).not.toContain("c-1");
    expect(`${block.text}\n${block.detail}`).not.toContain("Instantly");
  });

  it("shows the first email on the activation card, or that there is none", () => {
    const display = {
      campaignName: "Founding Engineer",
      status: "Draft",
      mailbox: "team@example.test",
      recipients: [{ name: "Ada Lovelace", email: "ada@example.test" }],
      recipientCount: 1,
      stopOnReply: true,
      schedule: null,
    };
    const card = (firstEmail: { subject: string; body: string } | null) =>
      buildApprovalAskBlock("e", "instantly__demo__activate_campaign", {}, [], {
        oneTimeOnly: true,
        instantlyActivation: { ...display, firstEmail },
      }).detail;
    expect(card({ subject: "Founding Engineer", body: "Hi Ada,<br/>Open to a chat?" })).toContain(
      "Subject: Founding Engineer\nBody:\nHi Ada,\nOpen to a chat?",
    );
    expect(card(null)).toContain("Body: no email content yet");
  });

  it("shows every email the send approves, each person's as they get it, in plain words", () => {
    // Audit 11-26: follow-ups were never on the card, and it showed raw stored states.
    const block = buildApprovalAskBlock("e", "instantly__demo__activate_campaign", {}, [], {
      oneTimeOnly: true,
      instantlyActivation: {
        senderState: { state: "active", warmup: "active", readyAt: null },
        campaignName: "Founding Engineer",
        status: "Paused",
        mailbox: "team@example.test",
        recipients: [
          {
            name: "Ada Lovelace",
            email: "ada@example.test",
            firstEmail: { subject: "Founding role", body: "<p>Hi Ada</p>" },
            followUps: [
              { after: "3 days after the email before", subject: "", body: "<p>Ada?</p>" },
            ],
          },
        ],
        recipientCount: 1,
        stopOnReply: true,
        schedule: "now",
      },
    });
    expect(block.detail).toBe(
      [
        "Role: Founding Engineer",
        "From: team@example.test",
        "Sending address: ready to send",
        "Warmup: warming up",
        "To (1):",
        "- Ada Lovelace <ada@example.test>",
        "  Subject: Founding role",
        "  Body:",
        "  Hi Ada",
        "  Follow-up 1, 3 days after the email before:",
        "  Subject: (a reply in the same thread)",
        "  Body:",
        "  Ada?",
        "Send time: now",
        "Campaign: paused; this send resumes it",
        "",
        "Confirm sending these emails to these recipients",
      ].join("\n"),
    );
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
    const copied = buildApprovalAskBlock(
      "reply-effect",
      "instantly__demo__reply_to_email",
      { reply_to_uuid: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69", body: { text: "Thanks" } },
      [],
      {
        oneTimeOnly: true,
        instantlyReply: {
          to: "ada@example.test",
          cc: ["lead@client.test"],
          from: "team@example.test",
          subject: "Re: Founding Engineer",
          inReplyTo: null,
          body: "Thanks",
        },
      },
    );
    expect(copied.detail).toContain("To: ada@example.test\nCc: lead@client.test\n");
    expect(block.actions).toEqual([
      { id: "allow", label: "Confirm and send" },
      { id: "deny", label: "Cancel" },
    ]);
  });

  it("shows an interview booking as who, when and what, without the calendar's name or ids", () => {
    const block = buildApprovalAskBlock(
      "booking-effect",
      "mcp__cal-com__create_booking",
      {
        eventTypeId: 5852837,
        start: "2026-10-30T19:00:00Z",
        attendee: { name: "Ada Test", email: "ada@example.test", timeZone: "America/Chicago" },
        bookingFieldsResponses: { title: "Interview – Front Desk Supervisor" },
        location: { type: "integration", integration: "cal-video" },
      },
      [],
      { oneTimeOnly: true },
    );
    expect(block.text).toBe("Confirm interview booking → Ada Test");
    expect(block.detail).toBe(
      [
        "Candidate: Ada Test <ada@example.test>",
        "When: Fri, Oct 30, 2026, 2:00 PM CDT (America/Chicago)",
        "Title: Interview – Front Desk Supervisor",
        "Meeting: Video call",
        "",
        "The candidate gets a calendar invitation once you confirm.",
      ].join("\n"),
    );
    expect(`${block.text}\n${block.detail}`).not.toMatch(/cal-com|Cal-com|5852837/);
  });

  it("shows a connected calendar's event as an interview booking, without the app's name", () => {
    const block = buildApprovalAskBlock(
      "event-effect",
      "mcp__google-calendar__create_event",
      {
        calendarId: "primary",
        summary: "Interview – Front Desk Supervisor",
        start: { dateTime: "2026-11-03T14:00:00-06:00", timeZone: "America/Chicago" },
        end: { dateTime: "2026-11-03T14:30:00-06:00", timeZone: "America/Chicago" },
        attendees: [{ email: "adam@example.test", displayName: "Adam Test" }],
      },
      [],
      { oneTimeOnly: true },
    );
    expect(block.text).toBe("Confirm interview booking → Adam Test");
    expect(block.detail).toBe(
      [
        "Guests: Adam Test <adam@example.test>",
        "When: Tue, Nov 3, 2026, 2:00 PM CST (America/Chicago)",
        "Length: 30 min",
        "Title: Interview – Front Desk Supervisor",
        "",
        "Every guest gets a calendar invitation once you confirm.",
      ].join("\n"),
    );
    expect(`${block.text}\n${block.detail}`).not.toMatch(/google|Google|primary/);
  });

  it("reads a calendar event time without an offset as wall time in its zone", () => {
    const block = buildApprovalAskBlock(
      "event-wall-time",
      "mcp__google-calendar__create_event",
      {
        summary: "Interview with Adam Test",
        start: { dateTime: "2026-11-04T14:00:00", timeZone: "America/Chicago" },
        end: { dateTime: "2026-11-04T14:30:00", timeZone: "America/Chicago" },
        attendees: [{ email: "adam.test@example.com", displayName: "Adam Test" }],
      },
      [],
      { oneTimeOnly: true },
    );
    expect(block.detail).toContain("When: Wed, Nov 4, 2026, 2:00 PM CST (America/Chicago)");
    expect(block.detail).toContain("Length: 30 min");
  });

  it("lists every guest of a calendar booking and what the calendar already holds then", () => {
    const block = buildApprovalAskBlock(
      "event-guests",
      "mcp__google-calendar__create_event",
      {
        summary: "Ethan Park · Senior Data Engineer",
        startTime: "2026-12-01T14:00:00",
        endTime: "2026-12-01T14:30:00",
        timeZone: "America/Chicago",
        attendees: [
          { email: "ethan@candidate.example.test", displayName: "Ethan Park" },
          { email: "priya@client.example.test" },
        ],
        calendarConflicts: [{ start: "2026-12-01T20:15:00Z", end: "2026-12-01T21:00:00Z" }],
      },
      [],
      { oneTimeOnly: true },
    );
    expect(block.text).toBe("Confirm interview booking → Ethan Park");
    expect(block.detail).toBe(
      [
        "Guests: Ethan Park <ethan@candidate.example.test>, priya@client.example.test",
        "When: Tue, Dec 1, 2026, 2:00 PM CST (America/Chicago)",
        "Length: 30 min",
        "Title: Ethan Park · Senior Data Engineer",
        "Already busy then: Tue, Dec 1, 2026, 2:15 PM CST (America/Chicago) – Tue, Dec 1, 2026, 3:00 PM CST (America/Chicago)",
        "",
        "Every guest gets a calendar invitation once you confirm.",
      ].join("\n"),
    );
  });

  it("says when the calendar could not be checked for other events", () => {
    const block = buildApprovalAskBlock(
      "event-unchecked",
      "mcp__google-calendar__create_event",
      {
        summary: "Interview",
        startTime: "2026-12-01T20:00:00Z",
        endTime: "2026-12-01T20:30:00Z",
        attendees: [{ email: "ethan@candidate.example.test" }],
        calendarConflicts: null,
      },
      [],
      { oneTimeOnly: true },
    );
    expect(block.detail).toContain(
      "Your calendar could not be checked for other events at this time.",
    );
  });

  it("shows a calendar move as the current time and the new one, with the event's guests", () => {
    const block = buildApprovalAskBlock(
      "event-move",
      "mcp__google-calendar__update_event",
      {
        eventId: "event-1",
        startTime: "2026-12-02T20:00:00Z",
        endTime: "2026-12-02T20:30:00Z",
        removedAttendeeEmails: ["priya@client.example.test"],
        addedAttendees: [{ email: "sam@client.example.test" }],
        originalEvent: {
          summary: "Interview",
          start: "2026-12-01T20:00:00.000Z",
          end: "2026-12-01T20:30:00.000Z",
          timeZone: "America/Chicago",
          attendees: [
            { email: "ethan@candidate.example.test", displayName: "Ethan Park" },
            { email: "priya@client.example.test" },
          ],
        },
        calendarConflicts: [],
      },
      [],
      { oneTimeOnly: true },
    );
    expect(block.text).toBe("Confirm interview change → Ethan Park");
    expect(block.detail).toBe(
      [
        "Guests: Ethan Park <ethan@candidate.example.test>, sam@client.example.test",
        "Adding: sam@client.example.test",
        "Removing: priya@client.example.test",
        "From: Tue, Dec 1, 2026, 2:00 PM CST (America/Chicago)",
        "To: Wed, Dec 2, 2026, 2:00 PM CST (America/Chicago)",
        "Length: 30 min",
        "Title: Interview",
        "Your calendar is free then.",
        "",
        "Every guest gets the change once you confirm.",
      ].join("\n"),
    );
  });

  it("shows what a calendar cancellation cancels and who is told", () => {
    const block = buildApprovalAskBlock(
      "event-cancel",
      "mcp__google-calendar__delete_event",
      {
        eventId: "event-1",
        originalEvent: {
          summary: "Interview",
          start: "2026-12-01T20:00:00.000Z",
          end: "2026-12-01T20:30:00.000Z",
          timeZone: "America/Chicago",
          attendees: [{ email: "ethan@candidate.example.test", displayName: "Ethan Park" }],
        },
      },
      [],
      { oneTimeOnly: true },
    );
    expect(block.text).toBe("Confirm interview cancellation → Ethan Park");
    expect(block.detail).toBe(
      [
        "Cancel: Interview, Tue, Dec 1, 2026, 2:00 PM CST (America/Chicago)",
        "Guests: Ethan Park <ethan@candidate.example.test>",
        "",
        "Every guest is told it is cancelled once you confirm.",
      ].join("\n"),
    );
  });

  it("shows an interview change as who, from and to, then the original booking", () => {
    const originalBooking = {
      uid: "booking-uid",
      eventTypeId: 5852837,
      start: "2026-10-30T19:00:00.000Z",
      end: "2026-10-30T19:30:00.000Z",
      status: "accepted",
      attendees: [{ name: "Ada Test", email: "ada@example.test", timeZone: "America/Chicago" }],
      hosts: [{ name: "Host" }],
    };
    const block = buildApprovalAskBlock(
      "change-effect",
      "mcp__cal-com__reschedule_booking",
      {
        bookingUid: "booking-uid",
        start: "2026-11-02T20:00:00Z",
        reschedulingReason: "Recruiter asked",
        originalBooking,
      },
      [],
      { oneTimeOnly: true },
    );
    expect(block.text).toBe("Confirm interview change → Ada Test");
    expect(block.detail).toBe(
      [
        "Candidate: Ada Test <ada@example.test>",
        "From: Fri, Oct 30, 2026, 2:00 PM CDT (America/Chicago)",
        "To: Mon, Nov 2, 2026, 2:00 PM CST (America/Chicago)",
        "Reason: Recruiter asked",
        "",
        "The candidate gets the new time once you confirm.",
        "",
        "Original booking:",
        JSON.stringify(originalBooking, null, 2),
      ].join("\n"),
    );
    const cancel = buildApprovalAskBlock(
      "cancel-effect",
      "mcp__cal-com__cancel_booking",
      { bookingUid: "booking-uid", originalBooking },
      [],
      { oneTimeOnly: true },
    );
    expect(cancel.text).toBe("Confirm interview cancellation → Ada Test");
    expect(cancel.detail?.split("\n").slice(0, 2)).toEqual([
      "Candidate: Ada Test <ada@example.test>",
      "Cancel: Fri, Oct 30, 2026, 2:00 PM CDT (America/Chicago)",
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
    expect(pending.detail).toContain("Role: this role");
    expect(pending.detail).toContain("To (unknown):");
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

  it("shows a send from the recruiter's own mailbox as the email itself, confirmed once", () => {
    const block = buildApprovalAskBlock(
      "gmail-effect",
      "mcp__gmail__send_message",
      {
        to: ["ada@example.test"],
        subject: "Senior Backend Engineer in New York",
        body: "Hi Ada,\n\nA payments team in New York is hiring.",
      },
      [],
      { oneTimeOnly: true },
    );
    expect(block.text).toBe("Confirm sending email → ada@example.test");
    expect(block.detail).toBe(
      [
        "To: ada@example.test",
        "Subject: Senior Backend Engineer in New York",
        "Body:",
        "Hi Ada,",
        "",
        "A payments team in New York is hiring.",
        "",
        "Sends from your connected email account. Google may limit or suspend accounts that send bulk outreach; that risk is yours.",
      ].join("\n"),
    );
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
  });
});
