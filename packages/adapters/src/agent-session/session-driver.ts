import type { Session } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, StorageBackedSession, value } from "@earendil-works/pi-agent-core";
import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { PrismaClient, SessionLease } from "@rakazo/db";
import {
  acquireSessionLease,
  appendEventInTransaction,
  cancelRunsInTransaction,
  markSessionInputDelivered,
  pendingSessionInputs,
  releaseSessionLease,
  renewSessionLease,
  sessionTopic,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { PostgresSessionStorage } from "./postgres-session-storage.js";
import type { RunInput, RunProjectionDeps } from "./run-projection.js";
import { createRunProjection } from "./run-projection.js";
import type { OpenRunTurn } from "./run-turns.js";
import { createRunTurns } from "./run-turns.js";
import type { SessionConfig } from "./session-config.js";
import type { SessionHostOutcome, SessionInputRow } from "./session-host.js";
import { runSessionHost } from "./session-host.js";
import type { SessionLoadDeps } from "./session-load.js";
import { loadSessionConfig } from "./session-load.js";
import { prismaSeedSource, seedSession } from "./session-seed.js";

/** A stopped run whose operation no lane is running ends here, as Stop asked. */
async function endStaleRun(deps: Pick<SessionDriverDeps, "prisma" | "projection">, runId: string) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    const now = new Date();
    const [run] = await tx.run.updateManyAndReturn({
      where: { id: runId, status: { in: ["queued", "leased", "running", "waiting_input"] } },
      data: { status: "cancelled", completedAt: now },
      select: { id: true, taskId: true, spaceId: true, threadId: true, botId: true },
    });
    if (!run) return null;
    await cancelRunsInTransaction(tx, [run], now);
    return appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "run.cancelled",
      runId: run.id,
      payload: {},
    });
  });
  if (committed)
    await deps.projection.events
      .notify(committed.threadId, committed.seq)
      .catch((error: unknown) => {
        getLogger().error("stale run realtime notification", error, { runId });
      });
}

export interface SessionDriverDeps {
  prisma: PrismaClient;
  realtime: Pick<RealtimeFanout, "subscribe">;
  workerId: string;
  /** Loads a (thread, bot) session's prompt, tools and models. */
  load: Omit<SessionLoadDeps, "toolHost" | "registerSecrets" | "trigger" | "prisma">;
  projection: Omit<RunProjectionDeps, "prisma" | "secrets" | "hideVendors">;
  /** The executor's per-operation tool setup on the run row. */
  openRunTurn: OpenRunTurn;
  /** After a run's terminal row is written: routine bookkeeping and the messaging mirror. */
  afterRun?(runId: string): Promise<void>;
  /** Deployment-wide secret values never written to a projected row. */
  secrets?: readonly string[];
}

/** Written last by the one-time import: a session without it has no complete seed. */
const SEEDED = value<true>("rakazo.seed", "done");

async function isSeeded(prisma: PrismaClient, sessionId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ found: number }[]>`
    SELECT 1 AS found FROM session_values
    WHERE "sessionId" = ${sessionId} AND namespace = ${SEEDED.namespace} AND key = ${SEEDED.key}
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * Removes what an interrupted import left behind. Safe only before a harness opens the session:
 * without the seed marker no lane has ever run on it. Fenced so a stale owner removes nothing.
 */
async function clearPartialSeed(prisma: PrismaClient, lease: SessionLease): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const owned = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM conversation_sessions
      WHERE id = ${lease.sessionId} AND "leaseFence" = ${lease.fence}::int FOR UPDATE`;
    if (owned.length === 0) return;
    await tx.$executeRaw`DELETE FROM session_usage WHERE "sessionId" = ${lease.sessionId}`;
    await tx.$executeRaw`DELETE FROM session_list_elements WHERE "sessionId" = ${lease.sessionId}`;
    await tx.$executeRaw`DELETE FROM session_values WHERE "sessionId" = ${lease.sessionId}`;
    await tx.$executeRaw`DELETE FROM session_entries WHERE "sessionId" = ${lease.sessionId}`;
    await tx.$executeRaw`
      UPDATE conversation_sessions SET "messageCount" = 0, usage = NULL WHERE id = ${lease.sessionId}`;
  });
}

/** Messages before the first undelivered input are history; that input and later ones are not. */
async function seedBeforeSeq(prisma: PrismaClient, sessionId: string, threadId: string) {
  const first = await prisma.sessionInput.findFirst({
    where: { sessionId, deliveredAt: null, messageId: { not: null } },
    orderBy: { seq: "asc" },
    select: { messageId: true },
  });
  const message = first?.messageId
    ? await prisma.message.findUnique({ where: { id: first.messageId }, select: { seq: true } })
    : null;
  if (message) return message.seq;
  const thread = await prisma.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { nextMessageSeq: true },
  });
  return thread.nextMessageSeq;
}

function runInputOf(input: SessionInputRow | undefined): RunInput {
  if (!input) return { trigger: "user" };
  const payload = input.payload as { text?: unknown } | null;
  return {
    trigger: input.trigger,
    sourceMessageId: input.messageId ?? null,
    ...(typeof payload?.text === "string" ? { prompt: payload.text } : {}),
  };
}

/**
 * `session.drive`: owns one conversation session while it has work. Binds the session host to
 * the database lease and outbox, the realtime notify, Postgres storage, the run projection and
 * the executor's tool setup.
 */
export function createSessionDriver(deps: SessionDriverDeps) {
  return async (sessionId: string, signal: AbortSignal): Promise<SessionHostOutcome> => {
    const row = await deps.prisma.conversationSession.findUnique({ where: { id: sessionId } });
    if (!row) return "not_owner";
    const key = {
      spaceId: row.spaceId,
      userId: row.userId,
      threadId: row.threadId,
      botId: row.botId,
    };
    const secrets = [...(deps.secrets ?? [])];
    const triggers = new Map<string, string>();
    const turns = createRunTurns(deps.openRunTurn);
    let lease: SessionLease | null = null;
    let config: SessionConfig | undefined;
    let projection: ReturnType<typeof createRunProjection> | undefined;

    const buildConfig = async () => {
      config ??= await loadSessionConfig(
        {
          ...deps.load,
          prisma: deps.prisma,
          toolHost: (models) => turns.host(models),
          registerSecrets: (values) => secrets.push(...values),
          trigger: (runId) => triggers.get(runId) ?? "user",
        },
        key,
      );
      const base = config.install;
      const loaded = config;
      // The run's first step waits for its setup, and reads what the setup replayed.
      config.install = (harness, lane) => {
        const disposeBase = base?.call(loaded, harness, lane);
        const disposeNotes = harness.hooks.on("before_run", async (event) => {
          const notes = await turns.notes(event.runId);
          if (!notes.length) return undefined;
          return {
            messages: notes.map((text) => ({
              role: "user" as const,
              content: [{ type: "text" as const, text }],
              timestamp: Date.now(),
            })),
          };
        });
        return () => {
          disposeBase?.();
          disposeNotes();
        };
      };
      projection ??= createRunProjection(
        {
          ...deps.projection,
          prisma: deps.prisma,
          secrets,
          hideVendors: config.hideVendors ?? false,
        },
        key,
      );
      return config;
    };

    const openSession = async (): Promise<Session> => {
      if (!lease) throw new Error("Session lease is not held");
      const loaded = await buildConfig();
      const seeded = await isSeeded(deps.prisma, sessionId);
      if (!seeded) await clearPartialSeed(deps.prisma, lease);
      const session = new StorageBackedSession(
        { id: sessionId, createdAt: row.createdAt.getTime(), storageVersion: row.storageVersion },
        new PostgresSessionStorage(deps.prisma, sessionId, lease.fence),
      );
      if (!seeded) {
        const beforeSeq = await seedBeforeSeq(deps.prisma, sessionId, key.threadId);
        await seedSession(
          session,
          prismaSeedSource(deps.prisma),
          { ...key, model: loaded.model },
          beforeSeq,
          BACKGROUND_CONTEXT,
        );
        await session.setValue(SEEDED, true, BACKGROUND_CONTEXT);
      }
      return session;
    };

    return runSessionHost(
      {
        async acquireLease() {
          lease = await acquireSessionLease(deps.prisma, sessionId, deps.workerId);
          const held = lease;
          if (!held) return null;
          return {
            renew: () => renewSessionLease(deps.prisma, held),
            release: () => releaseSessionLease(deps.prisma, held),
          };
        },
        inputs: {
          async pending() {
            const rows = await pendingSessionInputs(deps.prisma, sessionId);
            return rows.map((input) => ({
              id: input.id,
              seq: input.seq,
              kind: input.kind,
              messageId: input.messageId,
              payload: input.payload,
              trigger: input.trigger,
            }));
          },
          async markDelivered(inputId, delivery) {
            if (lease) await markSessionInputDelivered(deps.prisma, lease, inputId, delivery);
          },
        },
        subscribe(onNotify) {
          const subscribed = deps.realtime.subscribe(sessionTopic(sessionId), () => onNotify());
          subscribed.catch((error: unknown) =>
            getLogger().error("session.subscribe.failed", error, { sessionId }),
          );
          return () => {
            void subscribed.then((unsubscribe) => unsubscribe()).catch(() => undefined);
          };
        },
        openSession,
        buildConfig,
        endStaleRun: (runId) => endStaleRun(deps, runId),
        async onEvent(event, context) {
          if (!projection) return;
          // A run resumed after its owner died gets its tools set up again.
          if (event.type === "run_resume") {
            turns.start(event.runId);
            return;
          }
          if (event.type === "run_start") {
            const input = runInputOf(context.input);
            triggers.set(event.runId, input.trigger);
            await projection.onEvent(event, { input });
            turns.start(event.runId);
            return;
          }
          if (event.type === "run_end") {
            await turns.end(event.runId, event.status !== "completed");
            await projection.onEvent(event);
            triggers.delete(event.runId);
            if (deps.afterRun) {
              const runId = event.runId;
              void deps
                .afterRun(runId)
                .catch((error: unknown) =>
                  getLogger().error("session.after_run.failed", error, { runId }),
                );
            }
            return;
          }
          await projection.onEvent(event);
        },
      },
      signal,
    );
  };
}

export type DriveSession = ReturnType<typeof createSessionDriver>;

/** The composition roots' one binding: the executor's tools and the job handlers' bookkeeping. */
export function bindSessionDriver(deps: {
  executor: {
    sessionLoadDeps: SessionDriverDeps["load"] & { prisma: PrismaClient; secrets?: string[] };
    openRunTurn(
      runId: string,
      workerId: string,
      binding: Parameters<OpenRunTurn>[1],
    ): Promise<void>;
  };
  realtime: Pick<RealtimeFanout, "subscribe">;
  workerId: string;
  projection: SessionDriverDeps["projection"];
  afterRun?: SessionDriverDeps["afterRun"];
}): DriveSession {
  const { prisma, secrets, ...load } = deps.executor.sessionLoadDeps;
  return createSessionDriver({
    prisma,
    realtime: deps.realtime,
    workerId: deps.workerId,
    load,
    projection: deps.projection,
    openRunTurn: (runId, binding) => deps.executor.openRunTurn(runId, deps.workerId, binding),
    ...(deps.afterRun ? { afterRun: deps.afterRun } : {}),
    ...(secrets ? { secrets } : {}),
  });
}
