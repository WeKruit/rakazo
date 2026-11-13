-- Run standalone: CONCURRENTLY cannot execute inside a transaction block.
-- A role's candidate list finds its pages' profile intents by source page instead of reading
-- every account's intent results.
CREATE INDEX CONCURRENTLY IF NOT EXISTS recruiting_profile_projection_sources
ON external_effects ((result->>'sourceEffectId'))
WHERE kind = 'recruiting_research'
  AND status = 'completed'
  AND result->>'profileFactsVersion' = '1';
