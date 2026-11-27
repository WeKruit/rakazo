-- Two facts a run used to leave only in text. Both are NULL on runs from before these columns.
-- stopKind: why a completed run ended early (loop_guard, cost, time).
-- checkinReplyIds: the candidate reply ids a reply check-in reported.
ALTER TABLE "runs" ADD COLUMN "stopKind" TEXT;
ALTER TABLE "runs" ADD COLUMN "checkinReplyIds" JSONB;

-- A check-in re-reads the six hours before the last one, so the last days' check-ins get the ids
-- their prompt listed; without them those replies would be reported a second time. Only the few
-- recent check-in runs are touched; older ones stay NULL and are outside that window.
UPDATE "runs" r
SET "checkinReplyIds" = COALESCE(
  (SELECT jsonb_agg(m[1]) FROM regexp_matches(t."prompt", '\(reply id: ([^)\s]+)\)$', 'gn') AS m),
  '[]'::jsonb
)
FROM "tasks" t
WHERE t."id" = r."taskId"
  AND r."trigger" = 'recruiting_checkin'
  AND r."createdAt" > CURRENT_TIMESTAMP - INTERVAL '2 days';
