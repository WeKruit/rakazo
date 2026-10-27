import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AdapterContext, PortableFile } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { ArtifactStorageOptions } from "./artifacts.js";
import { SupabaseArtifactStore } from "./artifacts.js";
import { writePortableFile } from "./computer-workspace.js";
import { LocalAgentHomeStore } from "./home.js";

/** The object storage calls a replicated home needs; SupabaseArtifactStore provides them. */
export interface HomeSnapshotStore {
  getObject(key: string, signal: AbortSignal): Promise<Uint8Array | null>;
  putObject(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  removeObjects(keys: string[], signal: AbortSignal): Promise<void>;
}

const PUBLISH_TIMEOUT_MS = 120_000;

/** Homes on the volume, replicated to object storage when it is configured. */
export function createAgentHomeStore(
  root: string,
  storage?: ArtifactStorageOptions,
): LocalAgentHomeStore {
  return storage
    ? new ReplicatedAgentHomeStore(root, new SupabaseArtifactStore(storage))
    : new LocalAgentHomeStore(root);
}

/**
 * Agent homes kept on local disk as a cache, with every write published to object storage as one
 * snapshot. Before each read the local copy is compared with the stored revision and replaced
 * when another container has written a newer one, so every container sees the same home.
 *
 * Objects: agent-homes/<key>/current holds the revision; agent-homes/<key>/<revision> holds the
 * gzipped files. A home already on the volume is published the first time it is read.
 */
export class ReplicatedAgentHomeStore extends LocalAgentHomeStore {
  protected override readonly replicated = true;

  constructor(
    root: string,
    private readonly remote: HomeSnapshotStore,
  ) {
    super(root);
  }

  override describe() {
    return { ...super.describe(), id: "replicated-fs" };
  }

  protected override async refresh(
    botId: string,
    context: Pick<AdapterContext, "signal">,
  ): Promise<void> {
    await this.waitForBotWrite(botId);
    const [remote, local] = await Promise.all([
      this.remoteRevision(botId, context.signal),
      this.readRevision(botId),
    ]);
    if (remote === local) return;
    await this.withBotWrite(botId, () => this.sync(botId, context.signal));
  }

  protected override async publish(
    botId: string,
    revision: string,
    context: Pick<AdapterContext, "signal"> | undefined,
  ): Promise<void> {
    const signal = context?.signal
      ? AbortSignal.any([context.signal, AbortSignal.timeout(PUBLISH_TIMEOUT_MS)])
      : AbortSignal.timeout(PUBLISH_TIMEOUT_MS);
    const previous = await this.remoteRevision(botId, signal);
    const snapshot = await packSnapshot(this.exportLocal(botId));
    await this.remote.putObject(this.snapshotKey(botId, revision), snapshot, signal);
    await this.remote.putObject(this.pointerKey(botId), new TextEncoder().encode(revision), signal);
    if (previous && previous !== revision) {
      await this.remote
        .removeObjects([this.snapshotKey(botId, previous)], signal)
        .catch((error: unknown) =>
          getLogger().warn("home snapshot cleanup", { error: String(error) }),
        );
    }
  }

  /**
   * Publishes every home on the local volume that storage does not have yet, for moving off the
   * volume. Homes storage already has are brought up to date locally instead.
   */
  async publishLocalHomes(signal: AbortSignal): Promise<number> {
    const names = await readdir(path.join(this.root, "homes"), { withFileTypes: true }).catch(
      () => [],
    );
    let published = 0;
    for (const entry of names) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.endsWith(".previous"))
        continue;
      const botId = entry.name;
      if ((await this.remoteRevision(botId, signal)) === null) {
        await this.withBotWrite(botId, () => this.finishWrite(botId, { signal }));
        published++;
      } else {
        await this.refresh(botId, { signal });
      }
    }
    return published;
  }

  /** Runs inside the home's write lock. */
  private async sync(botId: string, signal: AbortSignal) {
    // A snapshot can be replaced between reading the pointer and reading the snapshot.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [remote, local] = await Promise.all([
        this.remoteRevision(botId, signal),
        this.readRevision(botId),
      ]);
      if (remote === local) return;
      await this.recoverInterruptedCommit(botId);
      if (remote === null) {
        // Saved before replication was configured: publish the volume copy once.
        await this.finishWrite(botId, { signal });
        return;
      }
      const snapshot = await this.remote.getObject(this.snapshotKey(botId, remote), signal);
      if (!snapshot) continue;
      const staging = await this.stagingDir(botId);
      try {
        await unpackSnapshot(snapshot, staging);
        await this.replaceLocal(botId, staging);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      await this.writeRevision(botId, remote);
      return;
    }
    throw new Error("Stored home snapshot changed while it was being read");
  }

  private async remoteRevision(botId: string, signal: AbortSignal) {
    const bytes = await this.remote.getObject(this.pointerKey(botId), signal);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  private prefix(botId: string) {
    this.botDir(botId);
    return `agent-homes/${Buffer.from(botId).toString("base64url")}`;
  }

  private pointerKey(botId: string) {
    return `${this.prefix(botId)}/current`;
  }

  private snapshotKey(botId: string, revision: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(revision)) throw new Error("Invalid home revision");
    return `${this.prefix(botId)}/${revision}`;
  }
}

/** Each file is a 4-byte header length, a JSON header, then the file bytes; all gzipped. */
export async function packSnapshot(files: AsyncIterable<PortableFile>): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const file of files) {
    const header = Buffer.from(
      JSON.stringify({ path: file.path, size: file.content.byteLength, x: file.executable }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.byteLength);
    parts.push(length, header, Buffer.from(file.content));
  }
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

export async function unpackSnapshot(snapshot: Uint8Array, dest: string): Promise<number> {
  const data = gunzipSync(snapshot);
  let offset = 0;
  let count = 0;
  while (offset < data.byteLength) {
    if (offset + 4 > data.byteLength) throw new Error("Home snapshot is truncated");
    const headerLength = data.readUInt32BE(offset);
    offset += 4;
    const header = JSON.parse(data.subarray(offset, offset + headerLength).toString("utf8")) as {
      path: unknown;
      size: unknown;
      x: unknown;
    };
    offset += headerLength;
    if (
      typeof header.path !== "string" ||
      typeof header.size !== "number" ||
      !Number.isInteger(header.size) ||
      header.size < 0 ||
      offset + header.size > data.byteLength
    ) {
      throw new Error("Home snapshot is malformed");
    }
    await writePortableFile(dest, {
      path: header.path,
      content: new Uint8Array(data.subarray(offset, offset + header.size)),
      executable: header.x === true,
    });
    offset += header.size;
    count++;
  }
  return count;
}
