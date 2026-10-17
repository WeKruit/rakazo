ALTER TABLE "recruiting_roles" ADD COLUMN "crmBindingEffectId" TEXT;
CREATE UNIQUE INDEX "recruiting_roles_crmBindingEffectId_key" ON "recruiting_roles"("crmBindingEffectId");
ALTER TABLE "recruiting_roles" ADD CONSTRAINT "recruiting_roles_crmBindingEffectId_fkey"
  FOREIGN KEY ("crmBindingEffectId") REFERENCES "external_effects"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "recruiting_crm_imports" (
  "effectId" TEXT NOT NULL,
  "bindingEffectId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "rowIndex" INTEGER NOT NULL,
  CONSTRAINT "recruiting_crm_imports_pkey" PRIMARY KEY ("effectId")
);
CREATE UNIQUE INDEX "recruiting_crm_imports_bindingEffectId_pageId_rowIndex_key"
  ON "recruiting_crm_imports"("bindingEffectId", "pageId", "rowIndex");
ALTER TABLE "recruiting_crm_imports" ADD CONSTRAINT "recruiting_crm_imports_effectId_fkey"
  FOREIGN KEY ("effectId") REFERENCES "external_effects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recruiting_crm_imports" ADD CONSTRAINT "recruiting_crm_imports_bindingEffectId_fkey"
  FOREIGN KEY ("bindingEffectId") REFERENCES "external_effects"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "recruiting_crm_imports" ADD CONSTRAINT "recruiting_crm_imports_pageId_rowIndex_fkey"
  FOREIGN KEY ("pageId", "rowIndex") REFERENCES "recruiting_candidate_occurrences"("pageId", "rowIndex") ON DELETE CASCADE ON UPDATE CASCADE;
