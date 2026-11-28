-- An agent's session runs one operation at a time, so a conversation holds at most one live run per
-- agent. The run harness allowed parallel runs; before the unique index, every live run but the
-- newest per (thread, agent) ends as "upgraded", the same record the session cutover writes.
UPDATE "runs" AS r
SET "status" = 'cancelled', "error" = 'upgraded', "completedAt" = now(),
    "leaseOwner" = NULL, "leaseExpiresAt" = NULL
FROM (
  SELECT "id",
         row_number() OVER (PARTITION BY "threadId", "botId" ORDER BY "createdAt" DESC, "id" DESC) AS rank
  FROM "runs"
  WHERE "status" IN ('queued', 'leased', 'running', 'waiting_input', 'waiting_takeover')
) AS live
WHERE r."id" = live."id" AND live.rank > 1;
