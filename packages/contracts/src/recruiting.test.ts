import { describe, expect, it } from "vitest";
import * as contracts from "./index.js";

const now = "2026-01-01T00:00:00.000Z";
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
  facts: [{ id: "fact-sample", statement: "Implemented the component", sourceRefIds: [source.id] }],
  judgments: [
    {
      criterionId: "atom-sample",
      verdict: "met",
      factIds: ["fact-sample"],
      evidence: [source.id],
      missing: [],
    },
  ],
  questions: [],
  sourceRefs: [source],
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
  it("accepts only the fields for each native role operation", () => {
    const intent = { basis: "direct", quote: "Create a new role" };
    const value = {
      operation: "create",
      expectedRevision: 0,
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
    expect(Object.isFrozen(parsed.judgments[0])).toBe(true);
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
      { judgments: [{ ...assessment.judgments[0], factIds: ["missing-fact"] }] },
      { judgments: [{ ...assessment.judgments[0], evidence: ["missing-source"] }] },
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
        judgments: [{ ...assessment.judgments[0], verdict: "qualified" }],
      }).success,
    ).toBe(false);
  });

  it("keeps unread provider links as gaps rather than quoted evidence", () => {
    const { quote: _quote, ...withoutQuote } = source;
    const gap = {
      ...assessment,
      sourceRefs: [{ ...withoutQuote, kind: "provider_report", readState: "unread", readAt: null }],
      judgments: [
        {
          ...assessment.judgments[0],
          verdict: "unknown",
          evidence: [],
          missing: ["Read the original material"],
        },
      ],
    };
    expect(contracts.RecruitingAssessmentSchema.safeParse(gap).success).toBe(true);
    expect(
      contracts.RecruitingAssessmentSchema.safeParse({
        ...gap,
        judgments: [{ ...gap.judgments[0], evidence: [source.id] }],
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
          judgments: assessment.judgments,
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
    for (const event of [context, transition]) {
      expect(contracts.ProductEventSchema.safeParse(event).success).toBe(true);
      expect(
        contracts.ProductEventSchema.safeParse({
          ...event,
          payload: { ...event.payload, privateText: "raw content" },
        }).success,
      ).toBe(false);
      expect(contracts.ProductEventSchema.safeParse({ ...event, payload: {} }).success).toBe(false);
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
