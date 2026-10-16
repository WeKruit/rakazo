import { describe, expect, it } from "vitest";
import { ProductEventSchema } from "./events.js";

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

  it.each([
    ["recruiting.material.read", material],
    ["recruiting.assessment.saved", assessment],
  ])("accepts a native %s receipt and rejects unstructured content", (type, payload) => {
    expect(ProductEventSchema.safeParse({ ...base, type, payload }).success).toBe(true);
    expect(ProductEventSchema.safeParse({ ...base, type, payload: {} }).success).toBe(false);
    expect(
      ProductEventSchema.safeParse({ ...base, type, payload: { ...payload, rawText: "private" } })
        .success,
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
