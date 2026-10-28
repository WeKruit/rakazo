import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { parseScreenLeaseId } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import type { HomeSnapshotStore } from "./home-replicated.js";
import { unpackSnapshot } from "./home-replicated.js";

export const PENDING_HOME_REVISION = "v2:pending";
export const HOME_REVISION = /^v2:([1-9][0-9]{0,14}):([0-9a-f]{64})$/;
export function authoritativeRevision(revision: string) {
  return HOME_REVISION.test(revision);
}
export function snapshotDigest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function homeSnapshotKey(homeKey: string, revision: string) {
  if (!authoritativeRevision(revision)) throw new Error("Invalid authoritative revision");
  return `home-snapshots-v2/${Buffer.from(homeKey).toString("base64url")}/${revision}`;
}
export function nextHomeRevision(previous: string, bytes: Uint8Array) {
  const match = HOME_REVISION.exec(previous);
  const generation = match ? BigInt(match[1]!) + 1n : 1n;
  if (generation > 999999999999999n) throw new Error("Home revision generation exhausted");
  return `v2:${generation}:${snapshotDigest(bytes)}`;
}
export function verifyHomeSnapshot(revision: string, bytes: Uint8Array) {
  const match = HOME_REVISION.exec(revision);
  if (!match || snapshotDigest(bytes) !== match[2])
    throw new Error("Home snapshot digest mismatch");
}

async function assertScope(
  tx: Pick<Prisma.TransactionClient, "spaceMember">,
  computer: { spaceId: string; userId: string; scope: string },
  context: AdapterContext,
) {
  if (
    computer.spaceId !== context.spaceId ||
    (computer.scope !== "team" && computer.userId !== context.userId)
  )
    throw new Error("Home publication scope mismatch");
  if (
    computer.scope === "team" &&
    (await tx.spaceMember.count({
      where: { spaceId: context.spaceId, userId: context.userId },
    })) !== 1
  )
    throw new Error("Home publication requires current Space membership");
}

async function assertOwner(
  tx: Prisma.TransactionClient,
  computer: {
    id: string;
    spaceId: string;
    userId: string;
    maintenanceId: string | null;
    scope: string;
    state: string;
    providerRef: string | null;
    updatedAt: Date;
  },
  context: AdapterContext,
  source?: "stored-edit",
) {
  context.signal.throwIfAborted();
  await assertScope(tx, computer, context);
  const operation = await tx.computerUpdate.findUnique({ where: { id: context.operationId } });
  if (computer.maintenanceId && computer.maintenanceId !== context.operationId)
    throw new Error("Home is reserved by another operation");
  if (
    operation &&
    (operation.computerId !== computer.id ||
      operation.status !== "running" ||
      computer.maintenanceId !== operation.id)
  )
    throw new Error("Home publication owner is stale");
  const lifecycle = context.homeLifecycleClaim;
  if (
    lifecycle &&
    (lifecycle.computerId !== computer.id ||
      computer.state !== "suspending" ||
      lifecycle.providerRef !== computer.providerRef ||
      lifecycle.updatedAt.getTime() !== computer.updatedAt.getTime())
  )
    throw new Error("Home lifecycle publication claim is stale");
  if (!operation && !context.runId && !lifecycle && source !== "stored-edit")
    throw new Error("Checkpoint publication requires an active maintenance or run owner");
  if (context.runId && !operation) {
    const lease = context.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : undefined;
    if (!lease || lease.ownerId !== context.runId || !context.botId)
      throw new Error("Run home publication requires an execution fence");
    const now = new Date();
    const valid =
      computer.scope === "team"
        ? await tx.computerExecutionLease.count({
            where: {
              computerId: computer.id,
              botId: context.botId,
              runId: context.runId,
              fence: lease.fence,
              expiresAt: { gt: now },
            },
          })
        : await tx.run.count({
            where: {
              id: context.runId,
              spaceId: context.spaceId,
              userId: context.userId,
              botId: context.botId,
              status: "running",
              leaseFence: lease.fence,
              leaseExpiresAt: { gt: now },
            },
          });
    if (valid !== 1) throw new Error("Run home publication fence is stale");
  }
}

export function homeAuthority(prisma: PrismaClient) {
  return {
    async read(homeKey: string, context?: AdapterContext) {
      const row = await prisma.computer.findUniqueOrThrow({ where: { homeKey } });
      if (context) await assertScope(prisma, row, context);
      return row.homeRevision;
    },
    async initialize(homeKey: string, revision: string, context: AdapterContext) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM computers WHERE "homeKey" = ${homeKey} FOR UPDATE`;
        const row = await tx.computer.findUniqueOrThrow({ where: { homeKey } });
        await assertScope(tx, row, context);
        context.signal.throwIfAborted();
        if (authoritativeRevision(row.homeRevision)) return;
        if (row.homeRevision !== PENDING_HOME_REVISION)
          throw new Error("Home is not a newly reserved authoritative home");
        await tx.computer.update({
          where: { id: row.id },
          data: { homeRevision: revision, updatedAt: row.updatedAt },
        });
      });
    },
    async publish(
      homeKey: string,
      expected: string,
      revision: string,
      context: AdapterContext,
      source?: "stored-edit",
    ) {
      if (!authoritativeRevision(expected) || !authoritativeRevision(revision))
        throw new Error("Home is not activated");
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM computers WHERE "homeKey" = ${homeKey} FOR UPDATE`;
        const row = await tx.computer.findUniqueOrThrow({ where: { homeKey } });
        await assertOwner(tx, row, context, source);
        const changed = await tx.computer.updateMany({
          where: { id: row.id, homeRevision: expected },
          data: { homeRevision: revision, updatedAt: row.updatedAt },
        });
        if (changed.count !== 1) throw new Error("Home revision conflict; refresh before retry");
        context.signal.throwIfAborted();
      });
    },
  };
}

export type HomeMigrationEntry = {
  computerId: string;
  homeKey: string;
  spaceId: string;
  userId: string;
  expectedRevision: string;
  legacyRevision: string;
  digest: string;
  bytes: number;
};

/** Inventory is not approval. Activation re-reads every object and row instead of trusting fields. */
export async function inspectHomeMigration(
  prisma: PrismaClient,
  objects: HomeSnapshotStore,
  signal: AbortSignal,
): Promise<HomeMigrationEntry[]> {
  if (await prisma.homeAuthorityCutover.count()) throw new Error("Home cutover already completed");
  const entries: HomeMigrationEntry[] = [];
  for (const row of await prisma.computer.findMany({ orderBy: { id: "asc" } })) {
    if (authoritativeRevision(row.homeRevision)) continue;
    if (["docker", "desktop"].includes(row.kind))
      throw new Error(
        "Local Docker/desktop homes require a separate cutover; no implicit cache conversion",
      );
    const prefix = `agent-homes/${Buffer.from(row.homeKey).toString("base64url")}`;
    const pointer = await objects.getObject(`${prefix}/current`, signal);
    const legacyRevision = pointer ? new TextDecoder().decode(pointer) : "";
    if (!/^[A-Za-z0-9_-]+$/.test(legacyRevision))
      throw new Error("Legacy home pointer missing or invalid");
    const bytes = await objects.getObject(`${prefix}/${legacyRevision}`, signal);
    if (!bytes) throw new Error("Legacy home snapshot missing");
    entries.push({
      computerId: row.id,
      homeKey: row.homeKey,
      spaceId: row.spaceId,
      userId: row.userId,
      expectedRevision: row.homeRevision,
      legacyRevision,
      digest: snapshotDigest(bytes),
      bytes: bytes.byteLength,
    });
  }
  return entries;
}

/** The deployment driver must stop every legacy API/worker writer and fence restarts,
 * including new containers, for the complete callback. It must keep legacy writers
 * stopped after success OR failure; resuming requires the upgraded deployment.
 * A database lease or a stopped Computer row alone cannot provide this guarantee.
 * No production driver is supplied: deployment integration must establish this boundary.
 */
export interface HomeCutoverDriver {
  withStoppedLegacyWriters<T>(
    activate: (assertStopped: () => Promise<void>) => Promise<T>,
  ): Promise<T>;
}

/** One short atomic activation transaction after all snapshots are uploaded and verified.
 * Old revision writers are rejected by the database trigger after commit. Legacy deletion
 * cannot affect the independent immutable namespace. No flag or unverified receipt activates it.
 */
export async function activateHomeMigration(
  prisma: PrismaClient,
  objects: HomeSnapshotStore,
  manifest: readonly HomeMigrationEntry[],
  signal: AbortSignal,
  driver: HomeCutoverDriver,
) {
  return driver.withStoppedLegacyWriters(async (assertStopped) => {
    await assertStopped();
    if (new Set(manifest.map((entry) => entry.homeKey)).size !== manifest.length)
      throw new Error("Duplicate migration home");
    const revisions = new Map<string, string>();
    for (const entry of manifest) {
      signal.throwIfAborted();
      const prefix = `agent-homes/${Buffer.from(entry.homeKey).toString("base64url")}`;
      const pointer = await objects.getObject(`${prefix}/current`, signal);
      if (!pointer || new TextDecoder().decode(pointer) !== entry.legacyRevision)
        throw new Error("Legacy pointer changed during migration");
      const bytes = await objects.getObject(`${prefix}/${entry.legacyRevision}`, signal);
      if (!bytes || snapshotDigest(bytes) !== entry.digest || bytes.byteLength !== entry.bytes)
        throw new Error("Migration snapshot integrity mismatch");
      const staging = await mkdtemp(join(tmpdir(), "rakazo-home-migration-"));
      try {
        await unpackSnapshot(bytes, staging);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      const revision = nextHomeRevision("empty", bytes);
      const key = homeSnapshotKey(entry.homeKey, revision);
      await objects.putObject(key, bytes, signal);
      const copied = await objects.getObject(key, signal);
      if (!copied) throw new Error("Migration snapshot readback missing");
      verifyHomeSnapshot(revision, copied);
      revisions.set(entry.homeKey, revision);
    }
    await assertStopped();
    await prisma.$transaction(
      async (tx) => {
        // Prevent new legacy computers from appearing between complete inventory and activation.
        await tx.$executeRaw`LOCK TABLE computers IN SHARE ROW EXCLUSIVE MODE`;
        const rows = await tx.computer.findMany({ orderBy: { id: "asc" } });
        const pending = rows.filter((row) => !authoritativeRevision(row.homeRevision));
        if (pending.length !== manifest.length)
          throw new Error("Migration manifest is incomplete or stale");
        for (const row of pending) {
          const entry = manifest.find(
            (item) => item.computerId === row.id && item.homeKey === row.homeKey,
          );
          if (
            !entry ||
            row.userId !== entry.userId ||
            row.spaceId !== entry.spaceId ||
            row.homeRevision !== entry.expectedRevision ||
            ["docker", "desktop"].includes(row.kind)
          )
            throw new Error("Migration identity or revision changed");
          if (row.maintenanceId || !["stopped", "suspended"].includes(row.state))
            throw new Error(
              "Migration requires stopped or suspended computers without maintenance",
            );
          if (
            await tx.computerExecutionLease.count({
              where: { computerId: row.id, expiresAt: { gt: new Date() } },
            })
          )
            throw new Error("Migration has live computer execution leases");
          if (
            await tx.run.count({
              where: { spaceId: row.spaceId, status: { in: ["running", "queued"] } },
            })
          )
            throw new Error("Migration has active or queued runs");
          await tx.computer.update({
            where: { id: row.id },
            data: { homeRevision: revisions.get(row.homeKey)!, updatedAt: row.updatedAt },
          });
        }
        await tx.homeAuthorityCutover.create({
          data: {
            id: "verified",
            manifestDigest: snapshotDigest(new TextEncoder().encode(JSON.stringify(manifest))),
          },
        });
        signal.throwIfAborted();
      },
      { timeout: 30_000 },
    );
    return revisions;
  });
}
