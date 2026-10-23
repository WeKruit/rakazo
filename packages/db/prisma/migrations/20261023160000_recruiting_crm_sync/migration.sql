-- CreateTable
CREATE TABLE "recruiting_crm_roles" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "organizationName" TEXT,
    "crmRoleId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientLabel" TEXT NOT NULL,
    "roleLabel" TEXT NOT NULL,
    "summary" TEXT,
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "recruiting_crm_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruiting_crm_contacts" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "crmCandidateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "company" TEXT,
    "location" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "linkedinUrl" TEXT,
    "identityKey" TEXT,
    "stage" TEXT,
    "contactStatus" TEXT NOT NULL,
    "outreachStatus" TEXT NOT NULL,
    "interest" TEXT,
    "reviewed" BOOLEAN,
    "lastReplyAt" TIMESTAMP(3),
    "resumeReceived" BOOLEAN,
    "crmRoleId" TEXT,
    "clientLabel" TEXT NOT NULL,
    "roleLabel" TEXT NOT NULL,
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "recruiting_crm_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruiting_crm_role_contacts" (
    "roleId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "recruiting_crm_role_contacts_pkey" PRIMARY KEY ("roleId","contactId")
);

-- CreateTable
CREATE TABLE "recruiting_crm_messages" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "crmMessageId" TEXT NOT NULL,
    "crmCandidateId" TEXT NOT NULL,
    "crmRoleId" TEXT NOT NULL,
    "threadId" TEXT,
    "direction" TEXT,
    "sender" TEXT,
    "recipients" JSONB NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "sentAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruiting_crm_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recruiting_crm_roles_userId_spaceId_mcpServerId_organizatio_key" ON "recruiting_crm_roles"("userId", "spaceId", "mcpServerId", "organizationId", "crmRoleId");

-- CreateIndex
CREATE INDEX "recruiting_crm_contacts_userId_spaceId_identityKey_idx" ON "recruiting_crm_contacts"("userId", "spaceId", "identityKey");

-- CreateIndex
CREATE UNIQUE INDEX "recruiting_crm_contacts_userId_spaceId_mcpServerId_organiza_key" ON "recruiting_crm_contacts"("userId", "spaceId", "mcpServerId", "organizationId", "crmCandidateId");

-- CreateIndex
CREATE INDEX "recruiting_crm_role_contacts_contactId_idx" ON "recruiting_crm_role_contacts"("contactId");

-- CreateIndex
CREATE INDEX "recruiting_crm_messages_userId_spaceId_crmCandidateId_idx" ON "recruiting_crm_messages"("userId", "spaceId", "crmCandidateId");

-- CreateIndex
CREATE UNIQUE INDEX "recruiting_crm_messages_userId_spaceId_mcpServerId_organiza_key" ON "recruiting_crm_messages"("userId", "spaceId", "mcpServerId", "organizationId", "crmMessageId");

-- AddForeignKey
ALTER TABLE "recruiting_crm_roles" ADD CONSTRAINT "recruiting_crm_roles_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_roles" ADD CONSTRAINT "recruiting_crm_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_roles" ADD CONSTRAINT "recruiting_crm_roles_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_contacts" ADD CONSTRAINT "recruiting_crm_contacts_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_contacts" ADD CONSTRAINT "recruiting_crm_contacts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_contacts" ADD CONSTRAINT "recruiting_crm_contacts_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_role_contacts" ADD CONSTRAINT "recruiting_crm_role_contacts_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "recruiting_crm_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_role_contacts" ADD CONSTRAINT "recruiting_crm_role_contacts_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "recruiting_crm_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_messages" ADD CONSTRAINT "recruiting_crm_messages_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_messages" ADD CONSTRAINT "recruiting_crm_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_crm_messages" ADD CONSTRAINT "recruiting_crm_messages_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
