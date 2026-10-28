import { rm } from "node:fs/promises";
import type { AdapterContext, PortableFile } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { LocalAgentHomeStore } from "./home.js";
import {
  authoritativeRevision,
  homeAuthority,
  homeSnapshotKey,
  nextHomeRevision,
  PENDING_HOME_REVISION,
  verifyHomeSnapshot,
} from "./home-authority.js";
import { type HomeSnapshotStore, packSnapshot, unpackSnapshot } from "./home-replicated.js";

/** Local directories are disposable caches. Only a verified DB revision publishes content. */
export class AuthoritativeAgentHomeStore extends LocalAgentHomeStore {
  protected override readonly replicated = true;
  private readonly authority;
  constructor(
    root: string,
    private readonly remote: HomeSnapshotStore,
    prisma: PrismaClient,
  ) {
    super(root);
    this.authority = homeAuthority(prisma);
  }
  override describe() {
    return { ...super.describe(), id: "postgres-snapshot-home", capabilities: { revisions: true } };
  }
  async initialize(homeKey: string, context: AdapterContext) {
    // Only the database INSERT trigger creates this reservation after complete cutover.
    if ((await this.authority.read(homeKey, context)) !== PENDING_HOME_REVISION) return;
    const bytes = await packSnapshot((async function* (): AsyncIterable<PortableFile> {})());
    const revision = nextHomeRevision("empty", bytes);
    const key = homeSnapshotKey(homeKey, revision);
    await this.remote.putObject(key, bytes, context.signal);
    const copied = await this.remote.getObject(key, context.signal);
    if (!copied) throw new Error("Initial home snapshot readback missing");
    verifyHomeSnapshot(revision, copied);
    await this.authority.initialize(homeKey, revision, context);
  }

  async captureRevision(homeKey: string, context: AdapterContext) {
    await this.refresh(homeKey, context);
    const revision = await this.readRevision(homeKey);
    if (!revision || !authoritativeRevision(revision))
      throw new Error("Home has no authoritative revision");
    return revision;
  }
  protected override async refresh(
    homeKey: string,
    context: Pick<AdapterContext, "signal"> & Partial<AdapterContext>,
  ) {
    if (!context.userId || !context.spaceId)
      throw new Error("Authoritative home requires caller scope");
    await this.withBotWrite(homeKey, async () => {
      context.signal.throwIfAborted();
      const revision = await this.authority.read(homeKey, context as AdapterContext);
      if (!authoritativeRevision(revision)) throw new Error("Home has not been migrated");
      if ((await this.readRevision(homeKey)) === revision) return;
      const bytes = await this.remote.getObject(homeSnapshotKey(homeKey, revision), context.signal);
      if (!bytes) throw new Error("Authoritative snapshot missing; legacy fallback is forbidden");
      verifyHomeSnapshot(revision, bytes);
      const staging = await this.stagingDir(homeKey);
      try {
        await unpackSnapshot(bytes, staging);
        await this.replaceLocal(homeKey, staging);
        await this.writeRevision(homeKey, revision);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }
  protected override async finishWrite(
    homeKey: string,
    context: (Pick<AdapterContext, "signal"> & Partial<AdapterContext>) | undefined,
    expectedRevision?: string,
    source?: "stored-edit",
  ) {
    if (!context?.userId || !context.spaceId || !context.operationId)
      throw new Error("Authoritative write requires caller context");
    const expected = expectedRevision ?? (await this.readRevision(homeKey));
    if (!expected || !authoritativeRevision(expected))
      throw new Error("Capture a current home revision before writing");
    try {
      context.signal.throwIfAborted();
      const bytes = await packSnapshot(this.exportLocal(homeKey));
      const next = nextHomeRevision(expected, bytes);
      await this.remote.putObject(homeSnapshotKey(homeKey, next), bytes, context.signal);
      const readback = await this.remote.getObject(homeSnapshotKey(homeKey, next), context.signal);
      if (!readback) throw new Error("Home snapshot readback missing");
      verifyHomeSnapshot(next, readback);
      await this.authority.publish(homeKey, expected, next, context as AdapterContext, source);
      await this.writeRevision(homeKey, next);
      return next;
    } catch (error) {
      // A failed publication may have changed cache bytes. Never return them as committed data.
      await this.writeRevision(homeKey, "invalid");
      throw error;
    }
  }
}

/** Choose from persisted authority on every operation, never from a deployment flag. */
export class MigratingAgentHomeStore extends LocalAgentHomeStore {
  private readonly authoritative: AuthoritativeAgentHomeStore;
  private readonly authority;
  constructor(
    root: string,
    private readonly legacy: LocalAgentHomeStore,
    remote: HomeSnapshotStore,
    prisma: PrismaClient,
  ) {
    super(root);
    this.authoritative = new AuthoritativeAgentHomeStore(`${root}/authority-v2`, remote, prisma);
    this.authority = homeAuthority(prisma);
  }
  private async selected(key: string, context?: AdapterContext) {
    const revision = await this.authority.read(key, context);
    if (revision === PENDING_HOME_REVISION) {
      if (!context) throw new Error("New authoritative home requires caller scope");
      await this.authoritative.initialize(key, context);
      return this.authoritative;
    }
    return authoritativeRevision(revision) ? this.authoritative : this.legacy;
  }
  override describe() {
    return { ...this.legacy.describe(), id: "migrating-home" };
  }
  override pathFor(key: string) {
    return this.legacy.pathFor(key);
  }
  async captureRevision(key: string, context: AdapterContext) {
    const store = await this.selected(key, context);
    return store instanceof AuthoritativeAgentHomeStore
      ? store.captureRevision(key, context)
      : undefined;
  }
  override async checkout(key: string, dest: string, context: AdapterContext) {
    return (await this.selected(key, context)).checkout(key, dest, context);
  }
  override async commit(key: string, src: string, context: AdapterContext, expected?: string) {
    return (await this.selected(key, context)).commit(key, src, context, expected);
  }
  override async restore(key: string, revision: string, dest: string, context: AdapterContext) {
    return (await this.selected(key, context)).restore(key, revision, dest, context);
  }
  override async *exportHome(
    key: string,
    context: AdapterContext,
    options?: { directory?: string; skipHidden?: boolean },
  ): AsyncIterable<PortableFile> {
    yield* (await this.selected(key, context)).exportHome(key, context, options);
  }
  override async readFile(
    key: string,
    file: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    return (await this.selected(key, context)).readFile(key, file, context, options);
  }
  override async writeFile(key: string, file: string, content: string, context: AdapterContext) {
    return (await this.selected(key, context)).writeFile(key, file, content, context);
  }
  override async list(key: string, dir: string, context: AdapterContext) {
    return (await this.selected(key, context)).list(key, dir, context);
  }
  override async editStored(
    key: string,
    edit: (dir: string) => Promise<void>,
    context?: AdapterContext,
  ) {
    return (await this.selected(key, context)).editStored(key, edit, context);
  }
  override async revise(key: string, context?: AdapterContext) {
    return (await this.selected(key, context)).revise(key, context);
  }
}
