-- One usage ledger for every kind of spend: model tokens, research credits and connector calls.
ALTER TABLE "usage_records" ADD COLUMN "unit" TEXT NOT NULL DEFAULT 'tokens';
ALTER TABLE "usage_records" ADD COLUMN "quantity" DOUBLE PRECISION;
ALTER TABLE "usage_records" ADD COLUMN "roleId" TEXT;

CREATE INDEX "usage_records_spaceId_userId_unit_createdAt_idx" ON "usage_records"("spaceId", "userId", "unit", "createdAt");
CREATE INDEX "usage_records_roleId_createdAt_idx" ON "usage_records"("roleId", "createdAt");

-- The recruiting role a run worked on, read when the spend happens so it outlives the run.
CREATE OR REPLACE FUNCTION "usage_run_role"(run_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    t."activeRecruitingRoleId",
    (SELECT r."id" FROM "recruiting_roles" r WHERE r."sourceThreadId" = t."id" ORDER BY r."id" LIMIT 1)
  )
  FROM "runs" ru JOIN "threads" t ON t."id" = ru."threadId"
  WHERE ru."id" = run_id
$$;

CREATE OR REPLACE FUNCTION "usage_records_fill_role"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."roleId" IS NULL THEN
    NEW."roleId" := "usage_run_role"(COALESCE(NEW."parentRunId", NEW."runId"));
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "usage_records_fill_role"
BEFORE INSERT ON "usage_records"
FOR EACH ROW EXECUTE FUNCTION "usage_records_fill_role"();

-- The connector route of a completed catalog tool call, in either recorded request shape.
CREATE OR REPLACE FUNCTION "usage_catalog_route"(request JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(request) <> 'array' OR request->>0 IS DISTINCT FROM '__rakazoCatalogTool' THEN NULL
    WHEN jsonb_array_length(request) = 3 AND request->>1 = 'direct' THEN request->2->'route'
    ELSE request->3
  END
$$;

-- Each completed connector call is one "calls" row, whichever execution path completed it.
CREATE OR REPLACE FUNCTION "usage_record_connector_call"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  route JSONB := "usage_catalog_route"(NEW."request");
BEGIN
  IF route IS NULL OR route->>'connectorId' IS DISTINCT FROM 'mcp' OR route->>'toolName' IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO "usage_records" (
    "id", "spaceId", "userId", "botId", "runId", "parentRunId", "provider", "model",
    "unit", "quantity", "usageSource", "callId", "operationKind", "createdAt"
  )
  SELECT
    'ul_' || replace(gen_random_uuid()::text, '-', ''), NEW."spaceId", ru."userId", ru."botId",
    ru."id", ru."id", COALESCE(s."slug", 'connector'), route->>'toolName',
    'calls', 1, 'connector_call', 'call:' || NEW."id", 'retrieval', NEW."updatedAt"
  FROM "runs" ru
  LEFT JOIN "mcp_servers" s ON s."id" = route->>'resourceId'
  WHERE ru."id" = NEW."runId"
  ON CONFLICT ("callId") DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER "usage_connector_call_insert"
AFTER INSERT ON "external_effects"
FOR EACH ROW WHEN (NEW."status" = 'completed' AND NEW."request"->>0 = '__rakazoCatalogTool')
EXECUTE FUNCTION "usage_record_connector_call"();

CREATE TRIGGER "usage_connector_call_update"
AFTER UPDATE OF "status" ON "external_effects"
FOR EACH ROW WHEN (
  NEW."status" = 'completed' AND OLD."status" IS DISTINCT FROM 'completed'
  AND NEW."request"->>0 = '__rakazoCatalogTool'
)
EXECUTE FUNCTION "usage_record_connector_call"();

-- A research task reports its credits as a running total; the ledger keeps each increase.
CREATE OR REPLACE FUNCTION "usage_research_credits"(usage JSONB) RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE AS $$
  SELECT MAX((item->>'amount')::DOUBLE PRECISION)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(usage) = 'array' THEN usage ELSE '[]'::jsonb END) item
  WHERE item->>'unit' = 'credits' AND item->>'scope' = 'task' AND jsonb_typeof(item->'amount') = 'number'
$$;

CREATE OR REPLACE FUNCTION "usage_record_research_credits"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  total DOUBLE PRECISION := "usage_research_credits"(NEW."usage");
  recorded DOUBLE PRECISION;
BEGIN
  IF total IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM("quantity"), 0) INTO recorded
  FROM "usage_records" WHERE "unit" = 'credits' AND "operationId" = NEW."taskId";
  IF total <= recorded THEN RETURN NEW; END IF;
  INSERT INTO "usage_records" (
    "id", "spaceId", "userId", "botId", "runId", "parentRunId", "roleId", "provider", "model",
    "unit", "quantity", "usageSource", "callId", "operationId", "operationKind"
  )
  SELECT
    'ul_' || replace(gen_random_uuid()::text, '-', ''), ro."spaceId", ro."userId", ru."botId",
    ru."id", ru."id", ro."id", COALESCE(s."slug", 'research'), NEW."kind",
    'credits', total - recorded, 'provider_receipt', 'credits:' || NEW."taskId" || ':' || total::text,
    NEW."taskId", 'retrieval'
  FROM "recruiting_research_tasks" ta
  JOIN "recruiting_roles" ro ON ro."id" = ta."roleId"
  LEFT JOIN "runs" ru ON ru."id" = NEW."runId"
  LEFT JOIN "mcp_servers" s ON s."id" = ta."mcpServerId"
  WHERE ta."id" = NEW."taskId"
  ON CONFLICT ("callId") DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER "usage_research_credits"
AFTER INSERT OR UPDATE OF "usage" ON "recruiting_research_actions"
FOR EACH ROW WHEN (NEW."usage" IS NOT NULL)
EXECUTE FUNCTION "usage_record_research_credits"();

-- History: attribute existing model usage to roles, and record past credits and calls once.
UPDATE "usage_records" SET "roleId" = "usage_run_role"(COALESCE("parentRunId", "runId"))
WHERE "roleId" IS NULL AND COALESCE("parentRunId", "runId") IS NOT NULL;

INSERT INTO "usage_records" (
  "id", "spaceId", "userId", "botId", "runId", "parentRunId", "roleId", "provider", "model",
  "unit", "quantity", "usageSource", "callId", "operationKind", "createdAt"
)
SELECT
  'ul_' || replace(gen_random_uuid()::text, '-', ''), e."spaceId", ru."userId", ru."botId",
  ru."id", ru."id", "usage_run_role"(ru."id"), COALESCE(s."slug", 'connector'),
  "usage_catalog_route"(e."request")->>'toolName', 'calls', 1, 'connector_call', 'call:' || e."id",
  'retrieval', e."updatedAt"
FROM "external_effects" e
JOIN "runs" ru ON ru."id" = e."runId"
LEFT JOIN "mcp_servers" s ON s."id" = "usage_catalog_route"(e."request")->>'resourceId'
WHERE e."status" = 'completed' AND e."request"->>0 = '__rakazoCatalogTool'
  AND "usage_catalog_route"(e."request")->>'connectorId' = 'mcp'
  AND "usage_catalog_route"(e."request")->>'toolName' IS NOT NULL
ON CONFLICT ("callId") DO NOTHING;

WITH readings AS (
  SELECT
    a."taskId", a."runId", a."kind", "usage_research_credits"(a."usage") AS total,
    COALESCE(e."updatedAt", ru."createdAt") AS at
  FROM "recruiting_research_actions" a
  LEFT JOIN "external_effects" e ON e."id" = a."effectId"
  LEFT JOIN "runs" ru ON ru."id" = a."runId"
  WHERE "usage_research_credits"(a."usage") IS NOT NULL
), running AS (
  SELECT *, MAX(total) OVER (PARTITION BY "taskId" ORDER BY at ROWS UNBOUNDED PRECEDING) AS high
  FROM readings
), increases AS (
  SELECT *, high - COALESCE(LAG(high) OVER (PARTITION BY "taskId" ORDER BY at), 0) AS increase
  FROM running
)
INSERT INTO "usage_records" (
  "id", "spaceId", "userId", "botId", "runId", "parentRunId", "roleId", "provider", "model",
  "unit", "quantity", "usageSource", "callId", "operationId", "operationKind", "createdAt"
)
SELECT
  'ul_' || replace(gen_random_uuid()::text, '-', ''), ro."spaceId", ro."userId", ru."botId",
  ru."id", ru."id", ro."id", COALESCE(s."slug", 'research'), i."kind", 'credits', i.increase,
  'provider_receipt', 'credits:' || i."taskId" || ':' || i.high::text, i."taskId", 'retrieval', i.at
FROM increases i
JOIN "recruiting_research_tasks" ta ON ta."id" = i."taskId"
JOIN "recruiting_roles" ro ON ro."id" = ta."roleId"
LEFT JOIN "runs" ru ON ru."id" = i."runId"
LEFT JOIN "mcp_servers" s ON s."id" = ta."mcpServerId"
WHERE i.increase > 0
ON CONFLICT ("callId") DO NOTHING;
