CREATE TABLE "recruiting_crm_workspace_attachments" (
  "roleId" TEXT PRIMARY KEY REFERENCES "recruiting_roles"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "mcpServerId" TEXT NOT NULL,
  "serverRevision" INTEGER NOT NULL,
  "organizationId" TEXT NOT NULL,
  "crmRoleId" TEXT NOT NULL,
  "sourceMaterial" TEXT NOT NULL,
  "target" JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recruiting_crm_workspace_exact_key" UNIQUE ("userId", "spaceId", "mcpServerId", "organizationId", "crmRoleId")
);
