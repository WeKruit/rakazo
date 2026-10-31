ALTER TABLE "deployment_settings"
  ADD COLUMN "usageCreditsPerUsd" DOUBLE PRECISION NOT NULL DEFAULT 100,
  ADD COLUMN "usageGrossMargin" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD CONSTRAINT "usage_pricing_valid" CHECK (
    "usageCreditsPerUsd" > 0 AND "usageCreditsPerUsd" < 'Infinity'::float8
    AND "usageGrossMargin" >= 0 AND "usageGrossMargin" < 1
  );
ALTER TABLE "usage_records" ADD COLUMN "creditRate" DOUBLE PRECISION NOT NULL DEFAULT 200;

-- Snapshot service list prices at the shared ledger boundary, including trigger-written rows.
CREATE FUNCTION "usage_service_cost"(provider TEXT, unit TEXT, tool TEXT, quantity DOUBLE PRECISION)
RETURNS DOUBLE PRECISION LANGUAGE sql IMMUTABLE AS $$
  SELECT quantity * CASE
    WHEN unit = 'credits' AND provider = 'autumn' THEN 850.0 / 100000
    WHEN unit = 'credits' AND provider = 'fullenrich' THEN 29.0 / 500
    WHEN unit = 'credits' AND provider = 'people-search' THEN 1
    WHEN unit = 'calls' AND provider = 'people-search' AND tool IN ('web_search_exa', 'web_search_advanced_exa') THEN 7.0 / 1000
    WHEN unit = 'calls' AND provider = 'people-search' AND tool IN ('agent_run', 'agent_run_status', 'agent_run_list', 'get_task') THEN 0
    WHEN unit = 'calls' AND provider IN ('autumn', 'fullenrich', 'recruiting-crm', 'instantly', 'cal-com', 'gmail') THEN 0
    ELSE NULL END
$$;

CREATE FUNCTION "usage_records_snapshot_price"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."creditRate" := COALESCE((SELECT "usageCreditsPerUsd" / (1 - "usageGrossMargin")
    FROM "deployment_settings" WHERE "id" = 'default'), 200);
  IF NEW."costUsd" IS NULL AND NEW."unit" IN ('credits', 'calls') THEN
    NEW."costUsd" := "usage_service_cost"(NEW."provider", NEW."unit", NEW."model", NEW."quantity");
    IF NEW."costUsd" IS NOT NULL THEN
      NEW."costSource" := 'service-list-estimate';
      NEW."pricingVersion" := '2026-10-30';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "usage_records_snapshot_price" BEFORE INSERT ON "usage_records"
FOR EACH ROW EXECUTE FUNCTION "usage_records_snapshot_price"();

-- Existing service history adopts the initial product-credit rate; future changes never reprice it.
UPDATE "usage_records"
SET "costUsd" = "usage_service_cost"("provider", "unit", "model", "quantity"),
    "costSource" = 'service-list-estimate', "pricingVersion" = '2026-10-30'
WHERE "costUsd" IS NULL AND "unit" IN ('credits', 'calls')
  AND "usage_service_cost"("provider", "unit", "model", "quantity") IS NOT NULL;

-- Legacy model-cost finalization visits only unpriced measured rows, including after recovery.
CREATE INDEX "usage_records_pending_cost_idx" ON "usage_records" ("id")
WHERE "unit" = 'tokens' AND "costUsd" IS NULL AND "inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL;
