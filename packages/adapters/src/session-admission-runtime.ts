import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient, SessionAdmissionReservation } from "@rakazo/db";
import {
  beginSessionAdmissionShutdown,
  endTrackedSessionPool,
  registerSessionConnection,
  releaseSessionAdmission,
  reserveSessionAdmission,
} from "@rakazo/db";
import type { Pool } from "pg";
import type { PostgresRealtimeFanout, RealtimeListenerClient } from "./realtime.js";

/** The only session owners in the split runtime are the four-connection worker pool
 * and one realtime listener. Query pools remain on the transaction pooler.
 */
export class SessionAdmissionRuntime {
  private closing = false;
  private closed = false;
  private owners: { realtime: PostgresRealtimeFanout; pool?: Pool } | undefined;
  private shutdown: Promise<void> | undefined;
  bindOwners(realtime: PostgresRealtimeFanout, pool?: Pool) {
    if (this.owners || this.closing) throw new Error("Session owners are already bound or closing");
    this.owners = { realtime, pool };
  }
  private readonly connecting = new Set<Promise<void>>();
  constructor(
    private readonly prisma: PrismaClient,
    readonly admission: SessionAdmissionReservation,
  ) {}
  readonly assertConnectionAdmission = () => {
    if (this.closing) throw new Error("Session connection admission is permanently closed");
  };
  readonly verifyConnection = async (client: Pick<RealtimeListenerClient, "query">) => {
    if (this.closing) throw new Error("Session connection admission is permanently closed");
    const task = (async () => {
      const result = (await client.query(
        "SELECT pg_backend_pid() AS pid, backend_start::text AS started, current_setting('application_name') AS name FROM pg_stat_activity WHERE pid=pg_backend_pid()",
      )) as { rows: Array<{ pid: number; started: string; name: string }> };
      const row = result.rows[0];
      if (!row || !row.started || row.name !== this.admission.sessionApplicationName)
        throw new Error("Session backend identity is not observable");
      if (this.closing) throw new Error("Session connection admission is permanently closed");
      await registerSessionConnection(this.prisma, {
        ...this.admission,
        backendPid: row.pid,
        backendStart: row.started,
        applicationName: row.name,
      });
      if (this.closing) throw new Error("Session connection admission is permanently closed");
    })();
    this.connecting.add(task);
    try {
      await task;
    } finally {
      this.connecting.delete(task);
    }
  };
  /** Called only after job drain. Closing can never be undone by this instance. */
  beginShutdown(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = (async () => {
      if (!this.owners) throw new Error("Session owners were not bound");
      await beginSessionAdmissionShutdown(this.prisma, this.admission);
      // Pool.end permanently closes future checkout and waits for physical clients.
      await Promise.all([
        this.owners.realtime.close(),
        this.owners.pool ? endTrackedSessionPool(this.owners.pool) : undefined,
        Promise.allSettled([...this.connecting]),
      ]);
      this.closed = true;
    })();
    return this.shutdown;
  }
  async closeAndRelease() {
    await this.beginShutdown();
    await releaseSessionAdmission(this.prisma, this.admission, {
      withStoppedInstance: async (run) =>
        run(async () => {
          if (!this.closed || !this.closing || this.connecting.size)
            throw new Error("Session owners have not permanently stopped");
        }),
    });
  }
}

export async function verifySessionBuildManifest(entry: string, generation: string) {
  const manifest = JSON.parse(
    await readFile(path.join(path.dirname(entry), "build-manifest.json"), "utf8"),
  ) as { sourceRevision?: unknown; sha256?: unknown; sessionAdmissionProtocol?: unknown };
  if (
    manifest.sessionAdmissionProtocol !== 1 ||
    manifest.sourceRevision !== generation ||
    !/^[0-9a-f]{40}$/.test(generation)
  )
    throw new Error("Image manifest does not match the admitted generation/protocol");
  const digest = createHash("sha256")
    .update(await readFile(entry))
    .digest("hex");
  if (manifest.sha256 !== digest) throw new Error("Image bundle does not match its build manifest");
}

export async function createSessionAdmissionRuntime(
  prisma: PrismaClient,
  service: "api" | "worker",
  env: NodeJS.ProcessEnv,
): Promise<SessionAdmissionRuntime | undefined> {
  const slot = env.RAKAZO_SESSION_SLOT;
  if (slot === undefined) return undefined;
  if (
    (service === "api" && slot !== "api") ||
    (service === "worker" && slot !== "worker-a" && slot !== "worker-b")
  )
    throw new Error("Session slot does not match process service");
  const query = new URL(env.DATABASE_URL ?? "");
  const session = new URL(env.REALTIME_DATABASE_URL ?? "");
  if (query.port !== "6543" || session.port !== "5432")
    throw new Error("Split session admission requires transaction 6543 and session 5432 poolers");
  if (!env.RAKAZO_GIT_SHA) throw new Error("Split session admission requires image generation");
  if (!process.argv[1]) throw new Error("Split service entry is missing");
  await verifySessionBuildManifest(path.resolve(process.argv[1]), env.RAKAZO_GIT_SHA);
  if (env.WAKEUP_DRIVER === "memory") throw new Error("Split services require shared durable jobs");
  const admission = await reserveSessionAdmission(prisma, {
    service: slot as SessionAdmissionReservation["service"],
    instanceId: randomUUID(),
    generation: env.RAKAZO_GIT_SHA,
  });
  return new SessionAdmissionRuntime(prisma, admission);
}
