-- A recruiter's own labels on people across all roles. Additive only.
CREATE TABLE "recruiting_contact_tags" (
    "spaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "personKey" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recruiting_contact_tags_pkey" PRIMARY KEY ("spaceId","ownerUserId","personKey","tag")
);

CREATE INDEX "recruiting_contact_tags_spaceId_ownerUserId_tag_idx" ON "recruiting_contact_tags"("spaceId", "ownerUserId", "tag");

ALTER TABLE "recruiting_contact_tags" ADD CONSTRAINT "recruiting_contact_tags_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recruiting_contact_tags" ADD CONSTRAINT "recruiting_contact_tags_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Where the explicit first-batch RLS rollout is already applied, protect this
-- table the same way so the restricted API role's startup check still passes.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
             WHERE n.nspname='public' AND f.proname='rakazo_actor_member' AND f.pronargs=0) THEN
    ALTER TABLE recruiting_contact_tags ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS rakazo_actor_isolation ON recruiting_contact_tags;
    CREATE POLICY rakazo_actor_isolation ON recruiting_contact_tags FOR ALL
    USING ("ownerUserId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND (SELECT public.rakazo_actor_member()))
    WITH CHECK ("ownerUserId" = NULLIF(current_setting('app.user_id', true), '') AND "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND (SELECT public.rakazo_actor_member()));
  END IF;
END
$rls$;
