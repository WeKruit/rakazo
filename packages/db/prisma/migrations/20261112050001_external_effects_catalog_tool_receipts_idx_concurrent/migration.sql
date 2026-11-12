-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
-- The same receipts made through the tool catalog, whose route sits at the request's fourth item.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "external_effects_catalog_tool_receipts_idx" ON "external_effects" (("request" #>> '{3,resourceId}'), ("request" #>> '{3,toolName}'), "createdAt" DESC, "id" DESC) WHERE "status" = 'completed' AND ("request" #>> '{3,resourceId}') IS NOT NULL;
