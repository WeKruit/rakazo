-- Run standalone: CONCURRENTLY cannot execute inside a transaction block.
-- The profile check reads recent completed research effects every 30 seconds; without this it
-- scanned the whole table on each pass.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "external_effects_kind_status_createdAt_id_idx"
ON "external_effects"("kind", "status", "createdAt", "id");
