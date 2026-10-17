-- AlterTable
ALTER TABLE "recruiting_research_actions" ADD COLUMN     "candidateOutputSchema" TEXT;

-- CreateTable
CREATE TABLE "recruiting_candidates" (
    "roleId" TEXT NOT NULL,
    "candidateKey" TEXT NOT NULL,
    "shortlisted" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "shortlistMessageId" TEXT,

    CONSTRAINT "recruiting_candidates_pkey" PRIMARY KEY ("roleId","candidateKey")
);

-- CreateTable
CREATE TABLE "recruiting_candidate_pages" (
    "effectId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "roleRevisionId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "requestCursor" TEXT,
    "outputId" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "rowCount" INTEGER,

    CONSTRAINT "recruiting_candidate_pages_pkey" PRIMARY KEY ("effectId")
);

-- CreateTable
CREATE TABLE "recruiting_candidate_occurrences" (
    "pageId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "roleId" TEXT NOT NULL,
    "candidateKey" TEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "company" TEXT,
    "location" TEXT,
    "linkedinUrl" TEXT,
    "resumeUrl" TEXT,
    "evidenceUrls" JSONB,
    "issues" JSONB NOT NULL,

    CONSTRAINT "recruiting_candidate_occurrences_pkey" PRIMARY KEY ("pageId","rowIndex")
);

-- CreateIndex
CREATE INDEX "recruiting_candidate_pages_roleId_observedAt_effectId_idx" ON "recruiting_candidate_pages"("roleId", "observedAt", "effectId");

-- CreateIndex
CREATE INDEX "recruiting_candidate_pages_actionId_idx" ON "recruiting_candidate_pages"("actionId");

-- CreateIndex
CREATE INDEX "recruiting_candidate_occurrences_roleId_candidateKey_idx" ON "recruiting_candidate_occurrences"("roleId", "candidateKey");

-- AddForeignKey
ALTER TABLE "recruiting_candidates" ADD CONSTRAINT "recruiting_candidates_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "recruiting_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_candidates" ADD CONSTRAINT "recruiting_candidates_shortlistMessageId_fkey" FOREIGN KEY ("shortlistMessageId") REFERENCES "messages"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_candidate_pages" ADD CONSTRAINT "recruiting_candidate_pages_effectId_fkey" FOREIGN KEY ("effectId") REFERENCES "external_effects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_candidate_pages" ADD CONSTRAINT "recruiting_candidate_pages_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "recruiting_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_candidate_pages" ADD CONSTRAINT "recruiting_candidate_pages_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "recruiting_research_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_candidate_pages" ADD CONSTRAINT "recruiting_candidate_pages_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "recruiting_research_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_candidate_pages" ADD CONSTRAINT "recruiting_candidate_pages_roleRevisionId_fkey" FOREIGN KEY ("roleRevisionId") REFERENCES "recruiting_role_revisions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_candidate_pages" ADD CONSTRAINT "recruiting_candidate_pages_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_candidate_occurrences" ADD CONSTRAINT "recruiting_candidate_occurrences_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "recruiting_candidate_pages"("effectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_candidate_occurrences" ADD CONSTRAINT "recruiting_candidate_occurrences_roleId_candidateKey_fkey" FOREIGN KEY ("roleId", "candidateKey") REFERENCES "recruiting_candidates"("roleId", "candidateKey") ON DELETE CASCADE ON UPDATE CASCADE;


-- Historical assessments remain visible without inventing a provider schema or identity.
INSERT INTO "recruiting_candidates" ("roleId", "candidateKey")
SELECT DISTINCT "roleId", "candidateKey" FROM "recruiting_assessments"
ON CONFLICT ("roleId", "candidateKey") DO NOTHING;

ALTER TABLE "recruiting_candidates" ADD CONSTRAINT "recruiting_candidates_revision_check" CHECK ("revision" >= 0);
ALTER TABLE "recruiting_candidate_pages" ADD CONSTRAINT "recruiting_candidate_pages_rowCount_check" CHECK ("rowCount" >= 0);
ALTER TABLE "recruiting_candidate_occurrences" ADD CONSTRAINT "recruiting_candidate_occurrences_rowIndex_check" CHECK ("rowIndex" >= 0);
