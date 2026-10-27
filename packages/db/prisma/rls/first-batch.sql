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
  AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId" JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId" WHERE sm."userId" = artifacts."userId" AND sm."spaceId" = artifacts."spaceId")
)
WITH CHECK (
  "userId" = NULLIF(current_setting('app.user_id', true), '')
  AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId" JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId" WHERE sm."userId" = artifacts."userId" AND sm."spaceId" = artifacts."spaceId")
);
ALTER TABLE recruiting_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_roles;
CREATE POLICY rakazo_actor_isolation ON recruiting_roles FOR ALL
USING (
  "userId" = NULLIF(current_setting('app.user_id', true), '')
  AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId" JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId" WHERE sm."userId" = recruiting_roles."userId" AND sm."spaceId" = recruiting_roles."spaceId")
)
WITH CHECK (
  "userId" = NULLIF(current_setting('app.user_id', true), '')
  AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId" JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId" WHERE sm."userId" = recruiting_roles."userId" AND sm."spaceId" = recruiting_roles."spaceId")
);
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON messages;
CREATE POLICY rakazo_actor_isolation ON messages FOR ALL
USING (EXISTS (
  SELECT 1 FROM threads t JOIN space_members sm ON sm."spaceId" = t."spaceId" AND sm."userId" = t."userId"
  JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId"
  JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId"
  WHERE t.id = messages."threadId"
    AND t."userId" = NULLIF(current_setting('app.user_id', true), '')
    AND t."spaceId" = NULLIF(current_setting('app.space_id', true), '')
))
WITH CHECK (EXISTS (
  SELECT 1 FROM threads t JOIN space_members sm ON sm."spaceId" = t."spaceId" AND sm."userId" = t."userId"
  JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId"
  JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId"
  WHERE t.id = messages."threadId"
    AND t."userId" = NULLIF(current_setting('app.user_id', true), '')
    AND t."spaceId" = NULLIF(current_setting('app.space_id', true), '')
));
-- These core child rows inherit the already-protected role boundary. The role
-- policy does not query its revision, avoiding a recursive RLS dependency.
ALTER TABLE recruiting_role_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_role_revisions;
CREATE POLICY rakazo_actor_isolation ON recruiting_role_revisions FOR ALL
USING (EXISTS (SELECT 1 FROM recruiting_roles r WHERE r.id = recruiting_role_revisions."roleId"))
WITH CHECK (EXISTS (SELECT 1 FROM recruiting_roles r WHERE r.id = recruiting_role_revisions."roleId"));
ALTER TABLE recruiting_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_candidates;
CREATE POLICY rakazo_actor_isolation ON recruiting_candidates FOR ALL
USING (EXISTS (SELECT 1 FROM recruiting_roles r WHERE r.id = recruiting_candidates."roleId"))
WITH CHECK (EXISTS (SELECT 1 FROM recruiting_roles r WHERE r.id = recruiting_candidates."roleId")
  AND ("shortlistMessageId" IS NULL OR EXISTS (SELECT 1 FROM messages m WHERE m.id = recruiting_candidates."shortlistMessageId")));
ALTER TABLE recruiting_calibration_rounds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_calibration_rounds;
CREATE POLICY rakazo_actor_isolation ON recruiting_calibration_rounds FOR ALL
USING (EXISTS (SELECT 1 FROM recruiting_roles r WHERE r.id = recruiting_calibration_rounds."roleId"))
WITH CHECK (EXISTS (SELECT 1 FROM recruiting_roles r WHERE r.id = recruiting_calibration_rounds."roleId")
  AND ("approvedByUserId" IS NULL OR "approvedByUserId" = NULLIF(current_setting('app.user_id', true), '')));
COMMIT;
