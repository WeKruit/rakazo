-- Run standalone: CONCURRENTLY cannot execute inside a transaction block.
-- One live run per (thread, agent): the run row is the projection of the agent session's one
-- operation, so a second live row is a bug the database refuses.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "runs_one_active_per_agent"
ON "runs"("threadId", "botId")
WHERE "status" IN ('queued', 'leased', 'running', 'waiting_input', 'waiting_takeover');
