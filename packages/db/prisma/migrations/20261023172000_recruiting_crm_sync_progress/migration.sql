CREATE TABLE "recruiting_crm_sync_progress" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "targetKey" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "progress" JSONB NOT NULL,
  PRIMARY KEY ("userId", "spaceId")
);

ALTER TABLE "recruiting_crm_contacts" ADD COLUMN "profile" JSONB;
