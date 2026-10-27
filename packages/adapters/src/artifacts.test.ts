import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as artifactStores from "./artifacts.js";
import { LocalArtifactStore } from "./artifacts.js";

const dirs: string[] = [];
const context = { spaceId: "space-1" } as never;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const remoteEnv = {
  ARTIFACT_STORAGE_URL: "https://example.supabase.co",
  ARTIFACT_STORAGE_KEY: "sb_secret_test-only",
  ARTIFACT_STORAGE_BUCKET: "artifacts",
};
const remoteContext: AdapterContext = {
  spaceId: "space-1",
  userId: "user-1",
  operationId: "operation-1",
  traceId: "trace-1",
  signal: new AbortController().signal,
};

describe("Supabase artifact storage", () => {
  it("shares immutable original bytes across instances, isolates spaces and removes exact keys", async () => {
    expect(artifactStores.createArtifactStore).toBeTypeOf("function");
    const objects = new Map<string, Uint8Array>();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ apikey: remoteEnv.ARTIFACT_STORAGE_KEY });
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(init.redirect).toBe("error");
      expect(init.cache).toBe("no-store");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const key = new URL(url).pathname;
      if (init.method === "POST") {
        expect(init.headers).toMatchObject({
          "content-type": "application/octet-stream",
          "x-upsert": "false",
        });
        expect(objects.has(key)).toBe(false);
        objects.set(key, new Uint8Array(init.body as Uint8Array));
        return Response.json({ Key: key });
      }
      if (init.method === "DELETE") {
        expect(key).toBe("/storage/v1/object/artifacts");
        const { prefixes } = JSON.parse(init.body as string);
        expect(prefixes).toHaveLength(1);
        objects.delete(`${key}/${prefixes[0]}`);
        return Response.json([]);
      }
      const bytes = objects.get(key.replace("/authenticated/", "/"));
      return bytes
        ? new Response(new Uint8Array(bytes))
        : new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    const options = artifactStores.artifactStorageOptionsFromEnv(remoteEnv);
    const first = artifactStores.createArtifactStore("unused-local-path", options);
    const second = artifactStores.createArtifactStore("another-local-path", options);
    const bytes = new Uint8Array([0, 255, 10, 128, 42]);
    const stored = await first.put(
      { name: "original.bin", mimeType: "application/octet-stream", bytes },
      remoteContext,
    );
    expect(stored).toEqual({ id: expect.stringMatching(/^[\da-f-]{36}$/), hash: "5" });
    expect(await second.get(stored.id, remoteContext)).toEqual(bytes);
    await expect(second.get(stored.id, { ...remoteContext, spaceId: "space-2" })).rejects.toThrow(
      "404",
    );
    await first.remove(stored.id, remoteContext);
    await second.remove(stored.id, remoteContext);
    expect(objects.size).toBe(0);
    await expect(second.get(stored.id, remoteContext)).rejects.toThrow("404");
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("reads files saved on the volume before object storage was configured, then copies them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const legacy = await new LocalArtifactStore(root).put(
      { name: "old.pdf", mimeType: "application/pdf", bytes: new Uint8Array([7, 8, 9]) },
      remoteContext,
    );
    const objects = new Map<string, Uint8Array>();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const key = new URL(url).pathname.replace("/authenticated/", "/");
      if (init.method === "POST") {
        expect(init.headers).toMatchObject({ "x-upsert": "true" });
        objects.set(key, new Uint8Array(init.body as Uint8Array));
        return Response.json({ Key: key });
      }
      const bytes = objects.get(key);
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    const options = artifactStores.artifactStorageOptionsFromEnv(remoteEnv);
    if (!options) throw new Error("expected remote options");
    const store = artifactStores.createArtifactStore(root, options);
    expect(await store.get(legacy.id, remoteContext)).toEqual(new Uint8Array([7, 8, 9]));
    expect(fetch).not.toHaveBeenCalled();

    const remote = new artifactStores.SupabaseArtifactStore(options);
    const signal = new AbortController().signal;
    expect(await artifactStores.copyLocalArtifacts(root, remote, signal)).toEqual({
      copied: 1,
      bytes: 3,
    });
    expect([...objects.keys()]).toEqual([`/storage/v1/object/artifacts/space-1/${legacy.id}`]);
    expect(await remote.get(legacy.id, remoteContext)).toEqual(new Uint8Array([7, 8, 9]));
    expect(await artifactStores.copyLocalArtifacts(root, remote, signal)).toEqual({
      copied: 1,
      bytes: 3,
    });
  });

  it("copies nothing when the volume has no saved files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const options = artifactStores.artifactStorageOptionsFromEnv(remoteEnv);
    if (!options) throw new Error("expected remote options");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await artifactStores.copyLocalArtifacts(
        root,
        new artifactStores.SupabaseArtifactStore(options),
        new AbortController().signal,
      ),
    ).toEqual({ copied: 0, bytes: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the native local provider only when remote configuration is wholly absent", () => {
    expect(artifactStores.artifactStorageOptionsFromEnv({})).toBeUndefined();
    expect(artifactStores.createArtifactStore("unused-local-path")).toBeInstanceOf(
      LocalArtifactStore,
    );
  });

  it.each([
    { ARTIFACT_STORAGE_URL: remoteEnv.ARTIFACT_STORAGE_URL },
    { ...remoteEnv, ARTIFACT_STORAGE_KEY: "" },
    { ...remoteEnv, ARTIFACT_STORAGE_KEY: "sb_publishable_test" },
    { ...remoteEnv, ARTIFACT_STORAGE_URL: "http://example.supabase.co" },
    { ...remoteEnv, ARTIFACT_STORAGE_URL: "https://user:password@example.supabase.co" },
    { ...remoteEnv, ARTIFACT_STORAGE_URL: "https://example.supabase.co/storage" },
    { ...remoteEnv, ARTIFACT_STORAGE_URL: "https://example.supabase.co?secret=value" },
    { ...remoteEnv, ARTIFACT_STORAGE_URL: "https://example.supabase.co#secret" },
    { ...remoteEnv, ARTIFACT_STORAGE_BUCKET: "../other" },
    { ARTIFACT_STORAGE_BUCKET: "" },
  ])("rejects partial or invalid remote configuration without selecting local storage", (env) => {
    expect(() => artifactStores.artifactStorageOptionsFromEnv(env)).toThrow();
  });

  it.each([403, 409, 500])(
    "fails without retries or provider error disclosure for HTTP %s",
    async (status) => {
      const fetch = vi.fn(async () => new Response("private provider response", { status }));
      vi.stubGlobal("fetch", fetch);
      const store = artifactStores.createArtifactStore(
        "unused-local-path",
        artifactStores.artifactStorageOptionsFromEnv(remoteEnv),
      );
      await expect(
        store.put({ name: "x", mimeType: "text/plain", bytes: new Uint8Array([1]) }, remoteContext),
      ).rejects.toThrow(`Artifact storage request failed (${status})`);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("redacts transport failures and rejects unsafe storage paths before network access", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(`private ${remoteEnv.ARTIFACT_STORAGE_KEY}`);
    });
    vi.stubGlobal("fetch", fetch);
    const store = artifactStores.createArtifactStore(
      "unused-local-path",
      artifactStores.artifactStorageOptionsFromEnv(remoteEnv),
    );
    await expect(store.get("native-key", remoteContext)).rejects.toThrow(
      /^Artifact storage request failed$/,
    );
    await expect(store.get("../other", remoteContext)).rejects.toThrow(
      "Invalid artifact storage path",
    );
    await expect(
      store.get("native-key", { ...remoteContext, spaceId: "space/other" }),
    ).rejects.toThrow("Invalid artifact storage path");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch an already cancelled operation", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const store = artifactStores.createArtifactStore(
      "unused-local-path",
      artifactStores.artifactStorageOptionsFromEnv(remoteEnv),
    );
    const abort = new AbortController();
    abort.abort();
    await expect(
      store.get("native-key", { ...remoteContext, signal: abort.signal }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("redacts a failed download body without changing storage providers", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`private ${remoteEnv.ARTIFACT_STORAGE_KEY}`));
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const store = artifactStores.createArtifactStore(
      "unused-local-path",
      artifactStores.artifactStorageOptionsFromEnv(remoteEnv),
    );
    await expect(store.get("native-key", remoteContext)).rejects.toThrow(
      /^Artifact storage response failed$/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("LocalArtifactStore", () => {
  it("creates artifact files with owner-only permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const store = new LocalArtifactStore(root);

    const stored = await store.put(
      { name: "private.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("private") },
      context,
    );

    const info = await stat(path.join(root, "artifacts", "space-1", stored.id));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("does not follow a replacement symlink when reading an artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const store = new LocalArtifactStore(root);
    const stored = await store.put(
      { name: "private.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("private") },
      context,
    );
    const file = path.join(root, "artifacts", "space-1", stored.id);
    const target = path.join(root, "outside.txt");
    await writeFile(target, "outside");
    await rm(file);
    await symlink(target, file);

    await expect(store.get(stored.id, context)).rejects.toThrow();
  });
});
