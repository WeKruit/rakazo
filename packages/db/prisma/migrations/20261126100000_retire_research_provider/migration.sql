-- The research provider is retired: people search finds, scales and grades. The product no longer
-- ships, calls or polls it, so its platform connection stops marking an account as a recruiting
-- crew and is switched off. Roles keep the people its tasks saved: those pages are proved against
-- the connection row, which therefore stays.

-- 1. A crew set up before the managed defaults was recognised by Main and Sourcer holding the
--    research connection. Record that as the legacy install it stands for, where none exists.
INSERT INTO "capability_installs" ("id", "spaceId", "userId", "kind", "name", "source", "version", "config")
SELECT DISTINCT
  'recruiting-defaults-' || encode(sha256(convert_to('["' || s."spaceId" || '","' || s."userId" || '"]', 'UTF8')), 'hex'),
  s."spaceId",
  s."userId",
  'plugin',
  'Recruiting defaults',
  'builtin:recruiting',
  'legacy',
  '{"legacy": true, "routines": {}}'::jsonb
FROM "mcp_servers" s
WHERE s."endpoint" = 'https://api.autumn.ai/mcp'
  AND (
    SELECT count(DISTINCT b."name")
    FROM "bot_mcp_servers" g
    JOIN "bots" b ON b."id" = g."botId"
    WHERE g."serverId" = s."id"
      AND b."spaceId" = s."spaceId"
      AND b."userId" = s."userId"
      AND b."archivedAt" IS NULL
      AND b."name" IN ('Main', 'Sourcer')
      AND (b."spawnKey" IS NULL OR b."spawnKey" NOT LIKE 'recruiting:%')
  ) = 2
  AND NOT EXISTS (
    SELECT 1 FROM "capability_installs" i
    WHERE i."spaceId" = s."spaceId"
      AND i."userId" = s."userId"
      AND i."kind" = 'plugin'
      AND i."source" = 'builtin:recruiting'
  )
ON CONFLICT ("id") DO NOTHING;

-- 2. Research that was still marked running is no longer followed.
UPDATE "recruiting_research_tasks" t
SET "state" = 'closed'
FROM "mcp_servers" s
WHERE s."id" = t."mcpServerId"
  AND s."endpoint" = 'https://api.autumn.ai/mcp'
  AND t."state" = 'active';

UPDATE "external_effects"
SET "status" = 'done'
WHERE "kind" = 'work_estimate'
  AND "status" = 'running'
  AND starts_with("idempotencyKey", 'work_estimate:research:');

-- 3. The connection the platform keyed (no secret of the account's own) is taken from every
--    assistant and switched off under a neutral name. A connection an account keyed itself is
--    its own and is left alone.
DELETE FROM "bot_mcp_servers" g
USING "mcp_servers" s
WHERE s."id" = g."serverId"
  AND s."endpoint" = 'https://api.autumn.ai/mcp'
  AND s."secretId" IS NULL;

UPDATE "mcp_servers"
SET "enabled" = false,
    "slug" = 'research-retired',
    "name" = 'Research (retired)',
    "description" = ''
WHERE "endpoint" = 'https://api.autumn.ai/mcp'
  AND "secretId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "mcp_servers" o
    WHERE o."spaceId" = "mcp_servers"."spaceId"
      AND o."userId" = "mcp_servers"."userId"
      AND o."slug" = 'research-retired'
  );

-- 4. Background checks queued for that research have no handler any more.
DO $$
BEGIN
  IF to_regclass('graphile_worker._private_jobs') IS NOT NULL THEN
    DELETE FROM graphile_worker._private_jobs j
    USING graphile_worker._private_tasks t
    WHERE t.id = j.task_id
      AND t.identifier = 'recruiting_research.poll'
      AND j.locked_at IS NULL;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
