-- Run standalone: CONCURRENTLY cannot execute inside a transaction block.
-- Only newly marked candidate saves are background profile intents; legacy saves stay unindexed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS recruiting_profile_projection_intents
ON external_effects ("createdAt", id)
WHERE kind = 'recruiting_research'
  AND status = 'completed'
  AND result->>'profileFactsVersion' = '1';
