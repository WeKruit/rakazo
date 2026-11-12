-- When each owner's last CRM pass reached the end, so a restart does not read every CRM again.
CREATE TABLE "recruiting_crm_sync_passes" (
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruiting_crm_sync_passes_pkey" PRIMARY KEY ("userId","spaceId")
);

ALTER TABLE "recruiting_crm_sync_passes" ADD CONSTRAINT "recruiting_crm_sync_passes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "recruiting_crm_sync_passes" ADD CONSTRAINT "recruiting_crm_sync_passes_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
