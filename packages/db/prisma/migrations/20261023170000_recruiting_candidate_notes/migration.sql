-- CreateTable
CREATE TABLE "recruiting_candidate_notes" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "roleId" TEXT,
    "candidateKey" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdByBotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "recruiting_candidate_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recruiting_candidate_notes_spaceId_candidateKey_createdAt_idx" ON "recruiting_candidate_notes"("spaceId", "candidateKey", "createdAt");

-- AddForeignKey
ALTER TABLE "recruiting_candidate_notes" ADD CONSTRAINT "recruiting_candidate_notes_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_candidate_notes" ADD CONSTRAINT "recruiting_candidate_notes_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_candidate_notes" ADD CONSTRAINT "recruiting_candidate_notes_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "recruiting_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
