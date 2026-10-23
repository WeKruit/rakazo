-- AlterTable
ALTER TABLE "recruiting_candidates" ADD COLUMN "shortlistedAt" TIMESTAMP(3);

-- Only backfill a recorded shortlist event; unknown historic dates remain unknown.
UPDATE "recruiting_candidates" c
SET "shortlistedAt" = m."createdAt"
FROM "messages" m
WHERE c."shortlisted" AND m."id" = c."shortlistMessageId";
