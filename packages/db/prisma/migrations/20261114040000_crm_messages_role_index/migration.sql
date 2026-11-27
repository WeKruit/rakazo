-- Stats reads one attached CRM role's dated messages at a time.
CREATE INDEX "recruiting_crm_messages_userId_spaceId_mcpServerId_organiza_idx" ON "recruiting_crm_messages"("userId", "spaceId", "mcpServerId", "organizationId", "crmRoleId", "sentAt");
