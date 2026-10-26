import type { ConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** Bots that ran in this window get their tool discovery warmed when a worker starts. */
export const DISCOVERY_PREWARM_WINDOW_MS = 7 * 24 * 60 * 60_000;
const DISCOVERY_PREWARM_BOTS = 50;
const DISCOVERY_PREWARM_TIMEOUT_MS = 60_000;

/**
 * A new worker has no connected tool servers, so the first run of each bot waited about 11 s
 * for discovery. Discover recently active bots' tools once at boot, as their next run would,
 * so connections and tool lists are ready before it. Reads only; failures stay per server.
 */
export async function prewarmToolDiscovery(
  prisma: PrismaClient,
  connector: Pick<ConnectorProvider, "discoverTools">,
  signal: AbortSignal,
  now = Date.now(),
): Promise<void> {
  const startedAt = performance.now();
  const bots = await prisma.run.groupBy({
    by: ["botId", "spaceId", "userId"],
    where: { createdAt: { gte: new Date(now - DISCOVERY_PREWARM_WINDOW_MS) } },
    orderBy: { _max: { createdAt: "desc" } },
    take: DISCOVERY_PREWARM_BOTS,
  });
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_PREWARM_TIMEOUT_MS)]);
  const outcomes = await Promise.allSettled(
    bots.map((bot) =>
      connector.discoverTools({
        operationId: "discovery.prewarm",
        traceId: `discovery-prewarm:${bot.botId}`,
        spaceId: bot.spaceId,
        userId: bot.userId,
        botId: bot.botId,
        signal: timeout,
      }),
    ),
  );
  getLogger().info("discovery.prewarm", {
    bots: bots.length,
    failed: outcomes.filter((outcome) => outcome.status === "rejected").length,
    ms: Math.round(performance.now() - startedAt),
  });
}
