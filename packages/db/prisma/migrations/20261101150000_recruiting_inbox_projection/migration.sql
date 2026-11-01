CREATE TABLE recruiting_inbox_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES recruiting_roles(id) ON DELETE CASCADE,
  origin_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  thread_key TEXT,
  source_id TEXT NOT NULL,
  organization_id TEXT,
  source_kind TEXT NOT NULL,
  receipt_id TEXT,
  receipt_ordinal INTEGER,
  observed_at TIMESTAMP(3) NOT NULL,
  message_at TIMESTAMP(3),
  direction TEXT,
  search_text TEXT NOT NULL,
  email JSONB NOT NULL,
  person JSONB,
  UNIQUE(user_id, space_id, receipt_id, receipt_ordinal)
);
CREATE INDEX recruiting_inbox_messages_page ON recruiting_inbox_messages(user_id, space_id, role_id, message_at DESC, id DESC);
CREATE INDEX recruiting_inbox_messages_receipts ON recruiting_inbox_messages(user_id, space_id, source_kind, receipt_id);
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='public' AND f.proname='rakazo_actor_member' AND f.pronargs=0) THEN
    ALTER TABLE recruiting_inbox_messages ENABLE ROW LEVEL SECURITY;
    CREATE POLICY rakazo_actor_isolation ON recruiting_inbox_messages FOR ALL
    USING (user_id = NULLIF(current_setting('app.user_id', true), '') AND space_id = NULLIF(current_setting('app.space_id', true), '') AND (SELECT public.rakazo_actor_member()) AND EXISTS (SELECT 1 FROM recruiting_roles r WHERE r.id=role_id AND r."userId"=user_id AND r."spaceId"=space_id))
    WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '') AND space_id = NULLIF(current_setting('app.space_id', true), '') AND (SELECT public.rakazo_actor_member()) AND EXISTS (SELECT 1 FROM recruiting_roles r WHERE r.id=role_id AND r."userId"=user_id AND r."spaceId"=space_id));
  END IF;
END
$rls$;
