-- Run standalone: CONCURRENTLY cannot execute inside a transaction block.
-- The history fill reads recent messages every minute; without this it scanned the whole table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_createdAt_idx"
ON "messages"("createdAt");
