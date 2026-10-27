import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactPut,
  ArtifactStore,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface ArtifactStorageOptions {
  url: string;
  key: string;
  bucket: string;
}

function validateArtifactStorage(options: ArtifactStorageOptions): ArtifactStorageOptions {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new Error("ARTIFACT_STORAGE_URL must be an HTTPS project origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("ARTIFACT_STORAGE_URL must be an HTTPS project origin");
  }
  if (!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.key)) {
    throw new Error("ARTIFACT_STORAGE_KEY must be a server secret key");
  }
  if (typeof options.bucket !== "string" || !/^[A-Za-z0-9_-]+$/.test(options.bucket)) {
    throw new Error("ARTIFACT_STORAGE_BUCKET must be a single bucket name");
  }
  return { ...options, url: url.origin };
}

export function artifactStorageOptionsFromEnv(
  source: NodeJS.ProcessEnv,
): ArtifactStorageOptions | undefined {
  const values = [
    source.ARTIFACT_STORAGE_URL,
    source.ARTIFACT_STORAGE_KEY,
    source.ARTIFACT_STORAGE_BUCKET,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  const [url, key, bucket] = values;
  if (!url || !key || !bucket) {
    throw new Error(
      "ARTIFACT_STORAGE_URL, ARTIFACT_STORAGE_KEY and ARTIFACT_STORAGE_BUCKET must be configured together",
    );
  }
  return validateArtifactStorage({ url, key, bucket });
}

export function createArtifactStore(root: string, options?: ArtifactStorageOptions): ArtifactStore {
  return options
    ? new VolumeFallbackArtifactStore(
        new SupabaseArtifactStore(options),
        new LocalArtifactStore(root),
      )
    : new LocalArtifactStore(root);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Object storage for new files, with files saved on the local volume before object storage was
 * configured still readable until copyLocalArtifacts has moved them.
 */
export class VolumeFallbackArtifactStore implements ArtifactStore {
  constructor(
    private readonly remote: SupabaseArtifactStore,
    private readonly local: LocalArtifactStore,
  ) {}

  describe() {
    return this.remote.describe();
  }

  put(artifact: ArtifactPut, context: AdapterContext) {
    return this.remote.put(artifact, context);
  }

  async get(id: string, context: AdapterContext) {
    try {
      return await this.local.get(id, context);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return this.remote.get(id, context);
  }

  async remove(id: string, context: AdapterContext) {
    await this.remote.remove(id, context);
    await this.local.remove(id, context);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Copies every file under <root>/artifacts/<spaceId>/<id> to object storage under the same key.
 * Each copy is read back and compared by SHA-256. Rerunning is safe: an object that already
 * exists is overwritten with the same bytes. Local files are left in place.
 */
export async function copyLocalArtifacts(
  root: string,
  remote: SupabaseArtifactStore,
  signal: AbortSignal,
): Promise<{ copied: number; bytes: number }> {
  const base = path.join(root, "artifacts");
  let spaces: string[];
  try {
    spaces = await readdir(base);
  } catch (error) {
    if (isMissingFile(error)) return { copied: 0, bytes: 0 };
    throw error;
  }
  const local = new LocalArtifactStore(root);
  let copied = 0;
  let bytes = 0;
  for (const spaceId of spaces) {
    for (const id of await readdir(path.join(base, spaceId))) {
      const context = {
        spaceId,
        operationId: "artifact-copy",
        traceId: "artifact-copy",
        signal,
      } as AdapterContext;
      const data = await local.get(id, context);
      await remote.upload(id, data, "application/octet-stream", context, { overwrite: true });
      if (sha256(await remote.get(id, context)) !== sha256(data)) {
        throw new Error(`Copied artifact ${spaceId}/${id} does not match the local file`);
      }
      copied += 1;
      bytes += data.byteLength;
    }
  }
  return { copied, bytes };
}

export class SupabaseArtifactStore implements ArtifactStore {
  private readonly options: ArtifactStorageOptions;

  constructor(options: ArtifactStorageOptions) {
    this.options = validateArtifactStorage(options);
  }

  describe() {
    return {
      id: "supabase-artifacts",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { stream: true },
    };
  }

  private objectKey(id: string, context: AdapterContext) {
    if (
      ![context.spaceId, id].every(
        (part) => typeof part === "string" && /^[A-Za-z0-9_-]+$/.test(part),
      )
    ) {
      throw new Error("Invalid artifact storage path");
    }
    return `${context.spaceId}/${id}`;
  }

  private async request(
    pathname: string,
    signal: AbortSignal,
    init: RequestInit,
    options: { missingOk?: boolean } = {},
  ): Promise<Response | null> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`${this.options.url}/storage/v1/object/${pathname}`, {
        ...init,
        headers: { ...init.headers, apikey: this.options.key },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      signal.throwIfAborted();
      throw new Error("Artifact storage request failed");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Storage answers a missing object with 404, or with 400 and a not_found body.
      if (
        options.missingOk &&
        (response.status === 404 || (response.status === 400 && /not.?found/i.test(body)))
      ) {
        return null;
      }
      throw new Error(`Artifact storage request failed (${response.status})`);
    }
    return response;
  }

  /** Writes one object under a raw key (path segments of letters, digits, `_`, `-` and `.`). */
  async putObject(
    key: string,
    bytes: Uint8Array,
    signal: AbortSignal,
    mimeType = "application/octet-stream",
  ) {
    const response = await this.request(`${this.options.bucket}/${checkObjectKey(key)}`, signal, {
      method: "POST",
      headers: { "content-type": mimeType, "x-upsert": "true" },
      body: new Uint8Array(bytes),
    });
    await response?.body?.cancel().catch(() => {});
  }

  /** Reads one object, or null when it does not exist. */
  async getObject(key: string, signal: AbortSignal): Promise<Uint8Array | null> {
    const response = await this.request(
      `authenticated/${this.options.bucket}/${checkObjectKey(key)}`,
      signal,
      { method: "GET" },
      { missingOk: true },
    );
    if (!response) return null;
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      signal.throwIfAborted();
      throw new Error("Artifact storage response failed");
    }
  }

  async removeObjects(keys: string[], signal: AbortSignal) {
    if (keys.length === 0) return;
    const response = await this.request(this.options.bucket, signal, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefixes: keys.map(checkObjectKey) }),
    });
    await response?.body?.cancel().catch(() => {});
  }

  async put(artifact: ArtifactPut, context: AdapterContext) {
    const id = randomUUID();
    await this.upload(id, artifact.bytes, artifact.mimeType, context);
    return { id, hash: String(artifact.bytes.byteLength) };
  }

  async upload(
    id: string,
    bytes: Uint8Array,
    mimeType: string,
    context: AdapterContext,
    options: { overwrite?: boolean } = {},
  ) {
    const key = this.objectKey(id, context);
    const response = await this.request(`${this.options.bucket}/${key}`, context.signal, {
      method: "POST",
      headers: { "content-type": mimeType, "x-upsert": options.overwrite ? "true" : "false" },
      body: new Uint8Array(bytes),
    });
    await response?.body?.cancel().catch(() => {});
  }

  async get(id: string, context: AdapterContext) {
    const key = this.objectKey(id, context);
    const response = await this.request(
      `authenticated/${this.options.bucket}/${key}`,
      context.signal,
      { method: "GET" },
    );
    try {
      return new Uint8Array(await response!.arrayBuffer());
    } catch {
      context.signal.throwIfAborted();
      throw new Error("Artifact storage response failed");
    }
  }

  async remove(id: string, context: AdapterContext) {
    await this.removeObjects([this.objectKey(id, context)], context.signal);
  }
}

function checkObjectKey(key: string) {
  const segments = key.split("/");
  if (!segments.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && !/^\.+$/.test(part))) {
    throw new Error("Invalid artifact storage path");
  }
  return key;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  describe() {
    return {
      id: "local-artifacts",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { stream: true },
    };
  }

  async put(artifact: ArtifactPut, context: AdapterContext) {
    const id = randomUUID();
    const dir = path.join(this.root, "artifacts", context.spaceId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, id);
    const handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(artifact.bytes);
    } finally {
      await handle.close();
    }
    return { id, hash: String(artifact.bytes.byteLength) };
  }

  async get(id: string, context: AdapterContext) {
    const handle = await open(
      path.join(this.root, "artifacts", context.spaceId, id),
      constants.O_RDONLY | O_NOFOLLOW,
    );
    try {
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  async remove(id: string, context: AdapterContext) {
    await rm(path.join(this.root, "artifacts", context.spaceId, id), { force: true });
  }
}

export class CapturingNotificationProvider implements NotificationProvider {
  readonly sent: NotificationMessage[] = [];

  describe() {
    return {
      id: "capturing",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { push: false, email: false },
    };
  }

  async send(message: NotificationMessage, _context: AdapterContext): Promise<void> {
    this.sent.push(message);
  }
}
