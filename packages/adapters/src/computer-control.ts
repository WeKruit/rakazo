import {
  type AdapterContext,
  computerControlExpireJob,
  type JobPublisher,
  type SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { submitConversationWakeOnce, wakeSessions } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { toComputerRef } from "./computer-support.js";
import { isSandboxGoneError } from "./e2b-sandbox.js";

export const DEFAULT_TAKEOVER_LEASE_MS = 15 * 60 * 1000;

export function takeoverLeaseMs(): number {
  const raw = Number(process.env.COMPUTER_TAKEOVER_TTL_MS ?? DEFAULT_TAKEOVER_LEASE_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_TAKEOVER_LEASE_MS;
}

export function hasActiveComputerControl(
  computer:
    | {
        controlHolder: string;
        controlLeaseId: string | null;
        controlLeaseExpiresAt: Date | null;
      }
    | null
    | undefined,
  now = new Date(),
): boolean {
  return Boolean(
    computer?.controlHolder === "user" &&
      computer.controlLeaseId &&
      computer.controlLeaseExpiresAt &&
      computer.controlLeaseExpiresAt.getTime() > now.getTime(),
  );
}

/** User takeover of this bot with no run bound to it. Maintenance may claim it. */
export function isIdleOwnComputerTakeover(
  computer:
    | {
        controlHolder: string;
        controlBotId: string | null;
        controlRunId: string | null;
      }
    | null
    | undefined,
  botId: string,
): boolean {
  return Boolean(
    computer?.controlHolder === "user" && computer.controlBotId === botId && !computer.controlRunId,
  );
}

export function scheduleComputerControlExpiry(
  jobs: JobPublisher,
  computerId: string,
  leaseId: string,
  expiresAt: Date,
): Promise<void> {
  return jobs.enqueue(computerControlExpireJob(computerId, leaseId, expiresAt));
}

/** The person handed the computer back: one input into the session of the bot that asked. */
export async function enqueueTakeoverContinuation(
  deps: {
    prisma: PrismaClient;
    jobs: Pick<JobPublisher, "enqueue">;
    events?: Partial<Pick<ThreadEvents, "wakeSessions">>;
  },
  runId: string | null,
): Promise<void> {
  if (!runId) return;
  try {
    const sessionId = await deps.prisma.$transaction(async (tx) => {
      const run = await tx.run.findUnique({
        where: { id: runId },
        select: { spaceId: true, userId: true, threadId: true, botId: true },
      });
      if (!run) return null;
      // The run that asked for the computer has ended; its card is closed.
      await tx.run.updateMany({
        where: { id: runId, status: { in: ["queued", "waiting_takeover"] } },
        data: { status: "completed", completedAt: new Date(), leaseOwner: null },
      });
      const submitted = await submitConversationWakeOnce(tx, run, {
        kind: "message",
        trigger: "takeover",
        payload: {
          text: "The person handed the computer back.",
          internal: true,
          wakeKey: `takeover-release:${runId}`,
        },
      });
      return submitted?.sessionId ?? null;
    });
    if (!sessionId) return;
    // Without realtime here the owner finds the input at its next lease renewal.
    if (deps.events?.wakeSessions) await deps.events.wakeSessions([sessionId]);
    else await wakeSessions({ jobs: deps.jobs }, [sessionId]);
  } catch (error) {
    getLogger().error("takeover continuation", error);
  }
}

export function teachingControlLeaseExpiresAt(teachingExpiresAt: Date, now = new Date()): Date {
  return new Date(Math.max(now.getTime() + takeoverLeaseMs(), teachingExpiresAt.getTime()));
}

export async function extendActiveComputerControl(
  prisma: PrismaClient,
  jobs: JobPublisher,
  computer: {
    id: string;
    controlHolder: string;
    controlLeaseId: string | null;
    controlLeaseExpiresAt: Date | null;
    controlBotId: string | null;
  },
  botId: string,
  until: Date,
  now = new Date(),
): Promise<boolean> {
  if (
    !hasActiveComputerControl(computer, now) ||
    computer.controlBotId !== botId ||
    !computer.controlLeaseId
  ) {
    return false;
  }
  const expiresAt = teachingControlLeaseExpiresAt(until, now);
  const extended = await prisma.computer.updateMany({
    where: {
      id: computer.id,
      controlHolder: "user",
      controlBotId: botId,
      controlLeaseId: computer.controlLeaseId,
    },
    data: { controlLeaseExpiresAt: expiresAt },
  });
  if (extended.count !== 1) return false;
  await scheduleComputerControlExpiry(jobs, computer.id, computer.controlLeaseId, expiresAt);
  return true;
}

/** Clears controlHolder=user when no live control lease remains (stale / orphaned rows). */
export async function clearInactiveUserComputerControl(
  prisma: PrismaClient,
  computerId: string,
  now = new Date(),
): Promise<boolean> {
  const cleared = await prisma.computer.updateMany({
    where: {
      id: computerId,
      controlHolder: "user",
      OR: [
        { controlLeaseId: null },
        { controlLeaseExpiresAt: null },
        { controlLeaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
    },
  });
  return cleared.count === 1;
}

/** Revoke provider screen control. Gone sandbox ⇒ already released; drop the stranded ref
 * unless clearGoneRef: false (mid-replacement still names that ref for activation CAS). */
export async function revokeScreenControl(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider | undefined },
  computer: { id: string; homeKey: string; kind: string; providerRef: string | null },
  context: AdapterContext,
  leaseId: string | undefined,
  opts?: { clearGoneRef?: boolean },
): Promise<void> {
  if (!computer.providerRef) return;
  try {
    await deps.sandbox?.setScreenControl?.(toComputerRef(computer), false, context, leaseId);
  } catch (error) {
    if (!isSandboxGoneError(error)) throw error;
    if (opts?.clearGoneRef === false) return;
    getLogger().error(`computer ${computer.id} sandbox ${computer.providerRef} is gone`, error);
    // Fence by lease + skip booting/suspending so a stale gone-cleanup cannot clobber an
    // in-flight replace/boot that still names this providerRef.
    await deps.prisma.computer.updateMany({
      where: {
        id: computer.id,
        providerRef: computer.providerRef,
        state: { notIn: ["booting", "suspending"] },
        ...(leaseId != null ? { controlLeaseId: leaseId } : {}),
      },
      data: { state: "stopped", providerRef: null },
    });
  }
}

export async function expireComputerControl(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    jobs: JobPublisher;
    events: ThreadEvents;
  },
  computerId: string,
  leaseId: string,
  now = new Date(),
): Promise<boolean> {
  const computer = await deps.prisma.computer.findUnique({ where: { id: computerId } });
  if (!computer || computer.controlLeaseId !== leaseId) return false;
  const botId = computer.controlBotId;
  if (!botId) {
    if (
      computer.controlLeaseExpiresAt &&
      computer.controlLeaseExpiresAt.getTime() > now.getTime()
    ) {
      await scheduleComputerControlExpiry(
        deps.jobs,
        computer.id,
        leaseId,
        computer.controlLeaseExpiresAt,
      );
      return false;
    }
    // Orphaned user control: revoke the provider stream, then clear this lease id.
    if (computer.providerRef) {
      const context: AdapterContext = {
        operationId: "computer.control-expire",
        traceId: "computer.control-expire",
        spaceId: computer.spaceId,
        userId: computer.userId,
        signal: new AbortController().signal,
      };
      try {
        await revokeScreenControl(deps, computer, context, leaseId);
      } catch {
        // Keep the lease id and try to reschedule so reconciler/status can retry.
        try {
          await scheduleComputerControlExpiry(
            deps.jobs,
            computer.id,
            leaseId,
            new Date(now.getTime() + 30_000),
          );
        } catch (error) {
          getLogger().error("orphan computer control expiry reschedule", error);
        }
        return false;
      }
    }
    const cleared = await deps.prisma.computer.updateMany({
      where: { id: computer.id, controlLeaseId: leaseId },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    return cleared.count === 1;
  }

  if (computer.controlLeaseExpiresAt && computer.controlLeaseExpiresAt.getTime() > now.getTime()) {
    await scheduleComputerControlExpiry(
      deps.jobs,
      computer.id,
      leaseId,
      computer.controlLeaseExpiresAt,
    );
    return false;
  }

  // Deny API input before touching the provider. Retaining the lease ID makes a
  // failed provider revocation recoverable by the job retry or reconciler.
  const claimed = await deps.prisma.computer.updateMany({
    where: { id: computer.id, controlLeaseId: leaseId },
    data: { controlHolder: "none" },
  });
  if (claimed.count !== 1) return false;

  if (computer.providerRef) {
    const context: AdapterContext = {
      operationId: "computer.control-expire",
      traceId: "computer.control-expire",
      spaceId: computer.spaceId,
      userId: computer.userId,
      botId,
      signal: new AbortController().signal,
    };
    await revokeScreenControl(deps, computer, context, leaseId);
  }

  const released = await deps.events.finalizeComputerControlRelease({
    spaceId: computer.spaceId,
    computerId: computer.id,
    botId,
    runId: computer.controlRunId,
    leaseId,
    holder: "none",
    reason: "expired",
  });
  await enqueueTakeoverContinuation(deps, released ? released.runId : null);
  return Boolean(released);
}
