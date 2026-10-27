import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./client.js";

export type SessionAdmissionService = "api" | "worker-a" | "worker-b";
export type SessionAdmissionReservation = {
  token: string;
  service: SessionAdmissionService;
  instanceId: string;
  observerRole: string;
  generation: string;
  sessionApplicationName: string;
  reservedSessions: number;
  status: "active" | "closing";
};
export type SessionAdmissionTarget = Pick<SessionAdmissionReservation, "token" | "instanceId">;
/** Deployment/runtime must permanently close admission and drain every in-flight connect
 * and session owner before invoking the callback. Keep old instances stopped even on failure.
 * A zero pg_stat_activity count, boolean flag, or elapsed lease is not a stopped-instance proof.
 */
export interface StoppedSessionInstanceDriver {
  withStoppedInstance<T>(release: (assertStopped: () => Promise<void>) => Promise<T>): Promise<T>;
}
/** Slot controller keeps old work admission drained while generation CAS executes.
 * This is not a stopped-process proof; release requires the stronger driver below.
 */
export interface QuiescedSessionSlotDriver {
  withQuiescedSlot<T>(rotate: (assertQuiesced: () => Promise<void>) => Promise<T>): Promise<T>;
}
type Tx = Prisma.TransactionClient;
const lock = (tx: Tx) => tx.$queryRaw`SELECT pg_advisory_xact_lock(1963951201, 5)::text`;
function value(input: string, name: string) {
  if (!input || input.length > 128 || input.includes("\0")) throw new Error(`Invalid ${name}`);
}
async function receipt(tx: Tx) {
  const rows = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM home_authority_cutover WHERE id='verified'`;
  if (rows.length !== 1) throw new Error("Session admission requires verified home cutover");
}
async function owned(tx: Tx, target: SessionAdmissionTarget) {
  const rows = await tx.$queryRaw<
    SessionAdmissionReservation[]
  >`SELECT * FROM session_admissions WHERE token=${target.token} AND "instanceId"=${target.instanceId}`;
  if (rows.length !== 1) throw new Error("Stale session admission token");
  return rows[0]!;
}
export async function listSessionAdmissions(
  prisma: PrismaClient,
): Promise<SessionAdmissionReservation[]> {
  return prisma.$queryRaw`SELECT * FROM session_admissions ORDER BY service,"instanceId"`;
}
/** Explicit one-time system bootstrap. Changing the deployment budget needs a separate
 * reviewed operation; instances must never infer that external consumers cost zero.
 */
export async function configureSessionAdmissionBudget(
  prisma: PrismaClient,
  input: { externalReservedSessions: number },
  driver: QuiescedSessionSlotDriver,
) {
  if (
    !Number.isInteger(input.externalReservedSessions) ||
    input.externalReservedSessions < 1 ||
    input.externalReservedSessions >= 15
  )
    throw new Error("Explicit external session reserve must be between one and fourteen");
  return driver.withQuiescedSlot(async (assertQuiesced) => {
    await assertQuiesced();
    await prisma.$transaction(async (tx) => {
      await lock(tx);
      await receipt(tx);
      const rows = await tx.$queryRaw<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM session_admissions`;
      if (rows[0]?.count !== 0) throw new Error("Budget bootstrap requires no admitted instances");
      await tx.$executeRaw`INSERT INTO session_admission_budget(id,"totalSessions","externalReservedSessions") VALUES('global',15,${input.externalReservedSessions})`;
      await assertQuiesced();
    });
  });
}
export async function setDesiredSessionGeneration(
  prisma: PrismaClient,
  input: {
    service: "worker-a" | "worker-b";
    desiredGeneration: string;
  } & (
    | { expectedGeneration: null; replacement?: never }
    | { expectedGeneration: string; replacement: { token: string; owner: string } }
  ),
  driver: QuiescedSessionSlotDriver,
) {
  if (!["worker-a", "worker-b"].includes(input.service)) throw new Error("Invalid worker slot");
  value(input.desiredGeneration, "generation");
  return driver.withQuiescedSlot(async (assertQuiesced) => {
    await assertQuiesced();
    await prisma.$transaction(async (tx) => {
      await lock(tx);
      await receipt(tx);
      if (input.expectedGeneration !== null) {
        if (!input.replacement)
          throw new Error("Worker rotation requires the global replacement claim");
        const claim = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM session_admission_budget WHERE id='global' AND "replacementToken"=${input.replacement.token} AND "replacementOwner"=${input.replacement.owner}`;
        if (claim.length !== 1)
          throw new Error("Stale global replacement claim for worker rotation");
      }
      const active = await tx.$queryRaw<
        Array<{ token: string }>
      >`SELECT token FROM session_admissions WHERE service=${input.service} AND status='active'`;
      if (active.length) throw new Error("Close old worker admission before generation rotation");
      const rows = await tx.$queryRaw<
        Array<{ generation: string }>
      >`SELECT generation FROM session_admission_generations WHERE service=${input.service}`;
      if ((rows[0]?.generation ?? null) !== input.expectedGeneration)
        throw new Error("Desired generation conflict");
      await tx.$executeRaw`INSERT INTO session_admission_generations(service,generation) VALUES(${input.service},${input.desiredGeneration}) ON CONFLICT(service) DO UPDATE SET generation=EXCLUDED.generation`;
      await assertQuiesced();
    });
  });
}
export async function reserveSessionAdmission(
  prisma: PrismaClient,
  input: { service: SessionAdmissionService; instanceId: string; generation: string },
): Promise<SessionAdmissionReservation> {
  if (!["api", "worker-a", "worker-b"].includes(input.service))
    throw new Error("Invalid session service");
  value(input.instanceId, "instance id");
  value(input.generation, "generation");
  return prisma.$transaction(async (tx) => {
    await lock(tx);
    await receipt(tx);
    if (input.service !== "api") {
      const desired = await tx.$queryRaw<
        Array<{ generation: string }>
      >`SELECT generation FROM session_admission_generations WHERE service=${input.service}`;
      if (desired[0]?.generation !== input.generation)
        throw new Error("Worker generation is not desired");
    }
    const rows = await tx.$queryRaw<
      SessionAdmissionReservation[]
    >`SELECT * FROM session_admissions`;
    if (
      rows.some(
        (row) =>
          row.instanceId === input.instanceId ||
          (input.service !== "api" && row.service === input.service),
      )
    )
      throw new Error("Session instance or worker slot already reserved");
    const budget = await tx.$queryRaw<
      Array<{ totalSessions: number; externalReservedSessions: number }>
    >`SELECT "totalSessions", "externalReservedSessions" FROM session_admission_budget WHERE id='global'`;
    if (budget.length !== 1)
      throw new Error("Explicit global and external session budget is required");
    const cost = input.service === "api" ? 1 : 5;
    if (
      rows.reduce((sum, row) => sum + row.reservedSessions, 0) +
        cost +
        budget[0]!.externalReservedSessions >
      budget[0]!.totalSessions
    )
      throw new Error("Global session admission capacity exceeded");
    const observers = await tx.$queryRaw<
      Array<{ role: string; enabled: boolean }>
    >`SELECT current_user AS role, current_setting('track_activities')='on' AS enabled`;
    if (!observers[0]?.enabled) throw new Error("Session observation requires track_activities");
    const observerRole = observers[0].role;
    const token = randomUUID();
    const name = `rakazo-session:${token}`;
    await tx.$executeRaw`INSERT INTO session_admissions(token,service,"instanceId","observerRole",generation,"sessionApplicationName","reservedSessions") VALUES(${token},${input.service},${input.instanceId},${observerRole},${input.generation},${name},${cost})`;
    return {
      ...input,
      observerRole,
      token,
      sessionApplicationName: name,
      reservedSessions: cost,
      status: "active",
    };
  });
}
/** Call after physical connect but before exposing the client or issuing LISTEN.
 * Reject/close the physical connection on failure. backendStart must come from PostgreSQL
 * as exact text (microseconds preserved), not a JS Date rounded to milliseconds.
 */
export async function registerSessionConnection(
  prisma: PrismaClient,
  input: SessionAdmissionTarget & {
    backendPid: number;
    backendStart: string;
    applicationName: string;
  },
) {
  if (!Number.isSafeInteger(input.backendPid) || input.backendPid <= 0)
    throw new Error("Invalid backend PID");
  return prisma.$transaction(async (tx) => {
    await lock(tx);
    const row = await owned(tx, input);
    if (row.status !== "active") throw new Error("Session connection admission is closed");
    if (input.applicationName !== row.sessionApplicationName)
      throw new Error("Session application name mismatch");
    const observed = await tx.$queryRaw<Array<{ pid: number; visible: boolean }>>`
      SELECT pid, (backend_start IS NOT NULL AND backend_start=${input.backendStart}::timestamptz
        AND application_name=${row.sessionApplicationName} AND datname=current_database()
        AND usesysid=current_user::regrole::oid AND current_user=${row.observerRole}
        AND current_setting('track_activities')='on') AS visible
      FROM pg_stat_activity WHERE pid=${input.backendPid}`;
    if (observed.length !== 1 || observed[0]?.visible !== true)
      throw new Error("Session backend identity is not observable; pooler visibility gate failed");
    const count = await tx.$queryRaw<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=${row.sessionApplicationName}`;
    if (count[0]!.count > row.reservedSessions)
      throw new Error("Session connections exceed reserved capacity");
    // Remove only definitively absent historical connections, never a present/null-observable PID.
    await tx.$executeRaw`DELETE FROM session_admission_connections c WHERE token=${row.token} AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.pid=c.pid)`;
    await tx.$executeRaw`INSERT INTO session_admission_connections(token,pid,"backendStart") VALUES(${row.token},${input.backendPid},${input.backendStart}::timestamptz) ON CONFLICT(token,pid) DO UPDATE SET "backendStart"=EXCLUDED."backendStart"`;
  });
}
export async function beginSessionAdmissionShutdown(
  prisma: PrismaClient,
  target: SessionAdmissionTarget,
) {
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    await owned(tx, target);
    await tx.$executeRaw`UPDATE session_admissions SET status='closing' WHERE token=${target.token}`;
  });
}
export async function releaseSessionAdmission(
  prisma: PrismaClient,
  target: SessionAdmissionTarget,
  driver: StoppedSessionInstanceDriver,
) {
  await beginSessionAdmissionShutdown(prisma, target);
  return driver.withStoppedInstance(async (assertStopped) => {
    await assertStopped();
    await prisma.$transaction(async (tx) => {
      await lock(tx);
      const row = await owned(tx, target);
      const visibility = await tx.$queryRaw<
        Array<{ visible: boolean }>
      >`SELECT current_user=${row.observerRole} AND current_setting('track_activities')='on' AS visible`;
      if (visibility[0]?.visible !== true)
        throw new Error("Session observer identity or visibility changed");
      if (row.service !== "api") {
        const desired = await tx.$queryRaw<
          Array<{ generation: string }>
        >`SELECT generation FROM session_admission_generations WHERE service=${row.service}`;
        if (!desired[0] || desired[0].generation === row.generation)
          throw new Error("Rotate desired worker generation before releasing its slot");
      }
      const live = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT a.pid FROM pg_stat_activity a WHERE a.application_name=${row.sessionApplicationName}
        OR EXISTS (SELECT 1 FROM session_admission_connections c WHERE c.token=${row.token} AND c.pid=a.pid)`;
      if (live.length) throw new Error("Session backends still present or not safely observable");
      await assertStopped();
      await tx.$executeRaw`DELETE FROM session_admissions WHERE token=${row.token} AND "instanceId"=${target.instanceId}`;
    });
  });
}

/** Global replacement-controller exclusion. No expiry: a failed controller leaves
 * the claim charged until a separately verified recovery decides it is safe.
 */
export async function acquireSessionReplacement(prisma: PrismaClient, input: { owner: string }) {
  value(input.owner, "replacement owner");
  return prisma.$transaction(async (tx) => {
    await lock(tx);
    await receipt(tx);
    const token = randomUUID();
    const changed =
      await tx.$executeRaw`UPDATE session_admission_budget SET "replacementToken"=${token}, "replacementOwner"=${input.owner} WHERE id='global' AND "replacementToken" IS NULL`;
    if (changed !== 1)
      throw new Error("Global replacement controller is already reserved or budget missing");
    return { token, owner: input.owner };
  });
}
/** Only the owning controller may release after completed replacement (or a proven
 * pre-mutation cancellation). External deployment completion is not inferred here.
 */
export async function releaseSessionReplacement(
  prisma: PrismaClient,
  input: { token: string; owner: string },
) {
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    const changed =
      await tx.$executeRaw`UPDATE session_admission_budget SET "replacementToken"=NULL, "replacementOwner"=NULL WHERE id='global' AND "replacementToken"=${input.token} AND "replacementOwner"=${input.owner}`;
    if (changed !== 1) throw new Error("Stale global replacement owner or token");
  });
}
