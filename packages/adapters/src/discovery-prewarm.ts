import type { ConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { DISCOVERY_CACHE_TTL_MS, DISCOVERY_REFRESH_OPERATION } from "./mcp-connector.js";

/** Bots that ran in this window get their tool discovery warmed when a worker starts. */
export const DISCOVERY_PREWARM_WINDOW_MS = 7 * 24 * 60 * 60_000;
const DISCOVERY_PREWARM_BOTS = 50;
const DISCOVERY_PREWARM_TIMEOUT_MS = 60_000;
/**
 * Bots warmed at once. All fifty at once queued about 150 worker database checkouts for 11 s
 * every refresh, which slowed page reads sharing the database and the container's CPU.
 */
export const DISCOVERY_PREWARM_CONCURRENCY = 8;
/** Refreshed before the cached tool lists expire, so a run never lists a server itself. */
export const DISCOVERY_PREWARM_REFRESH_MS = DISCOVERY_CACHE_TTL_MS - 2 * 60_000;

/**
 * A new worker has no connected tool servers, so the first run of each bot waited about 11 s
 * for discovery, and a cached tool list that expired cost the next run about 2 s. List recently
 * active bots' tools again at boot and every DISCOVERY_PREWARM_REFRESH_MS, as their next run
 * would, so connections and tool lists are ready before it. Reads only; failures stay per server.
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
  let next = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(DISCOVERY_PREWARM_CONCURRENCY, bots.length) }, async () => {
      while (next < bots.length && !timeout.aborted) {
        const bot = bots[next++]!;
        await connector
          .discoverTools({
            operationId: DISCOVERY_REFRESH_OPERATION,
            traceId: `discovery-prewarm:${bot.botId}`,
            spaceId: bot.spaceId,
            userId: bot.userId,
            botId: bot.botId,
            signal: timeout,
          })
          .catch(() => {
            failed += 1;
          });
      }
    }),
  );
  getLogger().info("discovery.prewarm", {
    bots: bots.length,
    failed,
    ms: Math.round(performance.now() - startedAt),
  });
}

/**
 * A new account's bots have never run, so the boot prewarm skips them and their first run
 * listed every tool server itself (about 1 s). List one bot's tools as soon as it is
 * provisioned. Scope comes from the bot row, never from the job.
 */
export async function warmBotDiscovery(
  prisma: Pick<PrismaClient, "bot">,
  connector: Pick<ConnectorProvider, "discoverTools">,
  botId: string,
): Promise<void> {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, archivedAt: null },
    select: { id: true, spaceId: true, userId: true },
  });
  if (!bot) return;
  const startedAt = performance.now();
  await connector.discoverTools({
    operationId: DISCOVERY_REFRESH_OPERATION,
    traceId: `discovery-warm:${bot.id}`,
    spaceId: bot.spaceId,
    userId: bot.userId,
    botId: bot.id,
    signal: AbortSignal.timeout(DISCOVERY_PREWARM_TIMEOUT_MS),
  });
  getLogger().info("discovery.warm", { ms: Math.round(performance.now() - startedAt) });
}
