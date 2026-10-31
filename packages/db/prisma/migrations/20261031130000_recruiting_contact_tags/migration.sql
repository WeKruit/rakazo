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
