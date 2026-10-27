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
  AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId" JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), ''))
)
WITH CHECK (
  "userId" = NULLIF(current_setting('app.user_id', true), '')
  AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId" JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), ''))
);
ALTER TABLE recruiting_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_roles;
CREATE POLICY rakazo_actor_isolation ON recruiting_roles FOR ALL
USING (
  "userId" = NULLIF(current_setting('app.user_id', true), '')
  AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId" JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), ''))
)
WITH CHECK (
  "userId" = NULLIF(current_setting('app.user_id', true), '')
  AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId" JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), ''))
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

-- Recruiting receipts and mirrors; parent reads use their own RLS policies.
-- Membership lookup uses actor constants so PostgreSQL can evaluate it once,
-- not once per returned row. Row ownership remains separately checked.
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON threads;
CREATE POLICY rakazo_actor_isolation ON threads FOR ALL
USING ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')));
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON tasks;
CREATE POLICY rakazo_actor_isolation ON tasks FOR ALL
USING ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')));
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON runs;
CREATE POLICY rakazo_actor_isolation ON runs FOR ALL
USING ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')));
ALTER TABLE external_effects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON external_effects;
CREATE POLICY rakazo_actor_isolation ON external_effects FOR ALL
USING (EXISTS (SELECT 1 FROM runs parent WHERE parent."id"=external_effects."runId") AND "spaceId" = NULLIF(current_setting('app.space_id', true), ''))
WITH CHECK (EXISTS (SELECT 1 FROM runs parent WHERE parent."id"=external_effects."runId") AND "spaceId" = NULLIF(current_setting('app.space_id', true), ''));
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON events;
CREATE POLICY rakazo_actor_isolation ON events FOR ALL
USING (EXISTS (SELECT 1 FROM threads parent WHERE parent."id"=events."threadId") AND "spaceId" = NULLIF(current_setting('app.space_id', true), ''))
WITH CHECK (EXISTS (SELECT 1 FROM threads parent WHERE parent."id"=events."threadId") AND "spaceId" = NULLIF(current_setting('app.space_id', true), ''));
ALTER TABLE recruiting_crm_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_crm_roles;
CREATE POLICY rakazo_actor_isolation ON recruiting_crm_roles FOR ALL
USING ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')) AND EXISTS (SELECT 1 FROM mcp_servers m WHERE m.id=recruiting_crm_roles."mcpServerId" AND m."userId"=recruiting_crm_roles."userId" AND m."spaceId"=recruiting_crm_roles."spaceId"));
ALTER TABLE recruiting_crm_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_crm_contacts;
CREATE POLICY rakazo_actor_isolation ON recruiting_crm_contacts FOR ALL
USING ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')) AND EXISTS (SELECT 1 FROM mcp_servers m WHERE m.id=recruiting_crm_contacts."mcpServerId" AND m."userId"=recruiting_crm_contacts."userId" AND m."spaceId"=recruiting_crm_contacts."spaceId"));
ALTER TABLE recruiting_crm_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_crm_messages;
CREATE POLICY rakazo_actor_isolation ON recruiting_crm_messages FOR ALL
USING ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')) AND EXISTS (SELECT 1 FROM mcp_servers m WHERE m.id=recruiting_crm_messages."mcpServerId" AND m."userId"=recruiting_crm_messages."userId" AND m."spaceId"=recruiting_crm_messages."spaceId"));
ALTER TABLE recruiting_crm_sync_progress ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_crm_sync_progress;
CREATE POLICY rakazo_actor_isolation ON recruiting_crm_sync_progress FOR ALL
USING ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')));
ALTER TABLE recruiting_crm_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_crm_campaigns;
CREATE POLICY rakazo_actor_isolation ON recruiting_crm_campaigns FOR ALL
USING ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')) AND EXISTS (SELECT 1 FROM mcp_servers m WHERE m.id=recruiting_crm_campaigns."mcpServerId" AND m."userId"=recruiting_crm_campaigns."userId" AND m."spaceId"=recruiting_crm_campaigns."spaceId"));
ALTER TABLE recruiting_crm_leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_crm_leads;
CREATE POLICY rakazo_actor_isolation ON recruiting_crm_leads FOR ALL
USING ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')) AND EXISTS (SELECT 1 FROM mcp_servers m WHERE m.id=recruiting_crm_leads."mcpServerId" AND m."userId"=recruiting_crm_leads."userId" AND m."spaceId"=recruiting_crm_leads."spaceId"));
ALTER TABLE recruiting_crm_workspace_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_crm_workspace_attachments;
CREATE POLICY rakazo_actor_isolation ON recruiting_crm_workspace_attachments FOR ALL
USING ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')) AND EXISTS (SELECT 1 FROM mcp_servers m WHERE m.id=recruiting_crm_workspace_attachments."mcpServerId" AND m."userId"=recruiting_crm_workspace_attachments."userId" AND m."spaceId"=recruiting_crm_workspace_attachments."spaceId") AND EXISTS (SELECT 1 FROM recruiting_roles parent WHERE parent."id"=recruiting_crm_workspace_attachments."roleId"));
ALTER TABLE recruiting_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_reminders;
CREATE POLICY rakazo_actor_isolation ON recruiting_reminders FOR ALL
USING ("ownerUserId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("ownerUserId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')) AND ("roleId" IS NULL OR EXISTS (SELECT 1 FROM recruiting_roles parent WHERE parent."id"=recruiting_reminders."roleId")));
ALTER TABLE recruiting_candidate_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_candidate_notes;
CREATE POLICY rakazo_actor_isolation ON recruiting_candidate_notes FOR ALL
USING ("ownerUserId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("ownerUserId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')) AND ("roleId" IS NULL OR EXISTS (SELECT 1 FROM recruiting_roles parent WHERE parent."id"=recruiting_candidate_notes."roleId")));
ALTER TABLE recruiting_saved_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_saved_profiles;
CREATE POLICY rakazo_actor_isolation ON recruiting_saved_profiles FOR ALL
USING ("ownerUserId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')))
WITH CHECK ("ownerUserId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id=sm."spaceId" AND s."organizationId"=sm."organizationId" JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId" WHERE sm."userId" = NULLIF(current_setting('app.user_id', true), '') AND sm."spaceId" = NULLIF(current_setting('app.space_id', true), '')) AND EXISTS (SELECT 1 FROM external_effects parent WHERE parent."id"=recruiting_saved_profiles."sourceEffectId"));
ALTER TABLE recruiting_research_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_research_tasks;
CREATE POLICY rakazo_actor_isolation ON recruiting_research_tasks FOR ALL
USING (EXISTS (SELECT 1 FROM recruiting_roles parent WHERE parent."id"=recruiting_research_tasks."roleId"))
WITH CHECK (EXISTS (SELECT 1 FROM recruiting_roles parent WHERE parent."id"=recruiting_research_tasks."roleId") AND EXISTS (SELECT 1 FROM runs parent WHERE parent."id"=recruiting_research_tasks."createdByRunId") AND EXISTS (SELECT 1 FROM mcp_servers m WHERE m.id=recruiting_research_tasks."mcpServerId" AND m."userId"=NULLIF(current_setting('app.user_id', true), '') AND m."spaceId"=NULLIF(current_setting('app.space_id', true), '')));
ALTER TABLE recruiting_assessments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_assessments;
CREATE POLICY rakazo_actor_isolation ON recruiting_assessments FOR ALL
USING (EXISTS (SELECT 1 FROM recruiting_roles parent WHERE parent."id"=recruiting_assessments."roleId"))
WITH CHECK (EXISTS (SELECT 1 FROM recruiting_roles parent WHERE parent."id"=recruiting_assessments."roleId") AND EXISTS (SELECT 1 FROM runs parent WHERE parent."id"=recruiting_assessments."createdByRunId") AND EXISTS (SELECT 1 FROM recruiting_role_revisions rev WHERE rev.id=recruiting_assessments."roleRevisionId" AND rev."roleId"=recruiting_assessments."roleId"));
ALTER TABLE recruiting_candidate_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_candidate_pages;
CREATE POLICY rakazo_actor_isolation ON recruiting_candidate_pages FOR ALL
USING (EXISTS (SELECT 1 FROM recruiting_roles parent WHERE parent."id"=recruiting_candidate_pages."roleId"))
WITH CHECK (EXISTS (SELECT 1 FROM recruiting_roles parent WHERE parent."id"=recruiting_candidate_pages."roleId") AND EXISTS (SELECT 1 FROM recruiting_role_revisions rev WHERE rev.id=recruiting_candidate_pages."roleRevisionId" AND rev."roleId"=recruiting_candidate_pages."roleId") AND EXISTS (SELECT 1 FROM external_effects parent WHERE parent."id"=recruiting_candidate_pages."effectId") AND EXISTS (SELECT 1 FROM artifacts parent WHERE parent."id"=recruiting_candidate_pages."artifactId") AND ("taskId" IS NULL OR EXISTS (SELECT 1 FROM recruiting_research_tasks parent WHERE parent."id"=recruiting_candidate_pages."taskId")) AND ("actionId" IS NULL OR EXISTS (SELECT 1 FROM recruiting_research_actions parent WHERE parent."id"=recruiting_candidate_pages."actionId")));
ALTER TABLE recruiting_candidate_occurrences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_candidate_occurrences;
CREATE POLICY rakazo_actor_isolation ON recruiting_candidate_occurrences FOR ALL
USING (EXISTS (SELECT 1 FROM recruiting_roles parent WHERE parent."id"=recruiting_candidate_occurrences."roleId"))
WITH CHECK (EXISTS (SELECT 1 FROM recruiting_roles parent WHERE parent."id"=recruiting_candidate_occurrences."roleId") AND EXISTS (SELECT 1 FROM recruiting_candidate_pages page WHERE page."effectId"=recruiting_candidate_occurrences."pageId" AND page."roleId"=recruiting_candidate_occurrences."roleId") AND EXISTS (SELECT 1 FROM recruiting_candidates c WHERE c."roleId"=recruiting_candidate_occurrences."roleId" AND c."candidateKey"=recruiting_candidate_occurrences."candidateKey"));
ALTER TABLE recruiting_research_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_research_actions;
CREATE POLICY rakazo_actor_isolation ON recruiting_research_actions FOR ALL
USING (EXISTS (SELECT 1 FROM recruiting_research_tasks parent WHERE parent."id"=recruiting_research_actions."taskId"))
WITH CHECK (EXISTS (SELECT 1 FROM recruiting_research_tasks parent WHERE parent."id"=recruiting_research_actions."taskId") AND EXISTS (SELECT 1 FROM recruiting_role_revisions rev JOIN recruiting_research_tasks task ON task."roleId"=rev."roleId" WHERE rev.id=recruiting_research_actions."roleRevisionId" AND task.id=recruiting_research_actions."taskId") AND EXISTS (SELECT 1 FROM runs parent WHERE parent."id"=recruiting_research_actions."runId") AND EXISTS (SELECT 1 FROM messages parent WHERE parent."id"=recruiting_research_actions."sourceMessageId") AND EXISTS (SELECT 1 FROM artifacts parent WHERE parent."id"=recruiting_research_actions."requestArtifactId") AND EXISTS (SELECT 1 FROM artifacts parent WHERE parent."id"=recruiting_research_actions."contextArtifactId") AND ("receiptArtifactId" IS NULL OR EXISTS (SELECT 1 FROM artifacts parent WHERE parent."id"=recruiting_research_actions."receiptArtifactId")) AND ("effectId" IS NULL OR EXISTS (SELECT 1 FROM external_effects parent WHERE parent."id"=recruiting_research_actions."effectId")));
ALTER TABLE recruiting_crm_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_crm_imports;
CREATE POLICY rakazo_actor_isolation ON recruiting_crm_imports FOR ALL
USING (EXISTS (SELECT 1 FROM recruiting_candidate_occurrences o WHERE o."pageId"=recruiting_crm_imports."pageId" AND o."rowIndex"=recruiting_crm_imports."rowIndex"))
WITH CHECK (EXISTS (SELECT 1 FROM recruiting_candidate_occurrences o WHERE o."pageId"=recruiting_crm_imports."pageId" AND o."rowIndex"=recruiting_crm_imports."rowIndex") AND EXISTS (SELECT 1 FROM external_effects parent WHERE parent."id"=recruiting_crm_imports."effectId") AND EXISTS (SELECT 1 FROM external_effects parent WHERE parent."id"=recruiting_crm_imports."bindingEffectId"));
ALTER TABLE recruiting_replies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_replies;
CREATE POLICY rakazo_actor_isolation ON recruiting_replies FOR ALL
USING (EXISTS (SELECT 1 FROM recruiting_role_revisions parent WHERE parent."id"=recruiting_replies."roleRevisionId"))
WITH CHECK (EXISTS (SELECT 1 FROM recruiting_role_revisions parent WHERE parent."id"=recruiting_replies."roleRevisionId") AND EXISTS (SELECT 1 FROM recruiting_crm_imports parent WHERE parent."effectId"=recruiting_replies."crmImportEffectId") AND EXISTS (SELECT 1 FROM external_effects parent WHERE parent."id"=recruiting_replies."effectId") AND EXISTS (SELECT 1 FROM external_effects parent WHERE parent."id"=recruiting_replies."emailReadEffectId") AND EXISTS (SELECT 1 FROM external_effects parent WHERE parent."id"=recruiting_replies."crmContextReadEffectId"));
ALTER TABLE recruiting_crm_role_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_crm_role_contacts;
CREATE POLICY rakazo_actor_isolation ON recruiting_crm_role_contacts FOR ALL
USING (EXISTS (SELECT 1 FROM recruiting_crm_roles parent WHERE parent."id"=recruiting_crm_role_contacts."roleId") AND EXISTS (SELECT 1 FROM recruiting_crm_contacts parent WHERE parent."id"=recruiting_crm_role_contacts."contactId"))
WITH CHECK (EXISTS (SELECT 1 FROM recruiting_crm_roles parent WHERE parent."id"=recruiting_crm_role_contacts."roleId") AND EXISTS (SELECT 1 FROM recruiting_crm_contacts parent WHERE parent."id"=recruiting_crm_role_contacts."contactId"));
COMMIT;
