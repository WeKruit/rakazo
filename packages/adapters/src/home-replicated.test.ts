import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAgentHomeStore } from "./home.js";
import type { HomeSnapshotStore } from "./home-replicated.js";
import { ReplicatedAgentHomeStore, unpackSnapshot } from "./home-replicated.js";

const context = {
  spaceId: "space",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
} as AdapterContext;

class MemoryObjects implements HomeSnapshotStore {
  readonly objects = new Map<string, Uint8Array>();
  failPuts = false;

  async getObject(key: string) {
    return this.objects.get(key) ?? null;
  }

  async putObject(key: string, bytes: Uint8Array) {
    if (this.failPuts) throw new Error("storage down");
    this.objects.set(key, bytes);
  }

  async removeObjects(keys: string[]) {
    for (const key of keys) this.objects.delete(key);
  }
}

const roots: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-replicated-home-"));
  roots.push(dir);
  return dir;
}

/** Two containers: separate disks, one bucket. */
async function twoContainers() {
  const objects = new MemoryObjects();
  const a = new ReplicatedAgentHomeStore(await tempDir(), objects);
  const b = new ReplicatedAgentHomeStore(await tempDir(), objects);
  return { objects, a, b };
}

async function workspace(files: Record<string, string>) {
  const dir = await tempDir();
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ReplicatedAgentHomeStore", () => {
  it("shows a commit from one container to another, hidden and executable files included", async () => {
    const { a, b } = await twoContainers();
    const src = await workspace({ "notes.md": "hello", ".config/app.json": "{}", "bin/run": "#!" });
    await chmod(path.join(src, "bin/run"), 0o755);
    await a.commit("team-1", src, context);

    const dest = await tempDir();
    await b.checkout("team-1", dest, context);
    expect(await readFile(path.join(dest, "notes.md"), "utf8")).toBe("hello");
    expect(await readFile(path.join(dest, ".config/app.json"), "utf8")).toBe("{}");
    expect((await stat(path.join(dest, "bin/run"))).mode & 0o100).toBeTruthy();
    expect(await b.readFile("team-1", "notes.md", context)).toBe("hello");
  });

  it("replaces a stale local copy with the newer one", async () => {
    const { a, b } = await twoContainers();
    await a.commit("team-1", await workspace({ "a.txt": "1", "gone.txt": "x" }), context);
    expect(await b.readFile("team-1", "a.txt", context)).toBe("1");

    await a.commit("team-1", await workspace({ "a.txt": "2" }), context);
    expect(await b.readFile("team-1", "a.txt", context)).toBe("2");
    expect((await b.list("team-1", "", context)).map((entry) => entry.path)).toEqual(["a.txt"]);

    await b.writeFile("team-1", "a.txt", "3", context);
    expect(await a.readFile("team-1", "a.txt", context)).toBe("3");
  });

  it("keeps one snapshot per home in storage", async () => {
    const { objects, a } = await twoContainers();
    for (const value of ["1", "2", "3"]) {
      await a.commit("team-1", await workspace({ "a.txt": value }), context);
    }
    expect(objects.objects.size).toBe(2);
  });

  it("publishes a home saved on the volume before replication was turned on", async () => {
    const objects = new MemoryObjects();
    const root = await tempDir();
    await new LocalAgentHomeStore(root).commit(
      "bot-1",
      await workspace({ "old.md": "kept" }),
      context,
    );

    const a = new ReplicatedAgentHomeStore(root, objects);
    expect(await a.readFile("bot-1", "old.md", context)).toBe("kept");
    const b = new ReplicatedAgentHomeStore(await tempDir(), objects);
    expect(await b.readFile("bot-1", "old.md", context)).toBe("kept");
  });

  it("copies every home on the volume to storage in one pass", async () => {
    const objects = new MemoryObjects();
    const root = await tempDir();
    const local = new LocalAgentHomeStore(root);
    await local.commit("bot-1", await workspace({ "a.md": "1" }), context);
    await local.commit("team-2", await workspace({ "b.md": "2" }), context);

    expect(
      await new ReplicatedAgentHomeStore(root, objects).publishLocalHomes(context.signal),
    ).toBe(2);
    const other = new ReplicatedAgentHomeStore(await tempDir(), objects);
    expect(await other.readFile("bot-1", "a.md", context)).toBe("1");
    expect(await other.readFile("team-2", "b.md", context)).toBe("2");
    expect(
      await new ReplicatedAgentHomeStore(root, objects).publishLocalHomes(context.signal),
    ).toBe(0);
  });

  it("publishes server-side cleanup so other containers do not bring the folder back", async () => {
    const { a, b } = await twoContainers();
    await a.commit("team-1", await workspace({ "bots/x/file": "1", "keep.md": "k" }), context);
    expect(await b.readFile("team-1", "bots/x/file", context)).toBe("1");

    await a.editStored(
      "team-1",
      (dir) => rm(path.join(dir, "bots/x"), { recursive: true, force: true }),
      context,
    );
    // Snapshots carry files only, like the exports sandboxes restore from.
    expect((await b.list("team-1", "", context)).map((entry) => entry.path)).toEqual(["keep.md"]);
    await expect(b.readFile("team-1", "bots/x/file", context)).rejects.toThrow();
  });

  it("fails a commit that cannot be stored without reverting the local copy", async () => {
    const { objects, a } = await twoContainers();
    await a.commit("team-1", await workspace({ "a.txt": "1" }), context);
    objects.failPuts = true;
    await expect(a.commit("team-1", await workspace({ "a.txt": "2" }), context)).rejects.toThrow(
      "storage down",
    );
    objects.failPuts = false;
    expect(await a.readFile("team-1", "a.txt", context)).toBe("2");
  });

  it("refuses snapshot paths that leave the home", async () => {
    const header = Buffer.from(JSON.stringify({ path: "../escape", size: 1, x: false }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.byteLength);
    const snapshot = gzipSync(Buffer.concat([length, header, Buffer.from("x")]));
    await expect(unpackSnapshot(snapshot, await tempDir())).rejects.toThrow();
  });
});
