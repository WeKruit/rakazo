CREATE TABLE recruiting_inbox_index_progress (
 user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 native_cursor JSONB,
 imports_complete BOOLEAN NOT NULL DEFAULT false,
 crm_complete BOOLEAN NOT NULL DEFAULT false,
 checked_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id,space_id)
);
DO $rls$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='public' AND f.proname='rakazo_actor_member' AND f.pronargs=0) THEN
ALTER TABLE recruiting_inbox_index_progress ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_inbox_index_progress;
CREATE POLICY rakazo_actor_isolation ON recruiting_inbox_index_progress FOR ALL
USING (user_id = NULLIF(current_setting('app.user_id', true), '') AND space_id = NULLIF(current_setting('app.space_id', true), '') AND (SELECT public.rakazo_actor_member()))
WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '') AND space_id = NULLIF(current_setting('app.space_id', true), '') AND (SELECT public.rakazo_actor_member()));
 END IF;
END $rls$;
