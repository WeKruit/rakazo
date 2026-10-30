// Local synthetic worker process for slot-replacement.postgres.test.ts only.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createDb, createPool, reserveSessionAdmission } from "@rakazo/db";
import { PostgresRealtimeFanout } from "./realtime.js";
import { SessionAdmissionRuntime } from "./session-admission-runtime.js";

const [databaseUrl, service, generation, behavior] = process.argv.slice(2);
const target = new URL(databaseUrl!);
if (
  target.hostname !== "127.0.0.1" ||
  target.port !== "55434" ||
  target.pathname !== "/rakazo_c5_slots" ||
  !["worker-a", "worker-b"].includes(service!)
)
  throw new Error("Synthetic slot fixture only");
const db = createDb(databaseUrl!, { poolMax: 2, applicationName: "slot-child-query" });
const admission = await reserveSessionAdmission(db.prisma, {
  service: service as "worker-a" | "worker-b",
  instanceId: randomUUID(),
  generation: generation!,
});
const guard = new SessionAdmissionRuntime(db.prisma, admission);
const pool = createPool(databaseUrl!, {
  poolMax: 4,
  applicationName: admission.sessionApplicationName,
  verifyConnection: guard.verifyConnection,
});
const realtime = new PostgresRealtimeFanout({
  connectionString: databaseUrl!,
  publisher: db.pool,
  applicationName: admission.sessionApplicationName,
  assertConnectionAdmission: guard.assertConnectionAdmission,
  verifyConnection: guard.verifyConnection,
});
guard.bindOwners(realtime, pool);
const clients = await Promise.all(Array.from({ length: 4 }, () => pool.connect()));
await realtime.subscribe("synthetic", () => {});
const deadline = Date.now() + 5000;
while (
  Number(
    (
      await db.pool.query("SELECT count(*) FROM session_admission_connections WHERE token=$1", [
        admission.token,
      ])
    ).rows[0].count,
  ) !== 5
) {
  if (Date.now() >= deadline) throw new Error("Synthetic listener did not register");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
let state = "ready";
let ticks = 0;
const work = setInterval(() => {
  if (state === "ready") ticks++;
}, 10);
const identity = { instanceId: admission.instanceId, generation, service };
const server = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, state, identity, ticks }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
// One JSON line on stdout is the handshake the parent test reads.
process.stdout.write(
  `${JSON.stringify({
    pid: process.pid,
    port: (server.address() as { port: number }).port,
    identity,
    applicationName: admission.sessionApplicationName,
  })}\n`,
);
let draining: Promise<void> | undefined;
function drain() {
  if (draining) return draining;
  state = "draining";
  draining = (async () => {
    if (behavior === "drain-timeout") return;
    for (const client of clients.splice(0)) client.release();
    await guard.beginShutdown();
    state = "drained";
  })();
  return draining;
}
process.on("SIGUSR2", () => {
  void drain().catch(() => {
    state = "failed";
  });
});
process.on("SIGTERM", () => {
  if (behavior === "hang-stop") return;
  void (async () => {
    await drain();
    if (state !== "drained") return;
    await guard.closeAndRelease();
    clearInterval(work);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.prisma.$disconnect();
    await db.pool.end();
    process.exit(0);
  })().catch(() => {
    state = "failed";
  });
});
