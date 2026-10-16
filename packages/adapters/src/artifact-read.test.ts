import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { toolRequiresApproval, unattendedTriggerToolRequiresApproval } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { artifactReadFromTool } from "./artifact-read.js";
import { LocalArtifactStore } from "./artifacts.js";
import { selectBuiltinToolsForRun } from "./executor.js";

const actor = { spaceId: "space", userId: "owner" };
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
  it("authorizes both actor dimensions before touching blob storage", async () => {
    const f = fixture();
    for (const denied of [
      { ...actor, userId: "foreign" },
      { ...actor, spaceId: "foreign" },
    ])
      expect(await artifactReadFromTool(f.deps, denied, { artifactId: "saved-v1" })).toEqual({
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
