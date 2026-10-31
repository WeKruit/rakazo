import type { ThreadBackgroundTask } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, AUTOMATION_RUN_TRIGGERS } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

/**
 * Work still running behind a conversation, scoped to the conversation owner: research the
 * provider is doing, cloud agents, teammates' handed-off and automation runs, and large
 * people searches. The Background tasks panel and the agent's wait tool read the same list.
 */
export async function listThreadBackgroundWork(
  prisma: Pick<PrismaClient, "$queryRaw">,
  threadId: string,
): Promise<ThreadBackgroundTask[]> {
  return prisma.$queryRaw<ThreadBackgroundTask[]>`
    WITH owned AS (
      SELECT id, "spaceId", "userId" FROM threads WHERE id = ${threadId}
    )
    SELECT q.id, 'research' AS kind, 'running' AS status
    FROM recruiting_research_tasks q
    JOIN runs r ON r.id = q."createdByRunId"
    JOIN owned o ON r."threadId" = o.id AND r."spaceId" = o."spaceId" AND r."userId" = o."userId"
    JOIN recruiting_roles rr ON rr.id = q."roleId" AND rr."spaceId" = o."spaceId" AND rr."userId" = o."userId"
    WHERE q.state = 'active'
    UNION ALL
    SELECT c.id, 'cloud_agent' AS kind, CASE WHEN c."cancelRequested" THEN 'cancelling' ELSE 'running' END AS status
    FROM cloud_agents c
    JOIN owned o ON c."threadId" = o.id AND c."spaceId" = o."spaceId" AND c."userId" = o."userId"
    WHERE c.status = 'running'
    UNION ALL
    SELECT r.id, 'run' AS kind, 'running' AS status
    FROM runs r
    JOIN owned o ON r."threadId" = o.id AND r."spaceId" = o."spaceId" AND r."userId" = o."userId"
    LEFT JOIN messages m ON m.id = r."sourceMessageId"
    WHERE r.status IN (${Prisma.join([...ACTIVE_RUN_STATUSES])})
      AND (r.trigger IN (${Prisma.join([...AUTOMATION_RUN_TRIGGERS])})
        OR m.blocks @> '[{"kind":"handoff"}]'::jsonb)
    UNION ALL
    SELECT e.id, 'agent_run' AS kind, 'running' AS status
    FROM external_effects e
    JOIN runs r ON r.id = e."runId"
    JOIN owned o ON r."threadId" = o.id AND r."spaceId" = o."spaceId" AND r."userId" = o."userId"
    WHERE e."spaceId" = o."spaceId" AND e.kind = 'work_estimate' AND e.status = 'running'
      AND starts_with(e."idempotencyKey", 'work_estimate:agent_run_')
    ORDER BY kind, id
  `;
}
