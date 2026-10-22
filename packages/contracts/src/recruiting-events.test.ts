import { describe, expect, it } from "vitest";
import { ProductEventSchema } from "./events.js";
import { RECRUITING_CANDIDATE_OUTPUT_SCHEMA } from "./recruiting.js";

const base = {
  id: "event-synthetic",
  spaceId: "space-synthetic",
  threadId: "thread-synthetic",
  botId: "bot-synthetic",
  runId: "run-synthetic",
  seq: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("recruiting material and assessment events", () => {
  it("validates a saved workspace change without fabricating an effect or exposing content", () => {
    for (const roleId of ["role-synthetic", null])
      expect(
        ProductEventSchema.safeParse({ ...base, type: "recruiting.changed", payload: { roleId } })
          .success,
      ).toBe(true);
    for (const payload of [{}, { roleId: " " }, { roleId: "role-synthetic", rawText: "private" }])
      expect(
        ProductEventSchema.safeParse({ ...base, type: "recruiting.changed", payload }).success,
      ).toBe(false);
  });
  const candidates = {
    roleId: "role-synthetic",
    roleRevisionId: "revision-synthetic",
    effectId: "native-read-effect",
    mcpServerId: "server-synthetic",
    serverRevision: 1,
    providerTaskId: "provider-task-synthetic",
    requestCursor: "  opaque+/=  ",
    outputArtifact: { artifactId: "candidate-artifact", sha256: "b".repeat(64) },
    candidateOutputSchema: RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
  };

  it("records native candidate result provenance without a custom action", () => {
    for (const requestCursor of [null, candidates.requestCursor]) {
      const event = {
        ...base,
        type: "recruiting.candidates.saved",
        payload: { ...candidates, requestCursor },
      };
      expect(ProductEventSchema.parse(event)).toEqual(event);
    }
    for (const invalid of [
      { roleId: " " },
      { roleRevisionId: "" },
      { effectId: "" },
      { mcpServerId: " " },
      { serverRevision: 0 },
      { serverRevision: 1.5 },
      { providerTaskId: " " },
      { requestCursor: undefined },
      { outputArtifact: { ...candidates.outputArtifact, sha256: "invalid" } },
      { candidateOutputSchema: "unknown" },
      { actionId: "custom-action" },
      { rawText: "private" },
    ]) {
      expect(
        ProductEventSchema.safeParse({
          ...base,
          type: "recruiting.candidates.saved",
          payload: { ...candidates, ...invalid },
        }).success,
      ).toBe(false);
    }
  });

  const material = {
    reader: "web_fetch",
    artifact: { artifactId: "material-synthetic", sha256: "a".repeat(64) },
    url: "https://example.com/profile",
    readAt: base.createdAt,
  };
  const assessment = {
    roleId: "role-synthetic",
    roleRevisionId: "revision-synthetic",
    candidateKey: "source-row-synthetic",
    version: 1,
    effectId: "effect-synthetic",
  };
  const question = {
    roleId: assessment.roleId,
    roleRevisionId: assessment.roleRevisionId,
    effectId: assessment.effectId,
    target: {
      kind: "candidate",
      candidateKey: assessment.candidateKey,
      assessmentVersion: 1,
      criterionIds: ["geometry"],
    },
    messageId: "native-question",
    askIndex: 0,
  };

  it.each([
    ["recruiting.material.read", material],
    ["recruiting.assessment.saved", assessment],
    ["recruiting.question.asked", question],
  ])("accepts a native %s receipt and rejects unstructured content", (type, payload) => {
    expect(ProductEventSchema.safeParse({ ...base, type, payload }).success).toBe(true);
    expect(ProductEventSchema.safeParse({ ...base, type, payload: {} }).success).toBe(false);
    expect(
      ProductEventSchema.safeParse({ ...base, type, payload: { ...payload, rawText: "private" } })
        .success,
    ).toBe(false);
  });

  it.each([
    { ...question, askIndex: -1 },
    { ...question, messageId: "" },
    { ...question, target: { ...question.target, assessmentVersion: 0 } },
  ])("rejects invalid original-question binding", (payload) => {
    expect(
      ProductEventSchema.safeParse({
        ...base,
        type: "recruiting.question.asked",
        payload,
      }).success,
    ).toBe(false);
  });

  it.each([
    { ...material, reader: "model" },
    { ...material, url: "not-a-url" },
    { ...material, readAt: "not-a-date" },
    { ...material, artifact: { artifactId: "material", sha256: "wrong" } },
  ])("rejects invalid material identity and read metadata", (payload) => {
    expect(
      ProductEventSchema.safeParse({ ...base, type: "recruiting.material.read", payload }).success,
    ).toBe(false);
  });

  it.each([
    { ...assessment, version: 0 },
    { ...assessment, effectId: " " },
    { ...assessment, candidateKey: "" },
  ])("rejects invalid assessment receipt identity", (payload) => {
    expect(
      ProductEventSchema.safeParse({ ...base, type: "recruiting.assessment.saved", payload })
        .success,
    ).toBe(false);
  });
});
