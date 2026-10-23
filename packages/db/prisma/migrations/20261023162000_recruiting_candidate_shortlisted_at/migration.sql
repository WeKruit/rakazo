-- AlterTable
ALTER TABLE "recruiting_candidates" ADD COLUMN "shortlistedAt" TIMESTAMP(3);

-- Backfill: the candidate row has no timestamps of its own, so use the shortlist message's creation
-- time, falling back to now for rows without one.
UPDATE "recruiting_candidates" c
SET "shortlistedAt" = COALESCE(
  (SELECT m."createdAt" FROM "messages" m WHERE m."id" = c."shortlistMessageId"),
  CURRENT_TIMESTAMP
)
WHERE c."shortlisted";
