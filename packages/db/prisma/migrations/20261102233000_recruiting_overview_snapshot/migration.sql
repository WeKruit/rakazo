CREATE TABLE recruiting_overview_snapshots (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES "spaces"(id) ON DELETE CASCADE,
  roles JSONB NOT NULL,
  saved_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, space_id)
);

-- Existing protected installations receive the same policies as the explicit rollout.
-- Installations without actor RLS stay opt-in through prisma/rls/first-batch.sql.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
             WHERE n.nspname='public' AND f.proname='rakazo_actor_member' AND f.pronargs=0) THEN
    ALTER TABLE recruiting_overview_snapshots ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_overview_snapshots;
    CREATE POLICY rakazo_actor_isolation ON recruiting_overview_snapshots FOR ALL
    USING (user_id = NULLIF(current_setting('app.user_id', true), '') AND space_id = NULLIF(current_setting('app.space_id', true), '') AND (SELECT public.rakazo_actor_member()))
    WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '') AND space_id = NULLIF(current_setting('app.space_id', true), '') AND (SELECT public.rakazo_actor_member()));
  END IF;
END
$rls$;
