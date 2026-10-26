import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contracts from "./index.js";

const now = "2026-01-01T00:00:00.000Z";
it("keeps observed mail metadata optional and validates its known types", () => {
  const schema = contracts.RecruitingCorrespondenceSchema.shape.emails.element;
  const base = {
    id: "email",
    sourceName: "Source",
    sourceId: "source",
    providerMessageId: "provider-message",
    savedRead: null,
    sender: null,
    recipients: [],
    subject: "Subject",
    body: "Body",
    snippet: false,
    date: now,
    url: null,
  };
  expect(schema.parse(base)).not.toHaveProperty("unread");
  const observed = {
    ...base,
    unread: false,
    leadId: "90000000-0000-4000-8000-000000000009",
    step: "Follow-up",
    observedAt: now,
  };
  expect(schema.parse(observed)).toEqual(observed);
  expect(schema.parse({ ...base, unread: null, leadId: null, step: null })).toMatchObject({
    unread: null,
    leadId: null,
    step: null,
  });
  for (const invalid of [
    { unread: 1 },
    { leadId: "guessed-lead" },
    { step: 2 },
    { observedAt: "yesterday" },
  ])
    expect(schema.safeParse({ ...base, ...invalid }).success).toBe(false);
});

it("keeps CRM role UI locators closed and separate from business binding receipts", () => {
  const reference = {
    sourceId: "source",
    serverRevision: 2,
    organizationId: "10000000-0000-4000-8000-000000000001",
    crmRoleId: "20000000-0000-4000-8000-000000000002",
  };
  expect(contracts.RecruitingCrmRoleReferenceSchema.parse(reference)).toEqual(reference);
  expect(
    contracts.RecruitingCrmRoleReferenceSchema.safeParse({
      ...reference,
      crmRoleId: "Same role name",
    }).success,
  ).toBe(false);
  expect(
    contracts.RecruitingCrmRoleReferenceSchema.safeParse({
      ...reference,
      bindingEffectId: "fake-proof",
    }).success,
  ).toBe(false);
  expect(
    contracts.RecruitingCrmRoleReferenceSchema.safeParse({ ...reference, serverRevision: 0 })
      .success,
  ).toBe(false);
});
const artifact = { artifactId: "artifact-version-sample", sha256: "a".repeat(64) };
const source = {
  id: "source-sample",
  kind: "original_material",
  anchor: { kind: "artifact", artifact, locator: "page 1, paragraph 2" },
  readState: "read",
  readAt: now,
  quote: "Built the example component.",
};
const criterion = {
  id: "criterion-sample",
  priority: "hard",
  expression: { kind: "atom", id: "atom-sample", statement: "Implemented the component" },
  sourceRefs: [source],
  definitionQuestions: [],
};
const definition = {
  sourceRefs: [source],
  criteria: [criterion],
  preferences: ["Example preference"],
  definitionQuestions: [],
};
const role = {
  id: "role-sample",
  spaceId: "space-sample",
  userId: "user-sample",
  sourceThreadId: "thread-sample",
  title: "Example engineer",
  revision: 1,
  currentRevisionId: "role-revision-sample",
};
const assessment = {
  roleId: role.id,
  candidateKey: "candidate-local-row-sample",
  version: 1,
  basedOnVersion: null,
  roleRevisionId: role.currentRevisionId,
  facts: [
    {
      kind: "statement",
      id: "fact-sample",
      statement: "Implemented the component",
      sourceRefIds: [source.id],
    },
  ],
  judgments: {
    atoms: [
      {
        atomId: "atom-sample",
        verdict: "met",
        factIds: ["fact-sample"],
        evidence: [source.id],
        missing: [],
      },
    ],
    employment: [],
    criteria: [
      {
        criterionId: "atom-sample",
        verdict: "met",
        factIds: ["fact-sample"],
        evidence: [source.id],
        missing: [],
      },
    ],
    hardGate: "met",
  },
  questions: [],
  sourceRefs: [
    { ...source, selection: { kind: "artifact_text", start: 0, end: source.quote.length } },
  ],
  createdByRunId: "run-sample",
  createdAt: now,
};
const action = {
  id: "action-sample",
  taskId: "task-sample",
  roleRevisionId: role.currentRevisionId,
  runId: "run-sample",
  sourceMessageId: "message-sample",
  clientNonce: "nonce-sample",
  kind: "create",
  deliveryState: "unknown",
  observedProviderState: null,
  requestArtifact: artifact,
  contextArtifact: artifact,
  receiptArtifact: null,
  outputArtifacts: [],
  recallScope: "This round only: the example region",
  cursor: null,
  effectId: "effect-sample",
  usage: null,
};

describe("recruiting contracts", () => {
  it("keeps an optional provider display status equal to its original supplied value", () => {
    const report = {
      fields: [{ label: "Requirement", value: "match", providerStatus: "match", sourceUrls: [] }],
      sourceUrls: [],
    };
    expect(contracts.RecruitingCandidateReportSchema.safeParse(report).success).toBe(true);
    expect(
      contracts.RecruitingCandidateReportSchema.safeParse({
        ...report,
        fields: [{ ...report.fields[0], providerStatus: "miss" }],
      }).success,
    ).toBe(false);
    expect(
      contracts.RecruitingCandidateReportSchema.safeParse({
        ...report,
        fields: [{ ...report.fields[0], value: "met", providerStatus: "met" }],
      }).success,
    ).toBe(false);
  });
  it("requires explicit native correspondence records in a CRM mail page", () => {
    const page = {
      operation: "mail",
      source: {
        serverId: "crm",
        serverRevision: 1,
        name: "CRM",
        organizationId: "10000000-0000-4000-8000-000000000001",
      },
      checkedAt: now,
      scope: "stored_candidate_correspondence",
      candidateId: "20000000-0000-4000-8000-000000000002",
      items: [],
      outbox: [],
      nextCursor: null,
    };
    expect(contracts.RecruitingCrmDataOutputSchema.safeParse(page).success).toBe(false);
    expect(
      contracts.RecruitingCrmDataOutputSchema.safeParse({ ...page, nativeCorrespondence: [] })
        .success,
    ).toBe(true);
    const unknown = {
      id: "effect",
      roleId: role.id,
      bindingEffectId: "binding",
      crmRoleId: page.candidateId,
      candidateId: page.candidateId,
      checkedAt: now,
      status: "unknown",
      email: null,
    };
    expect(contracts.RecruitingNativeCorrespondenceSchema.safeParse(unknown).success).toBe(true);
    expect(
      contracts.RecruitingNativeCorrespondenceSchema.safeParse({
        ...unknown,
        status: "sent_recorded",
      }).success,
    ).toBe(false);
  });
  it("returns the verified CRM target only in the getWorkspace RPC output", () => {
    const snapshot = {
      role,
      revision: {
        id: role.currentRevisionId,
        roleId: role.id,
        revision: 1,
        createdAt: now,
        ...definition,
      },
    };
    const output = contracts.appContract.recruiting.getWorkspace["~orpc"].outputSchema!;
    const crmTarget = {
      bindingEffectId: "binding-sample",
      target: {
        mcpServerId: "crm-sample",
        serverRevision: 2,
        organizationId: "10000000-0000-4000-8000-000000000001",
        crmRoleId: "20000000-0000-4000-8000-000000000002",
        crmClientId: "30000000-0000-4000-8000-000000000003",
        clientLabel: "Client",
        roleLabel: "Role",
      },
    };
    for (const target of [null, crmTarget])
      expect(output.parse({ ...snapshot, crmTarget: target })?.crmTarget).toEqual(target);
    expect(output.safeParse(snapshot).success).toBe(false);
    expect(output.parse(null)).toBeNull();
    expect(
      contracts.appContract.recruiting.createRole["~orpc"].outputSchema!.safeParse(snapshot)
        .success,
    ).toBe(true);
    expect(
      contracts.appContract.recruiting.createRole["~orpc"].outputSchema!.safeParse({
        ...snapshot,
        crmTarget,
      }).success,
    ).toBe(false);
  });
  it("accepts a post-result native candidate save without a custom research action", () => {
    const input = {
      operation: "save_results",
      expectedRoleRevision: 1,
      mcpServerId: "research-server",
      providerTaskId: "provider-task",
    };
    expect(contracts.RecruitingResearchToolInputSchema.parse(input)).toEqual({
      ...input,
      cursor: null,
    });
    const { mcpServerId: _, ...withoutInternalId } = input;
    expect(contracts.RecruitingResearchToolInputSchema.parse(withoutInternalId)).toEqual({
      ...withoutInternalId,
      cursor: null,
    });
    for (const cursor of [null, "  opaque+/=\r\n "]) {
      expect(contracts.RecruitingResearchToolInputSchema.parse({ ...input, cursor })).toEqual({
        ...input,
        cursor,
      });
    }
    for (const invalid of [
      { expectedRoleRevision: 0 },
      { expectedRoleRevision: 1.5 },
      { mcpServerId: " " },
      { providerTaskId: "" },
      { providerTaskId: " " },
      { roleId: "forged-role" },
      { actionId: "custom-action" },
      { sourceEffectId: "forged-effect" },
      { cursor: "" },
    ]) {
      expect(
        contracts.RecruitingResearchToolInputSchema.safeParse({ ...input, ...invalid }).success,
      ).toBe(false);
    }
  });

  it("requires candidate source task/action references to be present or null together", () => {
    const source = {
      crmImports: [],
      providerTaskId: "provider-task",
      taskId: null,
      actionId: null,
      roleRevisionId: role.currentRevisionId,
      effectId: "native-read-effect",
      rowIndex: 0,
      artifactRef: artifact,
      requestCursor: null,
      outputId: null,
      observedAt: now,
    };
    expect(contracts.RecruitingCandidateSourceSchema.parse(source)).toEqual(source);
    expect(
      contracts.RecruitingCandidateSourceSchema.parse({
        ...source,
        taskId: action.taskId,
        actionId: action.id,
      }),
    ).toEqual({ ...source, taskId: action.taskId, actionId: action.id });
    // A recruiter CSV import page has no provider task.
    expect(
      contracts.RecruitingCandidateSourceSchema.safeParse({ ...source, providerTaskId: null })
        .success,
    ).toBe(true);
    for (const references of [
      { providerTaskId: undefined },
      { providerTaskId: " " },
      { taskId: action.taskId, actionId: null },
      { taskId: null, actionId: action.id },
      { taskId: undefined, actionId: undefined },
    ]) {
      expect(
        contracts.RecruitingCandidateSourceSchema.safeParse({ ...source, ...references }).success,
      ).toBe(false);
    }
  });

  it("defaults omitted brief lists and admits only neutral human filter edits", () => {
    const brief = { fields: [], questions: [], rules: [], searchFilters: [] };
    expect(contracts.RecruitingBriefDraftSchema.parse(brief)).toEqual(brief);
    expect(contracts.RecruitingBriefDraftSchema.parse({ fields: [] })).toEqual(brief);
    const filter = {
      id: "region",
      statement: "Search the UK",
      mode: "include",
      origin: "jd",
      sourceRefIds: [source.id],
    };
    expect(
      contracts.RecruitingBriefDraftSchema.parse({ ...brief, searchFilters: [filter] })
        .searchFilters,
    ).toEqual([filter]);
    const edit = {
      threadId: "thread",
      roleId: "role",
      expectedRevision: 1,
      criteria: [
        {
          criterionId: "criterion",
          priority: "hard",
          atoms: [{ atomId: "atom", statement: "Same qualification" }],
        },
      ],
      searchFilters: [{ id: filter.id, statement: filter.statement, mode: filter.mode }],
    };
    expect(contracts.EditRecruitingCriteriaInput.parse(edit)).toEqual(edit);
    expect(contracts.EditRecruitingCriteriaInput.parse({ ...edit, criteria: [] }).criteria).toEqual(
      [],
    );
    expect(
      contracts.EditRecruitingCriteriaInput.parse({ ...edit, searchFilters: [] }).searchFilters,
    ).toEqual([]);
    for (const filters of [
      [edit.searchFilters[0], edit.searchFilters[0]],
      [{ ...edit.searchFilters[0], id: " " }],
      [{ ...edit.searchFilters[0], statement: " " }],
      [{ ...edit.searchFilters[0], mode: "hard" }],
      [{ ...edit.searchFilters[0], origin: "jd" }],
      [{ ...edit.searchFilters[0], sourceRefIds: [source.id] }],
    ])
      expect(
        contracts.EditRecruitingCriteriaInput.safeParse({ ...edit, searchFilters: filters })
          .success,
      ).toBe(false);
  });
  it("accepts only human criterion text and priority edits with unique IDs", () => {
    const input = {
      threadId: "thread",
      roleId: "role",
      expectedRevision: 1,
      criteria: [
        {
          criterionId: "criterion",
          priority: "hard",
          atoms: [{ atomId: "atom", statement: "New statement" }],
        },
      ],
    };
    expect(contracts.EditRecruitingCriteriaInput.parse(input)).toEqual(input);
    const typedAtom = {
      atomId: "atom",
      employmentRule: {
        minimumMonths: 84,
        countingRule: "complete_calendar_months",
        qualificationDefinition: "Full-time personal geometry implementation",
        cutoff: { kind: "assessment_date" },
      },
    };
    const typed = { ...input, criteria: [{ ...input.criteria[0], atoms: [typedAtom] }] };
    expect(contracts.EditRecruitingCriteriaInput.parse(typed)).toEqual(typed);
    for (const atom of [
      { ...typedAtom, statement: "5+ years" },
      { atomId: "atom" },
      { ...typedAtom, employmentRule: { ...typedAtom.employmentRule, minimumMonths: -1 } },
      {
        ...typedAtom,
        employmentRule: { ...typedAtom.employmentRule, qualificationDefinition: " " },
      },
      {
        ...typedAtom,
        employmentRule: { ...typedAtom.employmentRule, countingRule: "sum_all_jobs" },
      },
      {
        ...typedAtom,
        employmentRule: {
          ...typedAtom.employmentRule,
          cutoff: { kind: "fixed", date: { precision: "day", year: 2026, month: 2, day: 30 } },
        },
      },
    ])
      expect(
        contracts.EditRecruitingCriteriaInput.safeParse({
          ...input,
          criteria: [{ ...input.criteria[0], atoms: [atom] }],
        }).success,
      ).toBe(false);
    for (const extra of ["actor", "sourceRefs", "confirmation", "expression"]) {
      expect(
        contracts.EditRecruitingCriteriaInput.safeParse({ ...input, [extra]: {} }).success,
      ).toBe(false);
      expect(
        contracts.EditRecruitingCriteriaInput.safeParse({
          ...input,
          criteria: [{ ...input.criteria[0], [extra]: {} }],
        }).success,
      ).toBe(false);
    }
    for (const criteria of [
      [],
      [input.criteria[0], input.criteria[0]],
      [{ ...input.criteria[0], priority: "optional" }],
      [{ ...input.criteria[0], atoms: [] }],
      [{ ...input.criteria[0], atoms: [input.criteria[0]!.atoms[0], input.criteria[0]!.atoms[0]] }],
      [{ ...input.criteria[0], atoms: [{ atomId: "atom", statement: "  " }] }],
      [
        {
          ...input.criteria[0],
          atoms: [{ atomId: "atom", statement: "Text", employmentRule: {} }],
        },
      ],
    ])
      expect(contracts.EditRecruitingCriteriaInput.safeParse({ ...input, criteria }).success).toBe(
        false,
      );
  });
  const researchRound = {
    expectedRoleRevision: 1,
    purpose: "calibration",
    approvalEffectId: "documents-approval",
    clientNonce: "round-nonce",
    instructions: "  Preserve every current qualification.\r\nUse supplied evidence.\n",
    output: "  Include original source cells and evidence gaps.\n",
    recallScope: "  This round only: the example region.\r\n",
    intent: { basis: "direct", quote: "Find candidates for this role" },
  };
  const researchInputs = [
    { ...researchRound, operation: "prepare", mcpServerId: "research-server" },
    { ...researchRound, operation: "continue", taskId: "local-research-task" },
    { operation: "start", actionId: "prepared-action" },
    { operation: "status", taskId: "local-research-task" },
    { operation: "rows", taskId: "local-research-task", limit: 7, cursor: "  opaque+/=\r\n " },
  ];

  it.each(researchInputs)(
    "accepts the closed native research $operation input without changing its bytes",
    (input) => {
      expect(contracts.RecruitingResearchToolInputSchema?.parse(input)).toEqual(input);
      for (const field of [
        "actor",
        "ownerId",
        "spaceId",
        "userId",
        "botId",
        "runId",
        "threadId",
        "sourceMessageId",
        "roleId",
        "roleRevisionId",
        "sourceRefs",
        "effectId",
        "requestArtifact",
        "contextArtifact",
        "receiptArtifact",
        "outputArtifacts",
        "providerTaskId",
        "task_id",
        "prompt",
        "message",
        "arguments",
      ]) {
        expect(
          contracts.RecruitingResearchToolInputSchema?.safeParse({ ...input, [field]: "forged" })
            .success,
        ).toBe(false);
      }
    },
  );

  it("allows omitting a local task only for scale continuation from the completed native G2", () => {
    const input = {
      ...researchRound,
      operation: "continue",
      purpose: "scale",
      approvalEffectId: "g2",
    };
    expect(contracts.RecruitingResearchToolInputSchema.parse(input)).toEqual(input);
    expect(
      contracts.RecruitingResearchToolInputSchema.safeParse({ ...input, purpose: "calibration" })
        .success,
    ).toBe(false);
    for (const injected of [
      { providerTaskId: "provider" },
      { mcpServerId: "server" },
      { serverRevision: 1 },
    ])
      expect(
        contracts.RecruitingResearchToolInputSchema.safeParse({ ...input, ...injected }).success,
      ).toBe(false);
  });
  it("rejects invalid research identifiers, revisions and blank round text", () => {
    const prepare = researchInputs[0]!;
    for (const invalid of [
      { mcpServerId: "" },
      { mcpServerId: "  " },
      { clientNonce: "" },
      { clientNonce: "\n" },
      { expectedRoleRevision: 0 },
      { expectedRoleRevision: -1 },
      { expectedRoleRevision: 1.5 },
      { expectedRoleRevision: "1" },
      { purpose: undefined },
      { purpose: "guess" },
      { approvalEffectId: undefined },
      { approvalEffectId: " " },
      { instructions: " \r\n\t" },
      { output: "" },
      { output: " \n" },
      { recallScope: " \r\n" },
      { instructions: undefined },
      { output: undefined },
      { intent: { basis: "assistant", quote: "search" } },
      { intent: { basis: "direct", quote: " " } },
      { intent: { basis: "direct", quote: "search", actor: "forged" } },
    ]) {
      expect(
        contracts.RecruitingResearchToolInputSchema?.safeParse({ ...prepare, ...invalid }).success,
      ).toBe(false);
    }
    expect(
      contracts.RecruitingResearchToolInputSchema?.parse({ ...prepare, recallScope: null }),
    ).toEqual({ ...prepare, recallScope: null });
    for (const input of [
      { ...researchInputs[1], taskId: " " },
      { operation: "start", actionId: "" },
      { operation: "status", taskId: "\n" },
      { operation: "rows", taskId: "" },
      { operation: "rows", taskId: "task", limit: 0 },
      { operation: "rows", taskId: "task", limit: 1.5 },
      { operation: "rows", taskId: "task", cursor: "" },
      { ...prepare, taskId: "unexpected-task" },
      { ...researchInputs[1], mcpServerId: "unexpected-server" },
      { operation: "start", actionId: "action", ...researchRound },
      { operation: "status", taskId: "task", limit: 1 },
      { operation: "rows", taskId: "task", actionId: "action" },
    ]) {
      expect(contracts.RecruitingResearchToolInputSchema?.safeParse(input).success).toBe(false);
    }
  });

  it("requires exact stage-specific approval packages without accepting an approval from the model", () => {
    const documents = {
      stage: "documents",
      roleId: role.id,
      expectedRoleRevision: role.revision,
      documents: { jdText: artifact, namedPdf: artifact, anonymousPdf: null, deck: null },
    };
    const calibration = {
      stage: "calibration",
      roleId: role.id,
      expectedRoleRevision: role.revision,
      documentsApprovalEffectId: "documents-approval",
      profiles: Array.from({ length: 10 }, (_, i) => ({
        candidateKey: `candidate-${i}`,
        source: {
          effectId: "source-effect",
          rowIndex: i,
          roleRevisionId: "role-revision",
          providerTaskId: "provider-task",
          artifactRef: artifact,
        },
        linkedinUrl: `https://www.linkedin.com/in/example-${i}`,
        evidenceUrl: `https://example.com/evidence/${i}`,
      })),
      ruleChanges: ["Keep the supplied qualification unchanged."],
    };
    const schema = contracts.RecruitingApprovalToolInputSchema;
    expect(schema.parse(documents)).toEqual(documents);
    expect(schema.parse(calibration)).toEqual(calibration);
    const historical = {
      ...calibration,
      profiles: calibration.profiles.map(({ source: _source, ...profile }) => ({
        ...profile,
        assessmentVersion: 1,
      })),
    };
    expect(schema.safeParse(historical).success).toBe(false);
    expect(contracts.RetainedRecruitingApprovalRequestSchema.parse(historical)).toEqual(historical);
    expect(
      JSON.stringify(contracts.RecruitingApprovalToolInputSchema.toJSONSchema()),
    ).not.toContain("assessmentVersion");
    for (const field of [
      "effectId",
      "rowIndex",
      "roleRevisionId",
      "providerTaskId",
      "artifactRef",
    ]) {
      const source = { ...calibration.profiles[0]!.source };
      delete source[field as keyof typeof source];
      expect(
        schema.safeParse({
          ...calibration,
          profiles: [{ ...calibration.profiles[0], source }, ...calibration.profiles.slice(1)],
        }).success,
      ).toBe(false);
    }
    for (const input of [documents, calibration]) {
      for (const field of ["approvedByUserId", "approvedAt", "status", "spaceId", "runId"])
        expect(schema.safeParse({ ...input, [field]: "forged" }).success).toBe(false);
      expect(schema.safeParse({ ...input, expectedRoleRevision: 0 }).success).toBe(false);
    }
    expect(schema.safeParse({ ...documents, documents: { jdText: artifact } }).success).toBe(false);
    for (const profiles of [
      calibration.profiles.slice(1),
      [...calibration.profiles, calibration.profiles[0]],
    ])
      expect(schema.safeParse({ ...calibration, profiles }).success).toBe(false);
  });

  it("closes native ordinary Ask answer provenance to the exact card, block and human message", () => {
    const payload = {
      messageId: "ask-card",
      askIndex: 1,
      answerMessageId: "human-answer",
      answeredByUserId: "owner",
    };
    expect(contracts.NativeAskAnswerPayloadSchema.safeParse(payload).success).toBe(true);
    for (const invalid of [
      { ...payload, askIndex: -1 },
      { ...payload, askIndex: 0.5 },
      { ...payload, answerMessageId: "" },
      { ...payload, sourceMessageId: "forged" },
      {
        messageId: payload.messageId,
        answerMessageId: payload.answerMessageId,
        answeredByUserId: payload.answeredByUserId,
      },
    ])
      expect(contracts.NativeAskAnswerPayloadSchema.safeParse(invalid).success).toBe(false);
    const envelope = {
      id: "answer-event",
      spaceId: "space",
      threadId: "thread",
      botId: "bot",
      runId: "run",
      type: "thread.choice",
      seq: 1,
      createdAt: now,
      payload,
    };
    expect(contracts.ProductEventSchema.safeParse(envelope).success).toBe(true);
    expect(
      contracts.ProductEventSchema.safeParse({
        ...envelope,
        payload: { ...payload, text: "Untrusted narration" },
      }).success,
    ).toBe(false);
  });

  it("requires exact candidate revisions for explicit role-local decisions", () => {
    for (const operation of ["hold", "pass", "resume"]) {
      const input = {
        target: "candidate",
        operation,
        roleId: "role",
        expectedRoleRevision: 1,
        summary: "An explicit human decision",
        intent: { basis: "direct", quote: "Hold Avery" },
        sourceRefs: [],
        candidateKeys: ["avery", "blair"],
        candidateRevisions: [
          { candidateKey: "avery", expectedRevision: 0 },
          { candidateKey: "blair", expectedRevision: 2 },
        ],
      };
      expect(contracts.RecruitingFeedbackInputSchema.safeParse(input).success).toBe(true);
      expect(
        contracts.RecruitingFeedbackInputSchema.safeParse({
          ...input,
          candidateRevisions: undefined,
        }).success,
      ).toBe(false);
      expect(
        contracts.RecruitingFeedbackInputSchema.safeParse({
          ...input,
          candidateRevisions: [input.candidateRevisions[0]],
        }).success,
      ).toBe(false);
      expect(
        contracts.RecruitingFeedbackInputSchema.safeParse({
          ...input,
          candidateRevisions: [input.candidateRevisions[0], input.candidateRevisions[0]],
        }).success,
      ).toBe(false);
    }
  });

  it("accepts closed semantic feedback inputs without model-selected runtime identity", () => {
    const intent = { basis: "direct", quote: "Always show the complete prompt" };
    const preference = {
      target: "preference",
      scope: "user",
      path: "preferences.md",
      expectedRevision: 0,
      intent,
      sourceRefs: [],
    };
    const scoped = {
      roleId: role.id,
      expectedRoleRevision: 1,
      summary: "This round only",
      intent,
      sourceRefs: [source],
    };
    const inputs = [
      { ...preference, operation: "add", content: "  Show the complete prompt.\n" },
      {
        ...preference,
        operation: "replace",
        anchor: { start: 0, end: 3, quote: "old" },
        content: "new",
      },
      { ...preference, operation: "revoke", anchor: { start: 0, end: 3, quote: "old" } },
      { ...preference, operation: "revoke", anchor: { quote: "  old\r\n" } },
      { ...preference, operation: "replace", anchor: { quote: "old" }, content: "new" },
      { ...scoped, target: "role", operation: "revise" },
      { ...scoped, target: "round", operation: "scope" },
      {
        ...scoped,
        target: "candidate",
        operation: "review",
        candidateKeys: ["candidate-1", "candidate-2", "candidate-3"],
      },
    ];
    expect(contracts.RecruitingHumanIntentSchema?.safeParse(intent).success).toBe(true);
    for (const input of inputs) {
      expect(contracts.RecruitingFeedbackInputSchema?.safeParse(input).success).toBe(true);
      for (const field of ["actor", "spaceId", "userId", "runId", "threadId", "sourceMessageId"]) {
        expect(
          contracts.RecruitingFeedbackInputSchema?.safeParse({ ...input, [field]: "forged" })
            .success,
        ).toBe(false);
      }
    }
    expect(contracts.RecruitingPreferenceFeedbackSchema?.parse(inputs[0])).toMatchObject({
      content: "  Show the complete prompt.\n",
    });
  });

  it("requires operation-specific preference targets and valid exact spans", () => {
    const value = {
      target: "preference",
      operation: "replace",
      scope: "bot",
      path: "memory.md",
      expectedRevision: 2,
      intent: { basis: "direct", quote: "Replace this preference" },
      sourceRefs: [],
      anchor: { start: 1, end: 4, quote: "old" },
      content: "new",
    };
    for (const invalid of [
      { scope: "shared" },
      { path: " " },
      { expectedRevision: -1 },
      { expectedRevision: 1.5 },
      { intent: { basis: "assistant", quote: "replace" } },
      { intent: { basis: "direct", quote: " " } },
      { sourceRefs: undefined },
      { content: " " },
      { anchor: undefined },
      { anchor: { quote: "" } },
      { anchor: { start: 1, quote: "old" } },
      { anchor: { end: 4, quote: "old" } },
      { anchor: { start: undefined, end: undefined, quote: "old" } },
      { anchor: { start: -1, end: 4, quote: "old" } },
      { anchor: { start: 1, end: 1, quote: "old" } },
      { anchor: { start: 1, end: 4.5, quote: "old" } },
      { anchor: { start: 1, end: 4, quote: "" } },
      { operation: "add" },
      { operation: "revoke" },
      { target: "role" },
    ])
      expect(
        contracts.RecruitingPreferenceFeedbackSchema?.safeParse({ ...value, ...invalid }).success,
      ).toBe(false);
    expect(
      contracts.RecruitingPreferenceFeedbackSchema?.safeParse({
        ...value,
        intent: { basis: "inferred", quote: "Maybe this" },
      }).success,
    ).toBe(true);
  });

  it("accepts only the fields for each native role operation", () => {
    const intent = { basis: "direct", quote: "Create a new role" };
    const value = {
      operation: "create",
      title: role.title,
      ...definition,
      sourceRefs: [],
      criteria: [{ ...criterion, sourceRefs: [] }],
      intent,
    };
    for (const input of [
      value,
      { ...value, operation: "revise", roleId: role.id, expectedRevision: 1 },
      { operation: "read" },
      { operation: "bind", roleId: role.id, intent },
      { operation: "bind", roleId: null, intent: { ...intent, basis: "inferred" } },
    ]) {
      expect(contracts.RecruitingRoleToolInputSchema?.safeParse(input).success).toBe(true);
    }
    for (const field of [
      "actor",
      "ownerId",
      "spaceId",
      "userId",
      "runId",
      "sourceMessageId",
      "sourceThreadId",
      "threadId",
    ]) {
      expect(
        contracts.RecruitingRoleToolInputSchema.safeParse({ ...value, [field]: "forged" }).success,
      ).toBe(false);
    }
    for (const input of [
      { ...value, expectedRevision: 0 },
      { ...value, expectedRevision: 1 },
      { ...value, operation: "revise" },
      { ...value, intent: { basis: "direct", quote: " " } },
      { ...value, intent: { basis: "assistant", quote: "Create" } },
      { operation: "read", roleId: role.id },
      { operation: "bind", roleId: role.id },
      { operation: "bind", roleId: role.id, intent, threadId: role.sourceThreadId },
    ]) {
      expect(contracts.RecruitingRoleToolInputSchema.safeParse(input).success).toBe(false);
    }
    const apiCreate = {
      ...definition,
      sourceThreadId: role.sourceThreadId,
      title: role.title,
      expectedRevision: 0,
    };
    expect(contracts.CreateRecruitingRoleInput.safeParse(apiCreate).success).toBe(true);
    expect(
      contracts.CreateRecruitingRoleInput.safeParse({ ...apiCreate, expectedRevision: 1 }).success,
    ).toBe(false);
    const quote = "Create this role\n  Preserve the qualification wording.";
    expect(contracts.RecruitingHumanIntentSchema.parse({ ...intent, quote }).quote).toBe(quote);
  });

  it("validates a role and its exact current revision", () => {
    expect(contracts.RecruitingRoleSchema?.safeParse(role).success).toBe(true);
    for (const invalid of [
      { revision: 0 },
      { revision: 1.5 },
      { currentRevisionId: "" },
      { id: " " },
    ]) {
      expect(contracts.RecruitingRoleSchema.safeParse({ ...role, ...invalid }).success).toBe(false);
    }
  });

  it("pins artifacts to native version rows and valid hashes", () => {
    expect(contracts.RecruitingArtifactRefSchema.parse(artifact)).toEqual(artifact);
    for (const invalid of [
      { artifactId: "", sha256: artifact.sha256 },
      { artifactId: artifact.artifactId, sha256: "not-a-hash" },
      { name: "example.txt", version: "latest" },
    ]) {
      expect(contracts.RecruitingArtifactRefSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("anchors sources to messages or artifact versions and records read provenance", () => {
    expect(contracts.RecruitingSourceRefSchema.parse(source)).toEqual(source);
    const messageSource = {
      ...source,
      kind: "candidate_statement",
      anchor: { kind: "message", messageId: "message-sample", locator: "block 1, sentence 1" },
    };
    expect(contracts.RecruitingSourceRefSchema.safeParse(messageSource).success).toBe(true);
    expect(
      contracts.RecruitingSourceRefSchema.safeParse({ ...source, kind: "recruiter_verified" })
        .success,
    ).toBe(true);
    for (const invalid of [
      { ...source, kind: "model_explanation" },
      { ...source, readAt: null },
      { ...source, anchor: { kind: "url", url: "https://example.test/material" } },
      { ...source, anchor: { ...source.anchor, locator: " " } },
    ]) {
      expect(contracts.RecruitingSourceRefSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts HTTP(S) document fragments and rejects non-web source URL schemes", () => {
    for (const url of [
      "https://example.test/material#experience",
      "http://example.test/material",
    ]) {
      expect(contracts.RecruitingSourceRefSchema.safeParse({ ...source, url }).success).toBe(true);
    }
    for (const url of [
      "javascript:alert(1)",
      "data:text/plain,example",
      "file:///example.txt",
      "mailto:example@example.test",
    ]) {
      expect(contracts.RecruitingSourceRefSchema.safeParse({ ...source, url }).success).toBe(false);
    }
  });

  it("rejects unread quotes while preserving independently recorded source provenance", () => {
    const { quote: _quote, ...withoutQuote } = source;
    const unread = {
      ...withoutQuote,
      kind: "provider_report",
      readState: "unread",
      readAt: null,
      url: "https://example.test/material",
    };
    expect(contracts.RecruitingSourceRefSchema.safeParse(unread).success).toBe(true);
    expect(
      contracts.RecruitingSourceRefSchema.safeParse({ ...unread, quote: "Invented quote" }).success,
    ).toBe(false);
    for (const kind of ["original_material", "candidate_statement", "recruiter_verified"]) {
      expect(contracts.RecruitingSourceRefSchema.safeParse({ ...unread, kind }).success).toBe(true);
    }
    expect(
      contracts.RecruitingSourceRefSchema.safeParse({
        ...unread,
        readState: "unavailable",
        readAt: now,
      }).success,
    ).toBe(true);
    expect(
      contracts.RecruitingSourceRefSchema.safeParse({
        ...withoutQuote,
        readState: "unavailable",
        readAt: now,
      }).success,
    ).toBe(true);
  });

  it("limits priorities to hard/preferred and supports unresolved definitions", () => {
    expect(contracts.RecruitingCriterionSchema.parse(criterion)).toEqual(criterion);
    expect(
      contracts.RecruitingCriterionSchema.safeParse({
        ...criterion,
        priority: "preferred",
        definitionQuestions: ["Which component responsibilities count?"],
      }).success,
    ).toBe(true);
    for (const priority of ["recall", "required", "nice_to_have"]) {
      expect(
        contracts.RecruitingCriterionSchema.safeParse({ ...criterion, priority }).success,
      ).toBe(false);
    }
    expect(
      contracts.RecruitingCriterionSchema.safeParse({ ...criterion, recallScope: "local" }).success,
    ).toBe(false);
  });

  it("allows only nonempty atom/all/any/not logic", () => {
    const atom = criterion.expression;
    const nested = {
      kind: "all",
      items: [atom, { kind: "any", items: [{ kind: "not", item: atom }] }],
    };
    expect(contracts.RecruitingCriterionExpressionSchema.safeParse(nested).success).toBe(true);
    for (const expression of [
      { kind: "all", items: [] },
      { kind: "any", items: [] },
      { kind: "not", items: [atom] },
      { kind: "atom", id: "", statement: "Example" },
      { kind: "script", code: "return true" },
    ]) {
      expect(contracts.RecruitingCriterionExpressionSchema.safeParse(expression).success).toBe(
        false,
      );
    }
  });

  it("keeps role revision snapshots immutable and criterion IDs unique", () => {
    const revision = {
      id: role.currentRevisionId,
      roleId: role.id,
      revision: 1,
      ...definition,
      createdAt: now,
    };
    const parsed = contracts.RecruitingRoleRevisionSchema.parse(revision);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.criteria)).toBe(true);
    expect(Object.isFrozen(parsed.criteria[0])).toBe(true);
    expect(
      contracts.RecruitingRoleRevisionSchema.safeParse({
        ...revision,
        criteria: [criterion, criterion],
      }).success,
    ).toBe(false);
    expect(
      contracts.RecruitingRoleRevisionSchema.safeParse({ ...revision, recallScope: "local" })
        .success,
    ).toBe(false);
  });

  it("rejects atom IDs reused for different requirements in one role revision", () => {
    const otherCriterion = {
      ...criterion,
      id: "criterion-other",
      expression: { ...criterion.expression, statement: "A different requirement" },
    };
    expect(
      contracts.RecruitingRoleRevisionSchema.safeParse({
        id: role.currentRevisionId,
        roleId: role.id,
        revision: 1,
        ...definition,
        criteria: [criterion, otherCriterion],
        createdAt: now,
      }).success,
    ).toBe(false);
  });

  it("requires repeated atom IDs to keep the complete employment rule across every role entry point", () => {
    const employmentRule = {
      minimumMonths: 17,
      countingRule: "complete_calendar_months",
      qualificationDefinition: "Full-time personally implemented work",
      cutoff: { kind: "assessment_date" },
    };
    const first = { ...criterion, expression: { ...criterion.expression, employmentRule } };
    const duplicate = { ...first, id: "criterion-other" };
    const value = { ...definition, criteria: [first, duplicate] };
    const inputs = [
      {
        schema: contracts.RecruitingRoleRevisionSchema,
        value: {
          ...value,
          id: role.currentRevisionId,
          roleId: role.id,
          revision: 1,
          createdAt: now,
        },
      },
      {
        schema: contracts.CreateRecruitingRoleInput,
        value: {
          ...value,
          sourceThreadId: role.sourceThreadId,
          title: role.title,
          expectedRevision: 0,
        },
      },
      {
        schema: contracts.ReviseRecruitingRoleInput,
        value: { ...value, roleId: role.id, title: role.title, expectedRevision: 1 },
      },
      {
        schema: contracts.RecruitingRoleToolInputSchema,
        value: {
          ...value,
          operation: "create",
          title: role.title,
          intent: { basis: "direct", quote: "Create this role" },
        },
      },
      {
        schema: contracts.RecruitingRoleToolInputSchema,
        value: {
          ...value,
          operation: "revise",
          roleId: role.id,
          title: role.title,
          expectedRevision: 1,
          intent: { basis: "direct", quote: "Revise this role" },
        },
      },
    ];
    for (const { schema, value: input } of inputs) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(
        schema.safeParse({ ...input, criteria: [criterion, { ...criterion, id: duplicate.id }] })
          .success,
      ).toBe(true);
      for (const rule of [
        undefined,
        { ...employmentRule, minimumMonths: 18 },
        { ...employmentRule, qualificationDefinition: "A different work definition" },
        {
          ...employmentRule,
          cutoff: { kind: "fixed", date: { precision: "day", year: 2024, month: 12, day: 31 } },
        },
      ])
        expect(
          schema.safeParse({
            ...input,
            criteria: [
              first,
              { ...duplicate, expression: { ...duplicate.expression, employmentRule: rule } },
            ],
          }).success,
        ).toBe(false);
    }
  });

  it("keeps unknown task creation distinct from a known provider task ID", () => {
    const task = {
      id: action.taskId,
      roleId: role.id,
      mcpServerId: "server-sample",
      serverRevision: 1,
      providerTaskId: null,
      pendingActionId: action.id,
      state: "unknown",
      createdByRunId: action.runId,
    };
    expect(contracts.RecruitingResearchTaskSchema.parse(task)).toEqual(task);
    expect(
      contracts.RecruitingResearchTaskSchema.safeParse({ ...task, providerTaskId: "" }).success,
    ).toBe(false);
    expect(
      contracts.RecruitingResearchTaskSchema.safeParse({ ...task, serverRevision: 0 }).success,
    ).toBe(false);
  });

  it("maps one action to frozen request/context/receipt/output versions and scoped usage", () => {
    expect(contracts.RecruitingResearchActionSchema.parse(action)).toEqual(action);
    for (const deliveryState of [
      "prepared",
      "sending",
      "accepted",
      "rejected",
      "unknown",
      "superseded",
    ]) {
      expect(
        contracts.RecruitingResearchActionSchema.safeParse({
          ...action,
          kind: "continue",
          deliveryState,
          observedProviderState: "provider-specific-status",
          receiptArtifact: artifact,
          outputArtifacts: [artifact],
          usage: [{ scope: "batch", unit: "credits", amount: 0.5 }],
        }).success,
      ).toBe(true);
    }
    for (const invalid of [
      { kind: "reply" },
      { deliveryState: "queued" },
      { requestArtifact: { name: "request.txt" } },
      { usage: [{ scope: "invalid", unit: "credits", amount: 2 }] },
    ]) {
      expect(
        contracts.RecruitingResearchActionSchema.safeParse({ ...action, ...invalid }).success,
      ).toBe(false);
    }
  });

  it("preserves provider metrics and their attribution scope without inventing per-person costs", () => {
    for (const scope of ["task", "batch", "person"]) {
      const usage = [{ scope, unit: "credits", amount: 0.5 }];
      expect(
        contracts.RecruitingResearchActionSchema.parse({
          ...action,
          receiptArtifact: artifact,
          usage,
        }).usage,
      ).toEqual(usage);
    }
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        contracts.RecruitingResearchActionSchema.safeParse({
          ...action,
          receiptArtifact: artifact,
          usage: [{ scope: "task", unit: "credits", amount }],
        }).success,
      ).toBe(false);
    }
    expect(
      contracts.RecruitingResearchActionSchema.safeParse({
        ...action,
        receiptArtifact: artifact,
        usage: [{ scope: "task", unit: " ", amount: 0.5 }],
      }).success,
    ).toBe(false);
    expect(contracts.RecruitingResearchActionSchema.parse(action).usage).toBeNull();
  });

  it("requires a frozen receipt reference for reported usage", () => {
    expect(
      contracts.RecruitingResearchActionSchema.safeParse({
        ...action,
        usage: [{ scope: "task", unit: "credits", amount: 0.5 }],
      }).success,
    ).toBe(false);
  });

  it("stores immutable assessment snapshots with explicit fact and source dependencies", () => {
    const parsed = contracts.RecruitingAssessmentSchema.parse(assessment);
    expect(parsed).toEqual(assessment);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.judgments)).toBe(true);
    expect(Object.isFrozen(parsed.judgments.criteria[0])).toBe(true);
    expect(
      contracts.RecruitingAssessmentSchema.safeParse({
        ...assessment,
        version: 2,
        basedOnVersion: 1,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { version: 0 },
      { version: 2, basedOnVersion: 2 },
      { version: 2, basedOnVersion: null },
      { facts: [assessment.facts[0], assessment.facts[0]] },
      {
        judgments: {
          ...assessment.judgments,
          criteria: [{ ...assessment.judgments.criteria[0], factIds: ["missing-fact"] }],
        },
      },
      {
        judgments: {
          ...assessment.judgments,
          criteria: [{ ...assessment.judgments.criteria[0], evidence: ["missing-source"] }],
        },
      },
      { sourceRefs: [{ ...source, readState: "unread", readAt: null }] },
    ]) {
      expect(
        contracts.RecruitingAssessmentSchema.safeParse({ ...assessment, ...invalid }).success,
      ).toBe(false);
    }
  });

  it("does not accept a provider qualification as an assessment verdict", () => {
    expect(
      contracts.RecruitingAssessmentSchema.safeParse({
        ...assessment,
        judgments: {
          ...assessment.judgments,
          criteria: [{ ...assessment.judgments.criteria[0], verdict: "qualified" }],
        },
      }).success,
    ).toBe(false);
  });

  it("keeps unread provider links as gaps rather than quoted evidence", () => {
    const { quote: _quote, ...withoutQuote } = source;
    const gap = {
      ...assessment,
      sourceRefs: [{ ...withoutQuote, kind: "provider_report", readState: "unread", readAt: null }],
      judgments: {
        atoms: [],
        employment: [],
        hardGate: "unknown",
        criteria: [
          {
            ...assessment.judgments.criteria[0],
            verdict: "unknown",
            evidence: [],
            missing: ["Read the original material"],
          },
        ],
      },
    };
    expect(contracts.RecruitingAssessmentSchema.safeParse(gap).success).toBe(true);
    expect(
      contracts.RecruitingAssessmentSchema.safeParse({
        ...gap,
        judgments: {
          ...gap.judgments,
          criteria: [{ ...gap.judgments.criteria[0], evidence: [source.id] }],
        },
      }).success,
    ).toBe(false);
  });

  it("requires revision targets and rejects caller-selected ownership/runtime identities", () => {
    const inputs = [
      {
        schema: contracts.CreateRecruitingRoleInput,
        value: {
          sourceThreadId: role.sourceThreadId,
          expectedRevision: 0,
          title: role.title,
          ...definition,
        },
      },
      {
        schema: contracts.ReviseRecruitingRoleInput,
        value: { roleId: role.id, expectedRevision: 1, title: role.title, ...definition },
      },
      {
        schema: contracts.PrepareRecruitingResearchActionInput,
        value: {
          taskId: action.taskId,
          expectedRevision: 1,
          roleRevisionId: role.currentRevisionId,
          clientNonce: action.clientNonce,
          kind: action.kind,
          purpose: "calibration",
          approvalEffectId: "documents-approval",
          requestArtifact: artifact,
          contextArtifact: artifact,
          recallScope: action.recallScope,
        },
      },
      {
        schema: contracts.SaveRecruitingAssessmentInput,
        value: {
          roleId: role.id,
          candidateKey: assessment.candidateKey,
          expectedRevision: 0,
          roleRevisionId: role.currentRevisionId,
          facts: assessment.facts,
          atomJudgments: assessment.judgments.atoms,
          employmentEvaluations: [],
          questions: assessment.questions,
          sourceRefs: assessment.sourceRefs,
        },
      },
    ];
    for (const { schema, value } of inputs) {
      expect(schema.safeParse(value).success).toBe(true);
      const { expectedRevision: _expectedRevision, ...withoutRevision } = value;
      expect(schema.safeParse(withoutRevision).success).toBe(false);
      for (const key of [
        "actor",
        "ownerId",
        "spaceId",
        "userId",
        "runId",
        "createdByRunId",
        "sourceMessageId",
      ]) {
        expect(schema.safeParse({ ...value, [key]: "forged-identity" }).success).toBe(false);
      }
    }
  });

  it("adds closed native event payloads containing references rather than private content", () => {
    const envelope = {
      id: "event-sample",
      spaceId: role.spaceId,
      threadId: role.sourceThreadId,
      botId: "bot-sample",
      seq: 1,
      runId: action.runId,
      createdAt: now,
    };
    const context = {
      ...envelope,
      type: "recruiting.context.adopted",
      payload: {
        roleId: role.id,
        roleRevisionId: role.currentRevisionId,
        contextArtifact: artifact,
      },
    };
    const transition = {
      ...envelope,
      type: "recruiting.action.transitioned",
      payload: { taskId: action.taskId, actionId: action.id, from: "sending", to: "unknown" },
    };
    const readBound = {
      ...envelope,
      type: "recruiting.read",
      payload: {
        phase: "bound",
        taskId: action.taskId,
        actionId: action.id,
        effectId: "effect-read",
        toolName: "get_rows",
      },
    };
    const readRecorded = {
      ...envelope,
      type: "recruiting.read",
      payload: {
        phase: "recorded",
        taskId: action.taskId,
        actionId: action.id,
        effectId: "effect-read",
        outputArtifact: artifact,
      },
    };
    for (const event of [context, transition, readBound, readRecorded]) {
      expect(contracts.ProductEventSchema.safeParse(event).success).toBe(true);
      expect(
        contracts.ProductEventSchema.safeParse({
          ...event,
          payload: { ...event.payload, privateText: "raw content" },
        }).success,
      ).toBe(false);
      expect(contracts.ProductEventSchema.safeParse({ ...event, payload: {} }).success).toBe(false);
    }
    for (const payload of [
      { ...readBound.payload, toolName: "research" },
      { ...readBound.payload, effectId: " " },
      { ...readRecorded.payload, outputArtifact: { ...artifact, sha256: "invalid" } },
      { ...readRecorded.payload, toolName: "get_rows" },
    ]) {
      expect(contracts.ProductEventSchema.safeParse({ ...readBound, payload }).success).toBe(false);
    }
    expect(
      contracts.ProductEventSchema.safeParse({
        ...context,
        payload: { ...context.payload, roleRevisionId: " " },
      }).success,
    ).toBe(false);
    expect(
      contracts.ProductEventSchema.safeParse({
        ...transition,
        payload: { ...transition.payload, to: "queued" },
      }).success,
    ).toBe(false);
    expect(
      contracts.ProductEventSchema.safeParse({
        ...envelope,
        type: "thread.meta",
        payload: { text: "existing event" },
      }).success,
    ).toBe(true);
  });
});

describe("typed recruiting assessment evidence", () => {
  const save = {
    roleId: role.id,
    candidateKey: assessment.candidateKey,
    expectedRevision: 0,
    roleRevisionId: role.currentRevisionId,
    facts: assessment.facts,
    atomJudgments: assessment.judgments.atoms,
    employmentEvaluations: [],
    questions: [],
    sourceRefs: assessment.sourceRefs,
  };

  it("accepts only agent atom inputs and rejects supplied aggregate results", () => {
    expect(contracts.SaveRecruitingAssessmentInput.safeParse(save).success).toBe(true);
    expect(
      contracts.RecruitingAssessmentToolInputSchema?.parse({ operation: "save", ...save }),
    ).toEqual({ operation: "save", ...save });
    expect(
      contracts.RecruitingAssessmentToolInputSchema?.parse({
        operation: "read",
        candidateKey: "candidate",
      }),
    ).toEqual({ operation: "read", candidateKey: "candidate" });
    expect(
      contracts.RecruitingAssessmentToolInputSchema?.safeParse({
        operation: "read",
        candidateKey: "candidate",
        roleId: role.id,
      }).success,
    ).toBe(false);
    for (const aggregate of [
      { judgments: assessment.judgments },
      { hardGate: "met" },
      { criteria: [] },
    ])
      expect(
        contracts.SaveRecruitingAssessmentInput.safeParse({ ...save, ...aggregate }).success,
      ).toBe(false);
  });

  it("preserves exact quote bytes and requires an anchor-compatible typed selection", () => {
    const quote = "  Built it.\r\n";
    const exact = {
      ...save.sourceRefs[0],
      quote,
      selection: { kind: "artifact_text", start: 2, end: 2 + quote.length },
    };
    expect(contracts.RecruitingAssessmentSourceRefSchema?.parse(exact).quote).toBe(quote);
    for (const selection of [
      undefined,
      { kind: "artifact_text", start: 2, end: 2 },
      { kind: "artifact_text", start: -1, end: 5 },
      { kind: "message_text", blockIndex: 0, start: 0, end: quote.length },
      { kind: "artifact_json_string", path: ["rows", -1], start: 0, end: quote.length },
    ])
      expect(
        contracts.RecruitingAssessmentSourceRefSchema?.safeParse({ ...exact, selection }).success,
      ).toBe(false);
    expect(
      contracts.RecruitingAssessmentSourceRefSchema?.safeParse({
        ...exact,
        anchor: { kind: "message", messageId: "message", locator: "block 1" },
        selection: { kind: "message_text", blockIndex: 1, start: 0, end: quote.length },
      }).success,
    ).toBe(true);
    expect(
      contracts.RecruitingAssessmentSourceRefSchema?.safeParse({
        ...exact,
        selection: {
          kind: "artifact_json_string",
          path: ["rows", 0, "body"],
          start: 0,
          end: quote.length,
        },
      }).success,
    ).toBe(true);
    for (const readState of ["unread", "unavailable"]) {
      const gap = { ...source, readState, readAt: readState === "unread" ? null : now };
      expect(contracts.RecruitingAssessmentSourceRefSchema?.safeParse(gap).success).toBe(false);
      const { quote: _quote, ...unquoted } = gap;
      expect(contracts.RecruitingAssessmentSourceRefSchema?.safeParse(unquoted).success).toBe(true);
      expect(
        contracts.RecruitingAssessmentSourceRefSchema?.safeParse({
          ...unquoted,
          selection: exact.selection,
        }).success,
      ).toBe(false);
    }
  });

  it("requires typed facts and valid precision-aware dates without inventing month or day", () => {
    const common = { id: "job", statement: "Worked on the component", sourceRefIds: [source.id] };
    const employment = {
      ...common,
      kind: "employment",
      start: { precision: "year", year: 2020 },
      end: "present",
      employmentType: "full-time",
    };
    expect(contracts.RecruitingFactSchema.parse(employment)).toEqual(employment);
    expect(
      contracts.RecruitingFactSchema.safeParse({ ...employment, start: null, end: null }).success,
    ).toBe(true);
    expect(contracts.RecruitingFactSchema.safeParse(common).success).toBe(false);
    expect(
      contracts.RecruitingFactSchema.safeParse({
        ...employment,
        start: { precision: "year", year: 2020, month: 1 },
      }).success,
    ).toBe(false);
    for (const date of [
      { precision: "day", year: 2023, month: 2, day: 29 },
      { precision: "month", year: 2024, month: 13 },
      { precision: "year", year: 0 },
    ])
      expect(contracts.RecruitingFactSchema.safeParse({ ...employment, start: date }).success).toBe(
        false,
      );
    const completeness = {
      ...common,
      kind: "history_completeness",
      complete: true,
      asOf: { precision: "day", year: 2024, month: 2, day: 29 },
    };
    expect(contracts.RecruitingFactSchema.safeParse(completeness).success).toBe(true);
    expect(
      contracts.RecruitingFactSchema.safeParse({
        ...completeness,
        asOf: { precision: "month", year: 2024, month: 2 },
      }).success,
    ).toBe(false);
  });

  it("allows an explicit numeric policy only on its exact role atom and keeps plain atoms valid", () => {
    const employmentRule = {
      minimumMonths: 17,
      countingRule: "complete_calendar_months",
      qualificationDefinition: "Full-time relevant work",
      cutoff: { kind: "fixed", date: { precision: "day", year: 2024, month: 2, day: 29 } },
    };
    const expression = { ...criterion.expression, employmentRule };
    expect(contracts.RecruitingCriterionExpressionSchema.parse(expression)).toEqual(expression);
    expect(contracts.RecruitingCriterionExpressionSchema.parse(criterion.expression)).toEqual(
      criterion.expression,
    );
    for (const invalid of [
      { minimumMonths: undefined },
      { minimumMonths: 1.5 },
      { countingRule: undefined },
      { cutoff: { kind: "fixed", date: { precision: "month", year: 2024, month: 2 } } },
    ])
      expect(
        contracts.RecruitingCriterionExpressionSchema.safeParse({
          ...expression,
          employmentRule: { ...employmentRule, ...invalid },
        }).success,
      ).toBe(false);
  });
});

describe("recruiting reassessment and native Ask inputs", () => {
  const reassess = {
    roleId: role.id,
    roleRevisionId: role.currentRevisionId,
    candidateKey: assessment.candidateKey,
    expectedRevision: 1,
    facts: assessment.facts,
    sourceRefs: assessment.sourceRefs,
    questions: [],
    atomJudgments: [],
    employmentEvaluations: [],
  };
  const ask = {
    operation: "ask",
    roleId: role.id,
    roleRevisionId: role.currentRevisionId,
    target: {
      kind: "candidate",
      candidateKey: assessment.candidateKey,
      assessmentVersion: 1,
      criterionIds: [criterion.id],
    },
    question: "  Which work did you personally implement?\n",
    options: ["  Implemented it myself", "Used a library  "],
  };

  it("closes reassessment to a positive prior version and partial agent override sets", () => {
    expect(contracts.ReassessRecruitingAssessmentInput?.parse(reassess)).toEqual(reassess);
    expect(
      contracts.RecruitingAssessmentToolInputSchema.safeParse({
        operation: "reassess",
        ...reassess,
      }).success,
    ).toBe(true);
    for (const change of [
      { expectedRevision: 0 },
      { expectedRevision: 1.5 },
      { atomJudgments: undefined },
      { judgments: assessment.judgments },
      { hardGate: "met" },
      { changedFactIds: ["fact-sample"] },
      { createdByRunId: "forged" },
    ])
      expect(
        contracts.RecruitingAssessmentToolInputSchema.safeParse({
          operation: "reassess",
          ...reassess,
          ...change,
        }).success,
      ).toBe(false);
  });

  it("preserves exact native question and option text for role and candidate targets", () => {
    expect(contracts.RecruitingAssessmentAskInputSchema?.parse(ask)).toEqual(ask);
    expect(contracts.RecruitingAssessmentToolInputSchema.parse(ask)).toEqual(ask);
    const target = { kind: "role", criterionIds: [] };
    expect(contracts.RecruitingAssessmentAskTargetSchema?.parse(target)).toEqual(target);
    expect(
      contracts.RecruitingAssessmentToolInputSchema.safeParse({ ...ask, target }).success,
    ).toBe(true);
    expect(
      contracts.RecruitingAssessmentToolInputSchema.safeParse({
        ...ask,
        options: ["a", "b", "c", "d"],
        question: "q".repeat(240),
      }).success,
    ).toBe(true);
  });

  it("rejects ambiguous, oversized and caller-authored native card/runtime fields", () => {
    for (const change of [
      { question: "" },
      { question: "  " },
      { question: "q".repeat(241) },
      { options: ["one"] },
      { options: ["a", "b", "c", "d", "e"] },
      { options: ["same", "same"] },
      { options: ["", "valid"] },
      { options: ["  ", "valid"] },
      { options: ["x".repeat(81), "valid"] },
      { target: { ...ask.target, assessmentVersion: 0 } },
      { target: { ...ask.target, criterionIds: [""] } },
      { target: { kind: "role", criterionIds: [], candidateKey: "extra" } },
      { target: { ...ask.target, atomIds: ["atom-sample"] } },
      { messageId: "forged" },
      { sourceThreadId: "forged" },
      { botId: "forged" },
      { blockIndex: 0 },
    ])
      expect(
        contracts.RecruitingAssessmentToolInputSchema.safeParse({ ...ask, ...change }).success,
      ).toBe(false);
  });
});

describe("candidate index contracts", () => {
  it("defines one complete canonical candidate display schema", () => {
    expect(contracts.RecruitingCandidateOutputSchemaId.parse("candidate_output_v1")).toBe(
      "candidate_output_v1",
    );
    const row = {
      name: null,
      linkedin_url: null,
      current_title: null,
      current_company: null,
      location: null,
      resume_url: null,
      evidence_urls: null,
      role_signal: "opaque",
    };
    expect(contracts.RecruitingCandidateOutputRowSchema.parse(row)).toEqual(row);
    expect(contracts.RECRUITING_CANDIDATE_OUTPUT_JSON_SCHEMA.properties).toHaveProperty(
      "linkedin_url",
    );
    expect(contracts.RecruitingCandidateOutputSchemaId.safeParse("inferred_columns").success).toBe(
      false,
    );
    const unknown = {
      name: null,
      title: null,
      company: null,
      location: null,
      linkedinUrl: null,
      resumeUrl: null,
      evidenceUrls: null,
      issues: ["historical_schema_unknown"],
    };
    expect(contracts.RecruitingCandidateProfileSchema.parse(unknown)).toEqual(unknown);
  });
  it.each(["rank", "tier", "score"])("accepts native provider %s candidate ordering", (sort) => {
    expect(contracts.ListRecruitingCandidatesInput.parse({ roleId: "role", sort })).toEqual({
      roleId: "role",
      sort,
    });
  });
  it("validates paginated candidates and independent shortlist intent", () => {
    expect(
      contracts.ListRecruitingCandidatesInput.parse({
        roleId: "role",
        limit: 25,
        assessmentState: "unassessed",
        sourceEffectId: "native-read",
        actionId: "action",
        sort: "name",
      }),
    ).toMatchObject({ limit: 25, sourceEffectId: "native-read", actionId: "action" });
    expect(
      contracts.ListRecruitingCandidatesInput.safeParse({ roleId: "role", sourceEffectId: " " })
        .success,
    ).toBe(false);
    expect(
      contracts.ListRecruitingCandidatesInput.safeParse({ roleId: "role", sort: "raw SQL" })
        .success,
    ).toBe(false);
    expect(
      contracts.ListRecruitingCandidatesInput.safeParse({ roleId: "role", limit: 501 }).success,
    ).toBe(false);
    expect(
      contracts.SetRecruitingCandidateShortlistInput.parse({
        threadId: "thread",
        roleId: "role",
        candidateKey: "key",
        expectedRevision: 0,
        shortlisted: true,
      }),
    ).toMatchObject({ expectedRevision: 0 });
    expect(
      contracts.SetRecruitingCandidateShortlistInput.safeParse({
        threadId: "thread",
        roleId: "role",
        candidateKey: "key",
        expectedRevision: 0,
        shortlisted: true,
        verdict: "met",
      }).success,
    ).toBe(false);
  });
});
it("bounds page sizes and accepts only canonical offset cursors", () => {
  const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
    schema.safeParse(value).success;
  const candidates = contracts.ListRecruitingCandidatesInput;
  expect(ok(candidates, { roleId: "role", limit: 200 })).toBe(true);
  expect(ok(candidates, { roleId: "role", limit: 201 })).toBe(false);
  expect(ok(candidates, { roleId: "role", limit: 0 })).toBe(false);
  const crm = {
    operation: "candidates",
    serverId: "crm",
    serverRevision: 1,
    organizationId: "10000000-0000-4000-8000-000000000001",
  };
  expect(ok(contracts.RecruitingCrmDataInputSchema, { ...crm, limit: 50, cursor: "50" })).toBe(
    true,
  );
  for (const bad of [{ limit: 51 }, { cursor: "01" }, { cursor: "-1" }, { cursor: "1000001" }])
    expect(ok(contracts.RecruitingCrmDataInputSchema, { ...crm, ...bad })).toBe(false);
  const inbox = z.strictObject(contracts.RecruitingCorrespondenceInputPage);
  expect(ok(inbox, { limit: 200, cursor: "0" })).toBe(true);
  for (const bad of [{ limit: 0 }, { limit: 201 }, { cursor: "x" }, { cursor: "" }])
    expect(ok(inbox, bad)).toBe(false);
});

describe("recruiting.roleCandidates contract", () => {
  const input = contracts.appContract.recruiting.roleCandidates["~orpc"].inputSchema!;
  const output = contracts.RecruitingRoleCandidatesOutputSchema;
  it("bounds limit 1–100, needs a thread target, and accepts the four sorts", () => {
    const base = { botId: "bot", threadId: "thread" };
    for (const sort of ["score", "rank", "name", "recent"])
      expect(input["~standard"].validate({ ...base, sort })).not.toHaveProperty("issues");
    for (const bad of [{ ...base, limit: 0 }, { ...base, limit: 101 }, { threadId: "thread" }])
      expect(input["~standard"].validate(bad)).toHaveProperty("issues");
  });
  it("carries crmStatus and open outreach-status counts beside shortlisted/replied", () => {
    const page = {
      items: [
        {
          key: "crm:30000000-0000-4000-8000-000000000003",
          name: "Ada",
          title: null,
          location: null,
          email: "ada@example.test",
          linkedinUrl: null,
          autumn: null,
          crm: {
            serverId: "server",
            organizationId: "10000000-0000-4000-8000-000000000001",
            candidateId: "30000000-0000-4000-8000-000000000003",
            stage: null,
            contactStatus: "contacted",
            outreachStatus: "replied",
          },
          shortlisted: false,
          shortlistedAt: null,
        },
      ],
      nextCursor: null,
      total: 1,
      counts: { shortlisted: 0, replied: 1, bounced: 2 },
      crmStatus: "ok",
    };
    expect(output.parse(page)).toEqual(page);
    expect(() =>
      output.parse({ ...page, items: [{ ...page.items[0], shortlistedAt: "yesterday" }] }),
    ).toThrow();
    expect(() => output.parse({ ...page, crmStatus: "off" })).toThrow();
    expect(() => output.parse({ ...page, counts: { replied: 1 } })).toThrow();
  });
});

describe("recruiting brief drafts", () => {
  const field = {
    key: "location",
    value: "Atlanta",
    origin: "jd",
    state: "known",
    sourceRefIds: [],
  };
  const brief = { searchFilters: [], fields: [field], questions: [], rules: [] };

  it("saves a field that leaves out whether it is consequential", () => {
    expect(contracts.RecruitingBriefDraftSchema.parse(brief).fields[0]!.consequential).toBe(false);
  });

  it("does not require consequential in the tool schema the model fills", () => {
    const schema = z.toJSONSchema(contracts.RecruitingBriefDraftSchema, {
      io: "input",
    }) as unknown as {
      properties: { fields: { items: { required: string[] } } };
    };
    expect(schema.properties.fields.items.required).not.toContain("consequential");
  });

  it("shows one to nine first picks without recording a round", () => {
    const show = (candidateKeys: string[]) =>
      contracts.RecruitingResearchToolInputSchema.safeParse({
        operation: "show_picks",
        candidateKeys,
      }).success;
    expect(show(["linkedin:/in/a"])).toBe(true);
    expect(show([])).toBe(false);
    expect(show(["linkedin:/in/a", "linkedin:/in/a"])).toBe(false);
    expect(show(Array.from({ length: 10 }, (_, index) => `linkedin:/in/p${index}`))).toBe(false);
  });
});

describe("calibration round keys", () => {
  it("names a repeated person so one retry fixes the round", () => {
    const keys = Array.from({ length: 9 }, (_, index) => `linkedin:/in/p${index}`);
    const result = contracts.RecruitingResearchToolInputSchema.safeParse({
      operation: "calibration_round",
      expectedRoleRevision: 1,
      candidateKeys: [...keys, "linkedin:/in/p3"],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Repeated: linkedin:/in/p3");
  });
});
