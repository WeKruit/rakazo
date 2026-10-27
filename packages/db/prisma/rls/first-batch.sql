-- Explicit first-batch rollout, not an automatic migration.
-- Apply as the table owner only after provisioning the separate non-owner,
-- NOSUPERUSER NOBYPASSRLS API role and configuring ACTOR_DATABASE_URL.
-- Auth/background/migration connections retain their separately authorized role.
BEGIN;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON artifacts;
CREATE POLICY rakazo_actor_isolation ON artifacts FOR ALL
USING (
  "userId" = NULLIF(current_setting('app.user_id', true), '')
  AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND EXISTS (SELECT 1 FROM space_members sm WHERE sm."userId" = artifacts."userId" AND sm."spaceId" = artifacts."spaceId")
)
WITH CHECK (
  "userId" = NULLIF(current_setting('app.user_id', true), '')
  AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND EXISTS (SELECT 1 FROM space_members sm WHERE sm."userId" = artifacts."userId" AND sm."spaceId" = artifacts."spaceId")
);
ALTER TABLE recruiting_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_roles;
CREATE POLICY rakazo_actor_isolation ON recruiting_roles FOR ALL
USING (
  "userId" = NULLIF(current_setting('app.user_id', true), '')
  AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND EXISTS (SELECT 1 FROM space_members sm WHERE sm."userId" = recruiting_roles."userId" AND sm."spaceId" = recruiting_roles."spaceId")
)
WITH CHECK (
  "userId" = NULLIF(current_setting('app.user_id', true), '')
  AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND EXISTS (SELECT 1 FROM space_members sm WHERE sm."userId" = recruiting_roles."userId" AND sm."spaceId" = recruiting_roles."spaceId")
);
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON messages;
CREATE POLICY rakazo_actor_isolation ON messages FOR ALL
USING (EXISTS (
  SELECT 1 FROM threads t JOIN space_members sm ON sm."spaceId" = t."spaceId" AND sm."userId" = t."userId"
  WHERE t.id = messages."threadId"
    AND t."userId" = NULLIF(current_setting('app.user_id', true), '')
    AND t."spaceId" = NULLIF(current_setting('app.space_id', true), '')
))
WITH CHECK (EXISTS (
  SELECT 1 FROM threads t JOIN space_members sm ON sm."spaceId" = t."spaceId" AND sm."userId" = t."userId"
  WHERE t.id = messages."threadId"
    AND t."userId" = NULLIF(current_setting('app.user_id', true), '')
    AND t."spaceId" = NULLIF(current_setting('app.space_id', true), '')
));
COMMIT;
