CREATE TABLE "recruiting_replies" (
  "effectId" TEXT NOT NULL,
  "roleRevisionId" TEXT NOT NULL,
  "crmImportEffectId" TEXT NOT NULL,
  "emailReadEffectId" TEXT NOT NULL,
  "crmContextReadEffectId" TEXT NOT NULL,
  CONSTRAINT "recruiting_replies_pkey" PRIMARY KEY ("effectId")
);
CREATE INDEX "recruiting_replies_crmImportEffectId_idx" ON "recruiting_replies"("crmImportEffectId");
CREATE INDEX "recruiting_replies_roleRevisionId_idx" ON "recruiting_replies"("roleRevisionId");
ALTER TABLE "recruiting_replies" ADD CONSTRAINT "recruiting_replies_effectId_fkey"
  FOREIGN KEY ("effectId") REFERENCES "external_effects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recruiting_replies" ADD CONSTRAINT "recruiting_replies_roleRevisionId_fkey"
  FOREIGN KEY ("roleRevisionId") REFERENCES "recruiting_role_revisions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "recruiting_replies" ADD CONSTRAINT "recruiting_replies_crmImportEffectId_fkey"
  FOREIGN KEY ("crmImportEffectId") REFERENCES "recruiting_crm_imports"("effectId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "recruiting_replies" ADD CONSTRAINT "recruiting_replies_emailReadEffectId_fkey"
  FOREIGN KEY ("emailReadEffectId") REFERENCES "external_effects"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "recruiting_replies" ADD CONSTRAINT "recruiting_replies_crmContextReadEffectId_fkey"
  FOREIGN KEY ("crmContextReadEffectId") REFERENCES "external_effects"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
