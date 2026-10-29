import type { JobPublisher } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { pendingInputAttention } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  AUTOCONTINUE_NONCE_PREFIX,
  autoContinueMax,
  countTrailingAutoContinues,
  guardRecruitingTurnEnd,
} from "./turn-end-guard.js";

/** A role thread idle this long after its last turn gets the turn-end guard again. */
export const IDLE_SWEEP_AFTER_MS = 10 * 60_000;
/** Older threads are left alone so a deploy never wakes long-abandoned roles. */
export const IDLE_SWEEP_LOOKBACK_MS = 24 * 60 * 60_000;
const ACTIVE_RUN_STATUSES = ["queued", "leased", "running", "waiting_input", "waiting_takeover"];

/**
 * The turn-end guard runs only when a turn completes, so a role whose last turn failed, or
 * ended while a search was still running and the wake never came, stays quiet until someone
 * writes. This sweep re-applies the same guard to role threads that have gone idle: same
 * playbook step, same per-human-turn cap, same nonce, no new decision logic. A stopped
 * (cancelled) turn, a pending card or any running work in the role is left alone.
 */
export async function sweepIdleRecruitingRoles(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: ThreadEvents;
  now: Date;
  batchSize: number;
  max?: number;
}) {
  const max = deps.max ?? autoContinueMax();
  if (max === 0) return 0;
  const idleBefore = new Date(deps.now.getTime() - IDLE_SWEEP_AFTER_MS);
  const since = new Date(deps.now.getTime() - IDLE_SWEEP_LOOKBACK_MS);
  const threads = await deps.prisma.thread.findMany({
    where: {
      activeRecruitingRoleId: { not: null },
      activeRecruitingRole: { archivedAt: null },
      runs: {
        some: {
          status: { in: ["completed", "failed"] },
          updatedAt: { gte: since, lte: idleBefore },
        },
        none: { status: { in: ACTIVE_RUN_STATUSES } },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: deps.batchSize,
    select: { id: true, activeRecruitingRoleId: true },
  });
  let continued = 0;
  for (const thread of threads) {
    const roleId = thread.activeRecruitingRoleId;
    if (!roleId) continue;
    try {
      const run = await deps.prisma.run.findFirst({
        where: { threadId: thread.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          spaceId: true,
          threadId: true,
          botId: true,
          userId: true,
          trigger: true,
          status: true,
          updatedAt: true,
        },
      });
      if (
        !run ||
        !["completed", "failed"].includes(run.status) ||
        run.updatedAt > idleBefore ||
        run.updatedAt < since
      )
        continue;
      // A specialist still working on this role elsewhere owns the next step.
      const busy = await deps.prisma.run.findFirst({
        where: {
          spaceId: run.spaceId,
          status: { in: ACTIVE_RUN_STATUSES },
          thread: { activeRecruitingRoleId: roleId },
        },
        select: { id: true },
      });
      if (busy) continue;
      const recent = await deps.prisma.message.findMany({
        where: {
          threadId: run.threadId,
          OR: [
            { role: "user" },
            { role: "system", clientNonce: { startsWith: AUTOCONTINUE_NONCE_PREFIX } },
          ],
        },
        orderBy: { seq: "desc" },
        take: max + 1,
        select: { clientNonce: true },
      });
      // The cap was already reached and announced; only a human message resets it.
      if (countTrailingAutoContinues(recent) >= max) continue;
      const last = await deps.prisma.message.findFirst({
        where: { threadId: run.threadId, runId: run.id, role: "bot" },
        orderBy: { seq: "desc" },
        select: { blocks: true },
      });
      if (pendingInputAttention(last?.blocks)) continue;
      const result = await guardRecruitingTurnEnd(deps, {
        run,
        roleId,
        blocks: (Array.isArray(last?.blocks) ? last.blocks : []) as MessageBlock[],
        handedOff: false,
        pendingApproval: false,
        max,
        // Unreachable: the trailing count above is below the cap.
        postAssistant: async () => undefined,
      });
      if (result.action === "continued") {
        continued += 1;
        getLogger().info("run.autocontinue.idle_sweep", {
          runId: run.id,
          roleId,
          stage: result.stage,
          count: result.count,
        });
      }
    } catch (error) {
      getLogger().error("recruiting idle sweep", error);
    }
  }
  return continued;
}
