-- Mail a conversation sends outside a role (a one-off campaign or an email from the recruiter's
-- own mailbox) is kept under that conversation, so the account Inbox lists it. Each row belongs to
-- exactly one role or one conversation. Every existing row has a role, so the check holds without
-- a backfill; it is validated separately so adding it does not hold writes during the scan.
ALTER TABLE recruiting_inbox_messages ALTER COLUMN role_id DROP NOT NULL;
ALTER TABLE recruiting_inbox_messages ADD COLUMN thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE;
ALTER TABLE recruiting_inbox_messages ADD CONSTRAINT recruiting_inbox_messages_one_owner
  CHECK (num_nonnulls(role_id, thread_id) = 1) NOT VALID;
ALTER TABLE recruiting_inbox_messages VALIDATE CONSTRAINT recruiting_inbox_messages_one_owner;

-- Protected installations: a conversation's row is the owner's when the conversation is theirs.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='public' AND f.proname='rakazo_actor_member' AND f.pronargs=0) THEN
    DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_inbox_messages;
    CREATE POLICY rakazo_actor_isolation ON recruiting_inbox_messages FOR ALL
    USING (user_id = NULLIF(current_setting('app.user_id', true), '') AND space_id = NULLIF(current_setting('app.space_id', true), '') AND (SELECT public.rakazo_actor_member()) AND (EXISTS (SELECT 1 FROM recruiting_roles r WHERE r.id=role_id AND r."userId"=user_id AND r."spaceId"=space_id) OR EXISTS (SELECT 1 FROM threads t WHERE t.id=thread_id AND t."userId"=user_id AND t."spaceId"=space_id)))
    WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '') AND space_id = NULLIF(current_setting('app.space_id', true), '') AND (SELECT public.rakazo_actor_member()) AND (EXISTS (SELECT 1 FROM recruiting_roles r WHERE r.id=role_id AND r."userId"=user_id AND r."spaceId"=space_id) OR EXISTS (SELECT 1 FROM threads t WHERE t.id=thread_id AND t."userId"=user_id AND t."spaceId"=space_id)));
  END IF;
END
$rls$;
