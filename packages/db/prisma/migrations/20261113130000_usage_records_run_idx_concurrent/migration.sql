-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
-- Deleting a run sets usage_records."runId" to null; without an index every deleted run scans
-- the whole table, so deleting a bot, its runs or a whole space timed out.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "usage_records_runId_idx" ON "usage_records"("runId");
