-- A role's own saved person was keyed "autumn:<key>" after the retired research provider. The
-- key space is ours, so it is now "sourced:<key>". Rewrite the two tables that store the key.
-- Recorded profile views are events and stay as written; they are read under both prefixes.
UPDATE "recruiting_reminders"
SET "candidateKey" = 'sourced:' || substr("candidateKey", 8)
WHERE starts_with("candidateKey", 'autumn:');

UPDATE "recruiting_candidate_notes"
SET "candidateKey" = 'sourced:' || substr("candidateKey", 8)
WHERE starts_with("candidateKey", 'autumn:');
