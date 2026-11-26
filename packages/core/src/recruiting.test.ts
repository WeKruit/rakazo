import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as core from "./index.js";

describe("shared recruiting material readers", () => {
  it("verifies the saved bytes rather than trusting a reference or metadata", async () => {
    expect(core.verifyRecruitingArtifactBytes).toBeTypeOf("function");
    const bytes = Buffer.from("Original source 游标 🧭\n");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await expect(core.verifyRecruitingArtifactBytes(bytes, hash)).resolves.toBeUndefined();
    await expect(
      core.verifyRecruitingArtifactBytes(Buffer.from("Changed"), hash),
    ).rejects.toThrow();
  });

  it("reads one exact nested JSON string without losing escaped characters or whitespace", () => {
    expect(core.readRecruitingJsonString).toBeTypeOf("function");
    const text = '  Built 🧭 systems.\nUses "quoted" field names.  ';
    const bytes = Buffer.from(JSON.stringify({ people: [{ evidence: text }] }));
    expect(core.readRecruitingJsonString(bytes, ["people", 0, "evidence"])).toBe(text);
    expect(core.readRecruitingJsonString(Buffer.from(JSON.stringify(text)), [])).toBe(text);
  });

  it("rejects missing, inherited, non-string and malformed JSON material paths", () => {
    expect(core.readRecruitingJsonString).toBeTypeOf("function");
    const bytes = Buffer.from('{"people":[{"evidence":"Read","count":2}],"__proto__":"forged"}');
    for (const path of [
      ["people", 0, "missing"],
      ["people", "0", "evidence"],
      ["people", 0, "count"],
      ["__proto__"],
      ["constructor"],
      ["prototype"],
      ["people", -1],
      ["people", 0.5],
    ])
      expect(() => core.readRecruitingJsonString(bytes, path)).toThrow();
    expect(() => core.readRecruitingJsonString(Buffer.from([0xff]), [])).toThrow();
    expect(() => core.readRecruitingJsonString(Buffer.from("{broken"), [])).toThrow();
  });

  it("preserves exact UTF-16 source selections and rejects invalid ranges", () => {
    expect(core.validateRecruitingTextSelection).toBeTypeOf("function");
    const text = "\nA🧭B\n";
    expect(() => core.validateRecruitingTextSelection(text, 2, 4, "🧭")).not.toThrow();
    expect(() => core.validateRecruitingTextSelection(text, 0, text.length, text)).not.toThrow();
    for (const [start, end, quote] of [
      [2, 3, "\ud83e"],
      [3, 4, "\udded"],
      [-1, 1, ""],
      [1, 1, ""],
      [4, 2, ""],
      [0.5, 2, "\nA"],
      [0, Number.POSITIVE_INFINITY, text],
      [0, text.length + 1, text],
      [2, 4, "wrong"],
    ] as const)
      expect(() => core.validateRecruitingTextSelection(text, start, end, quote)).toThrow();
  });
});

describe("native recruiting result snapshot reads", () => {
  const rows = [
    {
      name: { value: "Synthetic person", source_id: "s1" },
      label: "Strong Match",
      _sources: { s1: "https://example.test/profile" },
      missing: null,
    },
  ];
  const snapshot = {
    version: 1,
    taskId: "task",
    actionId: "action",
    operation: "rows",
    effectId: "read-effect",
    request: { task_id: "provider-task", cursor: "  opaque/游标==  ", limit: 10 },
    providerResult: { rows, next_cursor: null },
    observation: {
      deliveryState: "accepted",
      providerTaskId: "provider-task",
      observedProviderState: null,
      done: null,
      providerApplicationConfirmed: false,
      automaticRetry: false,
      usage: null,
      rows,
      nextCursor: null,
      outputId: "real-output",
    },
  };
  function fixture(value: unknown = snapshot) {
    const bytes = Buffer.from(JSON.stringify(value));
    const artifact = {
      artifactId: "rows-artifact",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    return {
      bytes,
      expected: {
        task: { id: "task", providerTaskId: "provider-task" },
        action: { id: "action", taskId: "task", outputArtifacts: [artifact] },
        artifact,
      },
    };
  }
  it("reads exact provider rows and preserves opaque page metadata without making judgments", async () => {
    expect(core.readRecruitingResearchReadArtifact).toBeTypeOf("function");
    const f = fixture();
    const result = await core.readRecruitingResearchReadArtifact(f.bytes, f.expected);
    expect(result).toEqual(snapshot);
    expect(result.observation.rows).toEqual(rows);
    expect(result).not.toHaveProperty("assessment");
    expect(result).not.toHaveProperty("candidateKey");
  });
  it.each([
    "bytes",
    "task",
    "action",
    "action-task",
    "provider",
    "request",
    "membership",
    "hash-ref",
    "utf8",
  ])("rejects a snapshot with mismatched %s", async (boundary) => {
    expect(core.readRecruitingResearchReadArtifact).toBeTypeOf("function");
    const value = structuredClone(snapshot);
    if (boundary === "task") value.taskId = "foreign-task";
    if (boundary === "action") value.actionId = "foreign-action";
    if (boundary === "provider") value.observation.providerTaskId = "foreign-provider";
    if (boundary === "request") value.request.task_id = "foreign-provider";
    const f = fixture(value);
    if (boundary === "action-task") f.expected.action.taskId = "foreign-task";
    if (boundary === "bytes") f.bytes = Buffer.from("{}");
    if (boundary === "membership") f.expected.action.outputArtifacts = [];
    if (boundary === "hash-ref")
      f.expected.action.outputArtifacts = [{ ...f.expected.artifact, sha256: "a".repeat(64) }];
    if (boundary === "utf8") {
      f.bytes = Buffer.from([0xff]);
      f.expected.artifact.sha256 = createHash("sha256").update(f.bytes).digest("hex");
    }
    await expect(core.readRecruitingResearchReadArtifact(f.bytes, f.expected)).rejects.toThrow();
  });
  it("keeps status receipts distinct and does not turn absent cursors into end-of-results", async () => {
    expect(core.readRecruitingResearchReadArtifact).toBeTypeOf("function");
    const { rows: _, nextCursor: __, outputId: ___, ...observation } = snapshot.observation;
    const f = fixture({
      ...snapshot,
      operation: "status",
      providerResult: { state: "completed", done: true },
      observation: { ...observation, observedProviderState: "completed", done: true },
    });
    const result = await core.readRecruitingResearchReadArtifact(f.bytes, f.expected);
    expect(result.operation).toBe("status");
    expect(result.observation).not.toHaveProperty("rows");
    expect(result.observation).not.toHaveProperty("nextCursor");
  });
  it.each(["missing-rows", "status-rows", "unknown-rows"])(
    "rejects contradictory %s envelopes",
    async (boundary) => {
      const value: Record<string, unknown> = structuredClone(snapshot);
      const observation = { ...snapshot.observation } as Record<string, unknown>;
      if (boundary === "missing-rows") delete observation.rows;
      if (boundary === "status-rows") value.operation = "status";
      if (boundary === "unknown-rows") observation.deliveryState = "unknown";
      const f = fixture({ ...value, observation });
      await expect(core.readRecruitingResearchReadArtifact(f.bytes, f.expected)).rejects.toThrow();
    },
  );
});

const preference = {
  target: "preference",
  scope: "user",
  path: "preferences.md",
  expectedRevision: 1,
  intent: { basis: "direct", quote: "Remember this" },
  sourceRefs: [],
} as const;

describe("exact recruiting preference edits", () => {
  it("appends exact new content and returns its resulting UTF-16 anchor", () => {
    const input = { ...preference, operation: "add" as const, content: "  prompt preference\n" };
    expect(core.applyRecruitingPreferenceEdit?.("", input)).toEqual({
      content: input.content,
      previousAnchor: null,
      anchor: { start: 0, end: input.content.length, quote: input.content },
    });
    expect(core.applyRecruitingPreferenceEdit?.("🙂 previous", input)).toEqual({
      content: `🙂 previous\n\n${input.content}`,
      previousAnchor: null,
      anchor: {
        start: "🙂 previous\n\n".length,
        end: "🙂 previous\n\n".length + input.content.length,
        quote: input.content,
      },
    });
  });

  it("adds a preference once and collapses blank lines left by removals", () => {
    const input = { ...preference, operation: "add" as const, content: "No agency recruiters" };
    expect(core.applyRecruitingPreferenceEdit?.("Keep it short\n\n\n\n\n", input)?.content).toBe(
      "Keep it short\n\nNo agency recruiters",
    );
    const again = core.applyRecruitingPreferenceEdit?.(
      "No agency recruiters\n\n\n\nKeep it short",
      input,
    );
    expect(again?.content).toBe("No agency recruiters\n\nKeep it short");
    expect(again?.anchor).toEqual({ start: 0, end: 20, quote: "No agency recruiters" });
  });

  it("replaces only the selected duplicate span and preserves every surrounding character", () => {
    const content = "🙂 old\nkeep old\n";
    const start = content.lastIndexOf("old");
    const result = core.applyRecruitingPreferenceEdit?.(content, {
      ...preference,
      operation: "replace",
      anchor: { start, end: start + 3, quote: "old" },
      content: "new🙂",
    });
    expect(result).toEqual({
      content: "🙂 old\nkeep new🙂\n",
      previousAnchor: { start, end: start + 3, quote: "old" },
      anchor: { start, end: start + 5, quote: "new🙂" },
    });
  });

  it("revokes only the exact span and allows the last preference to become empty", () => {
    expect(
      core.applyRecruitingPreferenceEdit?.("keep\nold\nkeep", {
        ...preference,
        operation: "revoke",
        anchor: { start: 5, end: 8, quote: "old" },
      }),
    ).toEqual({
      content: "keep\n\nkeep",
      previousAnchor: { start: 5, end: 8, quote: "old" },
      anchor: null,
    });
    expect(
      core.applyRecruitingPreferenceEdit?.("🙂", {
        ...preference,
        operation: "revoke",
        anchor: { start: 0, end: 2, quote: "🙂" },
      }),
    ).toEqual({
      content: "",
      previousAnchor: { start: 0, end: 2, quote: "🙂" },
      anchor: null,
    });
  });

  it.each(["replace", "revoke"] as const)(
    "resolves a unique exact quote for %s and returns its authoritative UTF-16 audit anchor",
    (operation) => {
      const content = "🙂 keep\r\n  old\r\nKeep trailing space. ";
      const quote = "  old\r\n";
      const start = content.indexOf(quote);
      const replacement = operation === "replace" ? "new🙂\n" : "";
      const result = core.applyRecruitingPreferenceEdit(content, {
        ...preference,
        ...(operation === "replace" ? { operation, content: replacement } : { operation }),
        anchor: { quote },
      });
      expect(result).toEqual({
        content: content.slice(0, start) + replacement + content.slice(start + quote.length),
        previousAnchor: { start, end: start + quote.length, quote },
        anchor: replacement ? { start, end: start + replacement.length, quote: replacement } : null,
      });
    },
  );

  it("rejects missing and ambiguous exact quotes, including overlapping occurrences", () => {
    for (const quote of ["OLD", "old ", "missing"]) {
      expect(() =>
        core.applyRecruitingPreferenceEdit("🙂 old", {
          ...preference,
          operation: "revoke",
          anchor: { quote },
        }),
      ).toThrow(/quote.*not found/i);
    }
    for (const [content, quote] of [
      ["old old", "old"],
      ["aaa", "aa"],
    ] as const) {
      expect(() =>
        core.applyRecruitingPreferenceEdit(content, {
          ...preference,
          operation: "revoke",
          anchor: { quote },
        }),
      ).toThrow(/quote.*more than once/i);
    }
    for (const quote of ["", "\ud83d", "\ude42"]) {
      expect(() =>
        core.applyRecruitingPreferenceEdit("🙂", {
          ...preference,
          operation: "revoke",
          anchor: { quote },
        }),
      ).toThrow();
    }
  });

  it("rejects stale, out-of-range and surrogate-splitting anchors without fuzzy matching", () => {
    for (const anchor of [
      { start: 0, end: 1, quote: "\ud83d" },
      { start: 1, end: 2, quote: "\ude42" },
      { start: -1, end: 2, quote: "🙂" },
      { start: 0, end: 20, quote: "🙂 old" },
      { start: 0, end: 3, quote: "old" },
      { start: 3, end: 6, quote: "new" },
      { start: 3, end: 3, quote: "old" },
    ])
      expect(() =>
        core.applyRecruitingPreferenceEdit?.("🙂 old", {
          ...preference,
          operation: "revoke",
          anchor,
        }),
      ).toThrow();
  });
});
