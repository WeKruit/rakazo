-- Run standalone: CONCURRENTLY cannot execute inside a transaction block.
-- The Instantly binding lookup finds one user's runs in a space; without this it read every run
-- of every bot in the space.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "runs_spaceId_userId_createdAt_idx"
ON "runs"("spaceId", "userId", "createdAt");
