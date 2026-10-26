-- Research credits are now attributed from balance readings only; per-task readings never
-- arrive from the provider, and keeping both paths could count the same spend twice.
DROP TRIGGER IF EXISTS "usage_research_credits" ON "recruiting_research_actions";

-- Some services report spend only as an account-wide balance (research credits). Each balance
-- reading is kept as a "balance" row; the increase since the previous reading is split across
-- the accounts, roles and runs that called that service in between, by their share of calls.

CREATE OR REPLACE FUNCTION "usage_record_balance"(
  effect_id TEXT, space_id TEXT, run_id TEXT, route JSONB, result JSONB, at TIMESTAMP(3)
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  body JSONB;
  slug TEXT;
  used DOUBLE PRECISION;
  previous RECORD;
  spent DOUBLE PRECISION;
  window_calls DOUBLE PRECISION;
BEGIN
  body := "usage_mcp_body"(result);
  IF body IS NULL OR jsonb_typeof(body) IS DISTINCT FROM 'object' THEN RETURN; END IF;
  -- A running "used" total (research), or a remaining balance read as negative "used"
  -- (contact enrichment's get_credits), so spend is always an increase.
  IF jsonb_typeof(body->'credits_used') = 'number'
    AND jsonb_typeof(body->'credits_remaining') = 'number' THEN
    used := (body->>'credits_used')::DOUBLE PRECISION;
  ELSIF route->>'toolName' = 'get_credits' AND jsonb_typeof(body->'credits') = 'number' THEN
    used := -((body->>'credits')::DOUBLE PRECISION);
  ELSE
    RETURN;
  END IF;
  SELECT s."slug" INTO slug FROM "mcp_servers" s WHERE s."id" = route->>'resourceId';
  slug := COALESCE(slug, 'connector');

  SELECT b."quantity", b."createdAt" INTO previous
  FROM "usage_records" b
  WHERE b."unit" = 'balance' AND b."provider" = slug AND b."createdAt" <= at
    AND b."callId" <> 'balance:' || effect_id
  ORDER BY b."createdAt" DESC, b."id" DESC LIMIT 1;

  INSERT INTO "usage_records" (
    "id", "spaceId", "userId", "botId", "runId", "parentRunId", "provider", "model",
    "unit", "quantity", "usageSource", "callId", "operationKind", "createdAt"
  )
  SELECT
    'ul_' || replace(gen_random_uuid()::text, '-', ''), space_id, ru."userId", ru."botId",
    ru."id", ru."id", slug, route->>'toolName', 'balance', used, 'provider_balance',
    'balance:' || effect_id, 'retrieval', at
  FROM "runs" ru WHERE ru."id" = run_id
  ON CONFLICT ("callId") DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;

  -- No earlier reading, or a billing reset: nothing to attribute.
  IF previous."quantity" IS NULL OR used <= previous."quantity" THEN RETURN; END IF;
  spent := used - previous."quantity";

  SELECT COUNT(*) INTO window_calls FROM "usage_records" c
  WHERE c."unit" = 'calls' AND c."provider" = slug AND c."model" <> route->>'toolName'
    AND c."createdAt" > previous."createdAt" AND c."createdAt" <= at;

  IF window_calls = 0 THEN
    -- Nobody here called the service in between: the reader's run carries it.
    INSERT INTO "usage_records" (
      "id", "spaceId", "userId", "botId", "runId", "parentRunId", "provider", "model",
      "unit", "quantity", "usageSource", "callId", "operationKind", "createdAt"
    )
    SELECT
      'ul_' || replace(gen_random_uuid()::text, '-', ''), space_id, ru."userId", ru."botId",
      ru."id", ru."id", slug, route->>'toolName', 'credits', spent, 'provider_balance_share',
      'credits:' || effect_id, 'retrieval', at
    FROM "runs" ru WHERE ru."id" = run_id
    ON CONFLICT ("callId") DO NOTHING;
    RETURN;
  END IF;

  INSERT INTO "usage_records" (
    "id", "spaceId", "userId", "botId", "runId", "parentRunId", "roleId", "provider", "model",
    "unit", "quantity", "usageSource", "callId", "operationKind", "createdAt"
  )
  SELECT
    'ul_' || replace(gen_random_uuid()::text, '-', ''), c."spaceId", c."userId", MIN(c."botId"),
    c."runId", c."runId", c."roleId", slug, 'share', 'credits',
    spent * COUNT(*) / window_calls, 'provider_balance_share',
    'credits:' || effect_id || ':' || c."spaceId" || ':' || c."userId" || ':'
      || COALESCE(c."runId", '') || ':' || COALESCE(c."roleId", ''),
    'retrieval', at
  FROM "usage_records" c
  WHERE c."unit" = 'calls' AND c."provider" = slug AND c."model" <> route->>'toolName'
    AND c."createdAt" > previous."createdAt" AND c."createdAt" <= at
  GROUP BY c."spaceId", c."userId", c."runId", c."roleId"
  ON CONFLICT ("callId") DO NOTHING;
EXCEPTION WHEN others THEN
  RAISE WARNING 'usage balance not recorded for effect %: %', effect_id, SQLERRM;
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
  PERFORM "usage_record_balance"(
    NEW."id", NEW."spaceId", NEW."runId", route, NEW."result", NEW."updatedAt"
  );
  RETURN NEW;
EXCEPTION WHEN others THEN
  RAISE WARNING 'usage call not recorded for effect %: %', NEW."id", SQLERRM;
  RETURN NEW;
END $$;

-- History: replay every past balance reading in order.
SELECT "usage_record_balance"(
  e."id", e."spaceId", e."runId", "usage_catalog_route"(e."request"), e."result", e."updatedAt"
)
FROM "external_effects" e
WHERE e."status" = 'completed' AND e."request"->>0 = '__rakazoCatalogTool'
  AND "usage_catalog_route"(e."request")->>'connectorId' = 'mcp'
  AND e."result"::TEXT LIKE '%credits%'
ORDER BY e."updatedAt", e."id";
