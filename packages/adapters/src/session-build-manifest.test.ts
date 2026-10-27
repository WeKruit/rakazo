import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifySessionBuildManifest } from "./session-admission-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("image admission manifest", () => {
  it("binds actual bundle bytes and source generation independently of environment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "slot-image-"));
    roots.push(root);
    const entry = path.join(root, "index.mjs");
    const bytes = "// synthetic bundle";
    await writeFile(entry, bytes);
    const manifest = {
      sourceRevision: "a".repeat(40),
      sessionAdmissionProtocol: 1,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await expect(verifySessionBuildManifest(entry, manifest.sourceRevision)).rejects.toThrow();
    await writeFile(path.join(root, "build-manifest.json"), JSON.stringify(manifest));
    await verifySessionBuildManifest(entry, manifest.sourceRevision);
    await expect(verifySessionBuildManifest(entry, "b".repeat(40))).rejects.toThrow("generation");
    await writeFile(entry, "// stale image or tampered bundle");
    await expect(verifySessionBuildManifest(entry, manifest.sourceRevision)).rejects.toThrow(
      "bundle",
    );
  });
});
