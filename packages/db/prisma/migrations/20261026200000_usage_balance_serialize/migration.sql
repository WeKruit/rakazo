-- Serialize balance attribution per service and index the window lookups.
CREATE INDEX "usage_records_unit_provider_createdAt_idx" ON "usage_records"("unit", "provider", "createdAt");

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
  -- One reading per service at a time, so two concurrent readings cannot claim the same window.
  PERFORM pg_advisory_xact_lock(hashtext('usage_balance:' || slug));

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

