import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { toolRequiresApproval, unattendedTriggerToolRequiresApproval } from "@rakazo/core";
import * as pdfText from "@rakazo/core/node/pdf-text";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactReadFromTool,
  INTERNAL_ARTIFACT_ERROR,
  readActorArtifact,
} from "./artifact-read.js";
import { LocalArtifactStore } from "./artifacts.js";
import { selectBuiltinToolsForRun } from "./executor.js";

const actor = { spaceId: "space", userId: "owner" };
afterEach(() => vi.restoreAllMocks());
function fixture(text = "\uFEFF中文😀\r\nend 🧑‍💻") {
  const bytes = Buffer.from(text);
  const row = {
    id: "saved-v1",
    botId: "bot" as string | null,
    groupId: null as string | null,
    runId: "run",
    name: "original.txt",
    description: null,
    mimeType: "text/plain",
    size: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
    version: 1,
    rootArtifactId: null as string | null,
    storageKey: "private-key",
    createdAt: new Date(0),
    spaceId: actor.spaceId,
    userId: actor.userId,
  };
  const get = vi.fn(async () => bytes);
  const findFirst = vi.fn(async ({ where }) =>
    where.spaceId === row.spaceId && where.userId === row.userId ? row : null,
  );
  const queryRaw = vi.fn(async (_query: unknown) => [] as Array<{ id: string }>);
  const deps = {
    prisma: { artifact: { findFirst }, $queryRaw: queryRaw } as unknown as PrismaClient,
    artifacts: { get } as unknown as ArtifactStore,
  };
  return { deps, row, get, findFirst, queryRaw };
}
describe("native saved artifact reading", () => {
  it.each(["bot", "other-bot", null])(
    "denies adopted private-memory context from %s before any tool storage read",
    async (botId) => {
      const marker = "synthetic private-memory marker";
      const f = fixture(JSON.stringify({ memory: { documents: [{ includedContent: marker }] } }));
      f.row.botId = botId;
      f.row.mimeType = "application/json";
      f.queryRaw.mockResolvedValue([{ id: f.row.id }]);
      expect(
        await artifactReadFromTool(f.deps, actor, {
          artifactId: f.row.id,
          jsonPath: ["memory", "documents", 0, "includedContent"],
        }),
      ).toEqual({ error: INTERNAL_ARTIFACT_ERROR });
      expect(f.queryRaw).toHaveBeenCalledOnce();
      expect(f.get).not.toHaveBeenCalled();

      // Native human diagnostics retain the immutable original through their own authorization.
      const saved = await readActorArtifact(f.deps, actor, { artifactId: f.row.id });
      expect(saved.bytes.toString()).toContain(marker);
      expect(f.queryRaw).toHaveBeenCalledOnce();
    },
  );
  it.each([
    ["another space", { spaceId: "other-space", userId: "owner" }],
    ["the same space", { spaceId: "space", userId: "other-user" }],
  ])("refuses another actor in %s before any storage read", async (_label, other) => {
    const f = fixture("owner only");
    await expect(readActorArtifact(f.deps, other, { artifactId: f.row.id })).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(await artifactReadFromTool(f.deps, other, { artifactId: f.row.id })).toEqual({
      error: "Artifact is unavailable.",
    });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.queryRaw).not.toHaveBeenCalled();
    expect(
      (await readActorArtifact(f.deps, actor, { artifactId: f.row.id })).bytes.toString(),
    ).toBe("owner only");
  });
  it("denies a renamed version in an adopted context family", async () => {
    const f = fixture("private snapshot version");
    f.row.name = "renamed.txt";
    f.row.rootArtifactId = "adopted-context-root";
    f.queryRaw.mockResolvedValue([{ id: f.row.rootArtifactId }]);
    expect(await artifactReadFromTool(f.deps, actor, { artifactId: f.row.id })).toEqual({
      error: INTERNAL_ARTIFACT_ERROR,
    });
    expect(f.get).not.toHaveBeenCalled();
  });
  it("explains an internal role-context/request record and points to the readable tools", async () => {
    const f = fixture("formal research request");
    f.queryRaw.mockResolvedValue([{ id: f.row.id }]);
    const result = await artifactReadFromTool(f.deps, actor, { artifactId: f.row.id });
    expect(result.error).toMatch(/internal recruiting/);
    expect(result.error).toContain("recruiting_role");
    expect(result.error).toContain("recruiting_candidates");
    expect(f.get).not.toHaveBeenCalled();
  });
  it("binds actor and family while matching authoritative adoption and formal request hashes", async () => {
    const f = fixture();
    f.row.rootArtifactId = "context-family";
    await artifactReadFromTool(f.deps, actor, { artifactId: f.row.id });
    const query = f.queryRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
    const sql = query.strings.join("?").replace(/\s+/g, " ");
    expect(query.values).toEqual([actor.spaceId, actor.userId, "context-family", "context-family"]);
    expect(sql).toContain('internal."spaceId" = ? AND internal."userId" = ?');
    expect(sql).toContain('(internal.id = ? OR internal."rootArtifactId" = ?)');
    for (const predicate of [
      'event."runId" = internal."runId"',
      'event."spaceId" = internal."spaceId"',
      '(internal."botId" IS NULL OR event."botId" = internal."botId")',
      "event.type = 'recruiting.context.adopted'",
      "event.payload->'contextArtifact'->>'artifactId' = internal.id",
      "event.payload->'contextArtifact'->>'sha256' = internal.hash",
      'FROM "recruiting_research_actions" action',
      '(action."contextArtifactId" = internal.id AND action."contextArtifactHash" = internal.hash)',
      '(action."requestArtifactId" = internal.id AND action."requestArtifactHash" = internal.hash)',
    ])
      expect(sql).toContain(predicate);
    // Candidate/source results and receipts contain no automatic contextText copy.
    for (const field of [
      "receiptArtifactId",
      "outputArtifacts",
      "recruiting_candidate_pages",
      "name",
      "clientNonce",
    ])
      expect(sql).not.toContain(field);
  });
  it("keeps ordinary cross-bot group attachments readable without trusting their names", async () => {
    const f = fixture("ordinary shared attachment");
    f.row.botId = "other-bot";
    f.row.groupId = "shared-group";
    f.row.name = "recruiting-context-run.json";
    expect(await artifactReadFromTool(f.deps, actor, { artifactId: f.row.id })).toMatchObject({
      text: "ordinary shared attachment",
      artifact: { botId: "other-bot", groupId: "shared-group" },
    });
    expect(f.queryRaw).toHaveBeenCalledOnce();
    expect(f.get).toHaveBeenCalledOnce();
    expect(f.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      f.queryRaw.mock.invocationCallOrder[0]!,
    );
    expect(f.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(f.get.mock.invocationCallOrder[0]!);
  });
  it("parses a CSV artifact into header and rows when csv is requested", async () => {
    const f = fixture('\uFEFFName,Email\r\n"Doe, Jane",j@x.com\r\n');
    f.row.mimeType = "text/csv";
    await expect(
      artifactReadFromTool(f.deps, actor, { artifactId: f.row.id, csv: true }),
    ).resolves.toMatchObject({
      artifact: { id: f.row.id },
      csv: {
        header: ["Name", "Email"],
        rows: [["Doe, Jane", "j@x.com"]],
        rowCount: 1,
        truncated: false,
      },
    });
  });
  it("rejects csv mode for non-CSV artifacts", async () => {
    const f = fixture("a,b");
    await expect(
      artifactReadFromTool(f.deps, actor, { artifactId: f.row.id, csv: true }),
    ).resolves.toMatchObject({ error: "csv requires a text/csv artifact." });
  });
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
    expect(f.queryRaw).not.toHaveBeenCalled();
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
