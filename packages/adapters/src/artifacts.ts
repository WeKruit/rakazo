import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
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
  return options ? new SupabaseArtifactStore(options) : new LocalArtifactStore(root);
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

  private async request(pathname: string, context: AdapterContext, init: RequestInit) {
    context.signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`${this.options.url}/storage/v1/object/${pathname}`, {
        ...init,
        headers: { ...init.headers, apikey: this.options.key },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      context.signal.throwIfAborted();
      throw new Error("Artifact storage request failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Artifact storage request failed (${response.status})`);
    }
    return response;
  }

  async put(artifact: ArtifactPut, context: AdapterContext) {
    const id = randomUUID();
    const key = this.objectKey(id, context);
    const response = await this.request(`${this.options.bucket}/${key}`, context, {
      method: "POST",
      headers: { "content-type": artifact.mimeType, "x-upsert": "false" },
      body: new Uint8Array(artifact.bytes),
    });
    await response.body?.cancel().catch(() => {});
    return { id, hash: String(artifact.bytes.byteLength) };
  }

  async get(id: string, context: AdapterContext) {
    const key = this.objectKey(id, context);
    const response = await this.request(`authenticated/${this.options.bucket}/${key}`, context, {
      method: "GET",
    });
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      context.signal.throwIfAborted();
      throw new Error("Artifact storage response failed");
    }
  }

  async remove(id: string, context: AdapterContext) {
    const key = this.objectKey(id, context);
    const response = await this.request(this.options.bucket, context, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefixes: [key] }),
    });
    await response.body?.cancel().catch(() => {});
  }
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
