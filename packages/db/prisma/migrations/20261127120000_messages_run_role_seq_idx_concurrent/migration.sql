-- Run standalone: CONCURRENTLY cannot execute inside a transaction block.
-- A run's messages of one role are read in order (thinking, recruiting history, event replay);
-- without this each read scanned the thread's whole message history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_runId_role_seq_idx"
ON "messages"("runId", "role", "seq");
