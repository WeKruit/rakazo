-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
-- Finds an account's completed direct tool receipts for one connection and tool (saved contact
-- lookups, owned agent runs and enrichment jobs) without reading every effect of the account.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "external_effects_direct_tool_receipts_idx" ON "external_effects" (("request" #>> '{2,route,resourceId}'), ("request" #>> '{2,route,toolName}'), "createdAt" DESC, "id" DESC) WHERE "status" = 'completed' AND ("request" #>> '{2,route,resourceId}') IS NOT NULL;
