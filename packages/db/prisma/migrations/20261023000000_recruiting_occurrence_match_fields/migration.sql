-- Provider match cells (rank/tier/score keys) copied from the saved row at write time.
-- NULL means not yet backfilled; the candidate read fills it lazily and idempotently.
ALTER TABLE "recruiting_candidate_occurrences" ADD COLUMN "matchFields" JSONB;
