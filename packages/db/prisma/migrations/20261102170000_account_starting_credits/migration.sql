-- NULL keeps existing accounts unlimited. Each new account starts with $50 of service cost,
-- converted to product credits at the deployment rate in effect when it signs up.
ALTER TABLE "user" ADD COLUMN "usageCreditLimit" DOUBLE PRECISION;

CREATE FUNCTION "user_starting_credits"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."usageCreditLimit" IS NULL THEN
    NEW."usageCreditLimit" := 50 * COALESCE((SELECT "usageCreditsPerUsd" / (1 - "usageGrossMargin")
      FROM "deployment_settings" WHERE "id" = 'default'), 200);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "user_starting_credits" BEFORE INSERT ON "user"
FOR EACH ROW EXECUTE FUNCTION "user_starting_credits"();

-- The balance check sums one account's spend across its spaces before each new run.
CREATE INDEX "usage_records_userId_idx" ON "usage_records" ("userId");
