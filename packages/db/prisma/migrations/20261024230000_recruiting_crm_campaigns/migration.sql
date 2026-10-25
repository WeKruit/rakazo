-- CreateTable
CREATE TABLE "recruiting_crm_campaigns" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "crmCampaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" INTEGER,
    "crmRoleId" TEXT,
    "clientId" TEXT,
    "campaignCreatedAt" TIMESTAMP(3),
    "campaignUpdatedAt" TIMESTAMP(3),
    "mirrorSyncedAt" TIMESTAMP(3) NOT NULL,
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "recruiting_crm_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruiting_crm_leads" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "crmLeadId" TEXT NOT NULL,
    "crmCampaignId" TEXT NOT NULL,
    "crmCandidateId" TEXT,
    "status" INTEGER,
    "interestStatus" INTEGER,
    "openCount" INTEGER,
    "replyCount" INTEGER,
    "lastContactAt" TIMESTAMP(3),
    "lastReplyAt" TIMESTAMP(3),
    "mirrorSyncedAt" TIMESTAMP(3) NOT NULL,
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "recruiting_crm_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recruiting_crm_campaigns_userId_spaceId_mcpServerId_organiz_key" ON "recruiting_crm_campaigns"("userId", "spaceId", "mcpServerId", "organizationId", "crmCampaignId");

-- CreateIndex
CREATE INDEX "recruiting_crm_leads_userId_spaceId_crmCandidateId_idx" ON "recruiting_crm_leads"("userId", "spaceId", "crmCandidateId");

-- CreateIndex
CREATE INDEX "recruiting_crm_leads_userId_spaceId_crmCampaignId_idx" ON "recruiting_crm_leads"("userId", "spaceId", "crmCampaignId");

-- CreateIndex
CREATE UNIQUE INDEX "recruiting_crm_leads_userId_spaceId_mcpServerId_organizatio_key" ON "recruiting_crm_leads"("userId", "spaceId", "mcpServerId", "organizationId", "crmLeadId");

-- AddForeignKey
ALTER TABLE "recruiting_crm_campaigns" ADD CONSTRAINT "recruiting_crm_campaigns_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_campaigns" ADD CONSTRAINT "recruiting_crm_campaigns_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_campaigns" ADD CONSTRAINT "recruiting_crm_campaigns_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_leads" ADD CONSTRAINT "recruiting_crm_leads_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_leads" ADD CONSTRAINT "recruiting_crm_leads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_leads" ADD CONSTRAINT "recruiting_crm_leads_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

