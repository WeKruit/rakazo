-- Run standalone: CONCURRENTLY cannot execute inside a transaction block.
-- Most reads of saved tool results filter by account, kind and status (a role's campaign link,
-- confirmed sends, saved searches). With no index starting at the account, each one scanned
-- every saved result of every account: about 170 ms idle on staging and seconds under load.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "external_effects_spaceId_kind_status_updatedAt_idx"
ON external_effects ("spaceId", kind, status, "updatedAt");
