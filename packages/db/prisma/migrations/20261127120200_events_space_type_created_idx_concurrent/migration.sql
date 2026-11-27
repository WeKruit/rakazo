-- Run standalone: CONCURRENTLY cannot execute inside a transaction block.
-- Space-wide reads of one event type filtered every event of the space by type (seconds on busy
-- spaces).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_spaceId_type_createdAt_idx"
ON "events"("spaceId", "type", "createdAt");
