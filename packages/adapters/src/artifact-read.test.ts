import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { toolRequiresApproval, unattendedTriggerToolRequiresApproval } from "@rakazo/core";
import * as pdfText from "@rakazo/core/node/pdf-text";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactReadFromTool } from "./artifact-read.js";
import { LocalArtifactStore } from "./artifacts.js";
import { selectBuiltinToolsForRun } from "./executor.js";

const actor = { spaceId: "space", userId: "owner" };
afterEach(() => vi.restoreAllMocks());
function fixture(text = "\uFEFF中文😀\r\nend 🧑‍💻") {
  const bytes = Buffer.from(text);
  const row = {
    id: "saved-v1",
    botId: "bot",
    groupId: null,
    runId: "run",
    name: "original.txt",
    description: null,
    mimeType: "text/plain",
    size: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
    version: 1,
    rootArtifactId: null,
    storageKey: "private-key",
    createdAt: new Date(0),
    spaceId: actor.spaceId,
    userId: actor.userId,
  };
  const get = vi.fn(async () => bytes);
  const findFirst = vi.fn(async ({ where }) =>
    where.spaceId === row.spaceId && where.userId === row.userId ? row : null,
  );
  const deps = {
    prisma: { artifact: { findFirst } } as unknown as PrismaClient,
    artifacts: { get } as unknown as ArtifactStore,
  };
  return { deps, row, get, findFirst };
}
describe("native saved artifact reading", () => {
  it("pages extracted PDF text while retaining its original identity and checking access before extraction", async () => {
    const original = "First page: Python evidence.\nSecond page: geometry 😀.\n";
    const extract = vi.spyOn(pdfText, "extractPdfText").mockResolvedValue(original);
    const f = fixture("%PDF-1.4\nsynthetic converter input");
    f.row.mimeType = "application/pdf";
    expect(
      await artifactReadFromTool(f.deps, { ...actor, userId: "foreign" }, { artifactId: f.row.id }),
    ).toHaveProperty("error");
    const hash = f.row.hash;
    f.row.hash = "bad";
    expect(await artifactReadFromTool(f.deps, actor, { artifactId: f.row.id })).toHaveProperty(
      "error",
    );
    expect(extract).not.toHaveBeenCalled();
    f.row.hash = hash;
    let offset: number | null = 0;
    let combined = "";
    while (offset !== null) {
      const result = await artifactReadFromTool(f.deps, actor, {
        artifactId: f.row.id,
        offset,
        limit: 7,
      });
      expect(result).toMatchObject({
        artifact: { id: f.row.id, hash, mimeType: "application/pdf", size: f.row.size },
        totalLength: Array.from(original).length,
        offsetUnit: "unicode_code_point",
      });
      if (!("text" in result)) throw new Error("PDF text unavailable");
      combined += result.text;
      offset = result.nextOffset ?? null;
    }
    expect(combined).toBe(original);
    expect(extract).toHaveBeenCalledWith(Buffer.from("%PDF-1.4\nsynthetic converter input"));
    extract.mockClear();
    expect(
      await artifactReadFromTool(f.deps, actor, { artifactId: f.row.id, jsonPath: ["text"] }),
    ).toHaveProperty("error");
    expect(extract).not.toHaveBeenCalled();
    extract.mockRejectedValueOnce(new Error("/private/path secret-value"));
    const failed = await artifactReadFromTool(f.deps, actor, { artifactId: f.row.id });
    expect(failed).toHaveProperty("error", "PDF text could not be read or verified.");
    expect(failed).not.toHaveProperty("text");
    expect(JSON.stringify(failed)).not.toContain("secret-value");
  });
  it("reads one exact candidate evidence string instead of preceding JD text", async () => {
    const evidence = '  Built "platforms" 😀\r\nwith distributed systems.\n';
    const f = fixture(
      JSON.stringify({
        providerResult: {
          content: [{ text: "Job description, not candidate evidence." }],
          structuredContent: { rows: [{ infra_evidence: { value: evidence } }] },
        },
      }),
    );
    f.row.mimeType = "application/json; charset=utf-8";
    const jsonPath = ["providerResult", "structuredContent", "rows", 0, "infra_evidence", "value"];
    let offset: number | null = 0;
    let combined = "";
    while (offset !== null) {
      const result = await artifactReadFromTool(f.deps, actor, {
        artifactId: f.row.id,
        jsonPath,
        offset,
        limit: 3,
      });
      expect(result).toMatchObject({
        artifact: { id: f.row.id, hash: f.row.hash, size: f.row.size },
        jsonPath,
        offset,
        totalLength: Array.from(evidence).length,
        offsetUnit: "unicode_code_point",
      });
      if (!("text" in result)) throw new Error("missing selected text");
      combined += result.text;
      offset = result.nextOffset ?? null;
    }
    expect(combined).toBe(evidence);
  });
  it("selects a root JSON string and rejects invalid, missing or non-string fields", async () => {
    const f = fixture(JSON.stringify("Root 😀 evidence"));
    f.row.mimeType = "application/json";
    expect(
      await artifactReadFromTool(f.deps, actor, { artifactId: f.row.id, jsonPath: [] }),
    ).toMatchObject({ text: "Root 😀 evidence", jsonPath: [] });
    const nested = fixture('{"rows":[{"text":"evidence","count":1}],"constructor":"private"}');
    nested.row.mimeType = "application/json";
    for (const jsonPath of [
      ["missing"],
      ["rows", 0],
      ["rows", 0, "count"],
      ["rows", "0", "text"],
      ["rows", -1, "text"],
      ["rows", 0.5, "text"],
      ["constructor"],
      ["__proto__"],
      ["rows", 0, "prototype"],
    ]) {
      const result = await artifactReadFromTool(nested.deps, actor, {
        artifactId: nested.row.id,
        jsonPath,
      });
      expect(result).toHaveProperty("error");
      expect(result).not.toHaveProperty("text");
      expect(JSON.stringify(result)).not.toContain("private");
    }
    for (const source of ["not JSON", '{"text":"evidence"}']) {
      const invalid = fixture(source);
      invalid.row.mimeType = source === "not JSON" ? "application/json" : "text/plain";
      expect(
        await artifactReadFromTool(invalid.deps, actor, {
          artifactId: invalid.row.id,
          jsonPath: ["text"],
        }),
      ).toHaveProperty("error");
    }
  });
  it("authorizes both actor dimensions before touching blob storage", async () => {
    const f = fixture();
    for (const denied of [
      { ...actor, userId: "foreign" },
      { ...actor, spaceId: "foreign" },
    ])
      expect(
        await artifactReadFromTool(f.deps, denied, { artifactId: "saved-v1", jsonPath: ["text"] }),
      ).toEqual({
        error: "Artifact is unavailable.",
      });
    expect(f.get).not.toHaveBeenCalled();
  });
  it("returns exact metadata and lossless contiguous Unicode pages of the stored version", async () => {
    const original = "\uFEFF中文😀\r\nend 🧑‍💻";
    const f = fixture(original);
    let offset: number | null = 0;
    let combined = "";
    while (offset !== null) {
      const result = await artifactReadFromTool(f.deps, actor, {
        artifactId: "saved-v1",
        offset,
        limit: 1,
      });
      expect(result).toMatchObject({
        artifact: {
          id: "saved-v1",
          version: 1,
          hash: f.row.hash,
          size: Buffer.byteLength(original),
        },
        offset,
        offsetUnit: "unicode_code_point",
      });
      if (!("text" in result)) throw new Error("missing text");
      combined += result.text;
      offset = result.nextOffset ?? null;
    }
    expect(combined).toBe(original);
  });
  it("rejects corrupted bytes and lengths without leaking storage details", async () => {
    const f = fixture();
    f.row.hash = "bad";
    expect(await artifactReadFromTool(f.deps, actor, { artifactId: "saved-v1" })).toHaveProperty(
      "error",
    );
    f.get.mockRejectedValueOnce(new Error("/private/path secret-value"));
    expect(
      JSON.stringify(await artifactReadFromTool(f.deps, actor, { artifactId: "saved-v1" })),
    ).not.toContain("private");
    const length = fixture();
    length.row.size++;
    expect(
      await artifactReadFromTool(length.deps, actor, { artifactId: "saved-v1" }),
    ).toHaveProperty("error");
  });
  it("does not invent text for binary formats or invalid UTF-8, and bounds offsets", async () => {
    const f = fixture();
    f.row.mimeType = "application/pdf";
    expect(
      await artifactReadFromTool(f.deps, actor, { artifactId: "saved-v1" }),
    ).not.toHaveProperty("text");
    expect(
      await artifactReadFromTool(f.deps, actor, { artifactId: "saved-v1", limit: 16001 }),
    ).toHaveProperty("error");
    expect(f.get).toHaveBeenCalledTimes(1);
    const invalid = fixture("a");
    invalid.get.mockResolvedValueOnce(Buffer.from([255]));
    invalid.row.hash = createHash("sha256")
      .update(Buffer.from([255]))
      .digest("hex");
    expect(
      await artifactReadFromTool(invalid.deps, actor, { artifactId: "saved-v1" }),
    ).not.toHaveProperty("text");
    expect(
      await artifactReadFromTool(fixture().deps, actor, { artifactId: "saved-v1", offset: 999 }),
    ).toHaveProperty("error");
  });
  it("reads original saved bytes after reopening the existing native file store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "artifact-reader-"));
    try {
      const f = fixture();
      const context = {
        ...actor,
        botId: "bot",
        operationId: "save",
        traceId: "save",
        signal: new AbortController().signal,
      };
      const bytes = await f.get();
      const stored = await new LocalArtifactStore(root).put(
        { name: f.row.name, mimeType: f.row.mimeType, bytes },
        context,
      );
      f.row.storageKey = stored.id;
      const reopened = { ...f.deps, artifacts: new LocalArtifactStore(root) };
      const result = await artifactReadFromTool(reopened, actor, { artifactId: f.row.id });
      expect(result).toMatchObject({
        text: bytes.toString(),
        artifact: { hash: f.row.hash, version: 1 },
      });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain(stored.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("offers a read-only tool without a computer and honors disabled settings", () => {
    expect(toolRequiresApproval("artifact_read", false)).toBe(false);
    expect(unattendedTriggerToolRequiresApproval("webhook", "artifact_read", false)).toBe(false);
    const options = {
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    };
    expect(
      selectBuiltinToolsForRun(options).find((t) => t.name === "artifact_read"),
    ).toHaveProperty("readOnly", true);
    expect(
      selectBuiltinToolsForRun({ ...options, disabledBuiltinTools: ["artifact_read"] }).some(
        (t) => t.name === "artifact_read",
      ),
    ).toBe(false);
  });
});
