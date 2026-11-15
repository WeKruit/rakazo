-- Run standalone: CONCURRENTLY cannot execute inside a transaction block.
-- The sidebar finds each role chat's creation event, which keeps its CRM role link, by thread
-- instead of filtering every event of every listed chat (seconds on accounts with busy roles).
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_group_created
ON events ("threadId", seq, id)
WHERE type = 'group.created';
