import {
  ComputerBusyError,
  type ProvisionTiming,
  provisionComputer,
  scheduleComputerSleep,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { RouterDeps } from "./router.js";

export const PREWARM_INTERVAL_MS = 10 * 60_000;
const PREWARM_MAP_CEILING = 1_000;

// ponytail: in-process rate limit keyed by computer id. Per API replica, not cluster-wide;
// N replicas can each pre-warm once per 10 min. Move to a computers column if that bites.
const lastPrewarmAt = new Map<string, number>();

function rateLimited(computerId: string, now = Date.now()): boolean {
  const last = lastPrewarmAt.get(computerId);
  if (last !== undefined && now - last < PREWARM_INTERVAL_MS) return true;
  if (lastPrewarmAt.size >= PREWARM_MAP_CEILING) {
    for (const [id, at] of lastPrewarmAt)
      if (now - at >= PREWARM_INTERVAL_MS) lastPrewarmAt.delete(id);
    if (lastPrewarmAt.size >= PREWARM_MAP_CEILING) lastPrewarmAt.clear();
  }
  lastPrewarmAt.set(computerId, now);
  return false;
}

export type PrewarmOutcome = "warmed" | "failed" | `skipped:${string}`;

/**
 * Wake the space's paused Team Computer and run the provider prepare so the first run
 * after the site opens skips the wake. Never takes the execution lease and never throws;
 * the outcome is logged as `computer.prewarm.timing`.
 */
export async function prewarmTeamComputer(
  deps: Pick<RouterDeps, "prisma" | "sandbox" | "home" | "jobs" | "events" | "dataDir">,
  actor: Pick<Actor, "spaceId" | "userId">,
): Promise<PrewarmOutcome> {
  const startedAt = Date.now();
  const timing: ProvisionTiming = {};
  let computerId: string | undefined;
  let outcome: PrewarmOutcome;
  try {
    outcome = await (async (): Promise<PrewarmOutcome> => {
      if (process.env.COMPUTER_PREWARM?.trim() === "0") return "skipped:disabled";
      const computer = await deps.prisma.computer.findFirst({
        where: { spaceId: actor.spaceId, scope: "team" },
        select: {
          id: true,
          state: true,
          bots: { where: { archivedAt: null }, select: { id: true }, take: 1 },
        },
      });
      if (!computer) return "skipped:no_computer";
      computerId = computer.id;
      if (computer.state !== "suspended") return "skipped:not_paused";
      const botId = computer.bots[0]?.id;
      if (!botId) return "skipped:no_bot";
      const activeRun = await deps.prisma.run.findFirst({
        where: { status: { in: [...ACTIVE_RUN_STATUSES] }, bot: { computerId: computer.id } },
        select: { id: true },
      });
      if (activeRun) return "skipped:run_active";
      if (rateLimited(computer.id)) return "skipped:rate_limited";
      try {
        await provisionComputer(
          deps,
          computer.id,
          {
            operationId: "computer.prewarm",
            traceId: "computer.prewarm",
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            signal: new AbortController().signal,
          },
          "none",
          undefined,
          timing,
        );
      } catch (error) {
        // Another caller (a run or a manual boot) owns the wake; it warms the computer for us.
        if (error instanceof ComputerBusyError) return "skipped:busy";
        throw error;
      }
      scheduleComputerSleep(deps.jobs, computer.id);
      return "warmed";
    })();
  } catch (error) {
    outcome = "failed";
    getLogger().warn("computer.prewarm", { computerId, spaceId: actor.spaceId, error });
  }
  getLogger().info("computer.prewarm.timing", {
    outcome,
    computerId,
    spaceId: actor.spaceId,
    wakeMs: timing.wakeMs ?? 0,
    prepareMs: timing.prepareMs ?? 0,
    totalMs: Date.now() - startedAt,
  });
  return outcome;
}
