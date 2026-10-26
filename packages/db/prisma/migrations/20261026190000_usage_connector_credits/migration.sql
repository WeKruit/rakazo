-- Connector results that report their own credit cost (contact enrichment) also count as credits.

-- The JSON body of an MCP tool result: structured content, else the first JSON text block.
CREATE OR REPLACE FUNCTION "usage_mcp_body"(result JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  block JSONB;
BEGIN
  IF jsonb_typeof(result) <> 'object' THEN RETURN NULL; END IF;
  IF jsonb_typeof(result->'structuredContent') = 'object' THEN RETURN result->'structuredContent'; END IF;
  IF jsonb_typeof(result->'content') = 'array' THEN
    FOR block IN SELECT value FROM jsonb_array_elements(result->'content') LOOP
      IF block->>'type' = 'text' AND left(ltrim(block->>'text'), 1) = '{' THEN
        BEGIN
          RETURN (block->>'text')::JSONB;
        EXCEPTION WHEN others THEN
          NULL;
        END;
      END IF;
    END LOOP;
  END IF;
  RETURN result;
END $$;

-- One credits row per provider job that reports `cost.credits`, however often it is read.
CREATE OR REPLACE FUNCTION "usage_record_connector_credits"(
  effect_id TEXT, space_id TEXT, run_id TEXT, route JSONB, result JSONB, at TIMESTAMP(3)
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  body JSONB := "usage_mcp_body"(result);
BEGIN
  IF body IS NULL OR jsonb_typeof(body->'cost'->'credits') IS DISTINCT FROM 'number'
    OR (body->'cost'->>'credits')::DOUBLE PRECISION <= 0 THEN
    RETURN;
  END IF;
  INSERT INTO "usage_records" (
    "id", "spaceId", "userId", "botId", "runId", "parentRunId", "provider", "model",
    "unit", "quantity", "usageSource", "callId", "operationKind", "createdAt"
  )
  SELECT
    'ul_' || replace(gen_random_uuid()::text, '-', ''), space_id, ru."userId", ru."botId",
    ru."id", ru."id", COALESCE(s."slug", 'connector'), route->>'toolName',
    'credits', (body->'cost'->>'credits')::DOUBLE PRECISION, 'provider_receipt',
    'credits:' || COALESCE(s."slug", 'connector') || ':' || COALESCE(body->>'id', effect_id),
    'retrieval', at
  FROM "runs" ru
  LEFT JOIN "mcp_servers" s ON s."id" = route->>'resourceId'
  WHERE ru."id" = run_id
  ON CONFLICT ("callId") DO NOTHING;
END $$;

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
  PERFORM "usage_record_connector_credits"(
    NEW."id", NEW."spaceId", NEW."runId", route, NEW."result", NEW."updatedAt"
  );
  RETURN NEW;
END $$;

-- History: credits already reported by completed connector calls.
SELECT "usage_record_connector_credits"(
  e."id", e."spaceId", e."runId", "usage_catalog_route"(e."request"), e."result", e."updatedAt"
)
FROM "external_effects" e
WHERE e."status" = 'completed' AND e."request"->>0 = '__rakazoCatalogTool'
  AND "usage_catalog_route"(e."request")->>'connectorId' = 'mcp'
  AND e."result"::TEXT LIKE '%credits%'
ORDER BY e."updatedAt";
