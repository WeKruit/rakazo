-- AlterTable
ALTER TABLE "threads" ADD COLUMN     "activeRecruitingRoleId" TEXT;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "initialRecruitingRoleRevisionId" TEXT;

-- CreateTable
CREATE TABLE "recruiting_roles" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceThreadId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "currentRevisionId" TEXT NOT NULL,

    CONSTRAINT "recruiting_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruiting_role_revisions" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "sourceRefs" JSONB NOT NULL,
    "criteria" JSONB NOT NULL,
    "preferences" JSONB NOT NULL,
    "definitionQuestions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recruiting_role_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruiting_research_tasks" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "serverRevision" INTEGER NOT NULL,
    "providerTaskId" TEXT,
    "pendingActionId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'active',
    "createdByRunId" TEXT NOT NULL,

    CONSTRAINT "recruiting_research_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruiting_research_actions" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "roleRevisionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "clientNonce" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "deliveryState" TEXT NOT NULL DEFAULT 'prepared',
    "observedProviderState" TEXT,
    "requestArtifactId" TEXT NOT NULL,
    "requestArtifactHash" TEXT NOT NULL,
    "contextArtifactId" TEXT NOT NULL,
    "contextArtifactHash" TEXT NOT NULL,
    "recallScope" TEXT,
    "receiptArtifactId" TEXT,
    "receiptArtifactHash" TEXT,
    "outputArtifacts" JSONB NOT NULL DEFAULT '[]',
    "cursor" TEXT,
    "effectId" TEXT,
    "usage" JSONB,

    CONSTRAINT "recruiting_research_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruiting_assessments" (
    "roleId" TEXT NOT NULL,
    "candidateKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "basedOnVersion" INTEGER,
    "roleRevisionId" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "judgments" JSONB NOT NULL,
    "questions" JSONB NOT NULL,
    "sourceRefs" JSONB NOT NULL,
    "createdByRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recruiting_assessments_pkey" PRIMARY KEY ("roleId","candidateKey","version")
);

-- CreateIndex
CREATE UNIQUE INDEX "recruiting_roles_currentRevisionId_key" ON "recruiting_roles"("currentRevisionId");

-- CreateIndex
CREATE INDEX "recruiting_roles_spaceId_userId_idx" ON "recruiting_roles"("spaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "recruiting_role_revisions_roleId_revision_key" ON "recruiting_role_revisions"("roleId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "recruiting_research_tasks_pendingActionId_key" ON "recruiting_research_tasks"("pendingActionId");

-- CreateIndex
CREATE INDEX "recruiting_research_tasks_roleId_idx" ON "recruiting_research_tasks"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "recruiting_research_tasks_mcpServerId_serverRevision_provid_key" ON "recruiting_research_tasks"("mcpServerId", "serverRevision", "providerTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "recruiting_research_actions_clientNonce_key" ON "recruiting_research_actions"("clientNonce");

-- CreateIndex
CREATE INDEX "recruiting_research_actions_taskId_idx" ON "recruiting_research_actions"("taskId");

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_activeRecruitingRoleId_fkey" FOREIGN KEY ("activeRecruitingRoleId") REFERENCES "recruiting_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_initialRecruitingRoleRevisionId_fkey" FOREIGN KEY ("initialRecruitingRoleRevisionId") REFERENCES "recruiting_role_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_roles" ADD CONSTRAINT "recruiting_roles_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_roles" ADD CONSTRAINT "recruiting_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_roles" ADD CONSTRAINT "recruiting_roles_sourceThreadId_fkey" FOREIGN KEY ("sourceThreadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_roles" ADD CONSTRAINT "recruiting_roles_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "recruiting_role_revisions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_role_revisions" ADD CONSTRAINT "recruiting_role_revisions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "recruiting_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_tasks" ADD CONSTRAINT "recruiting_research_tasks_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "recruiting_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_tasks" ADD CONSTRAINT "recruiting_research_tasks_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_servers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_tasks" ADD CONSTRAINT "recruiting_research_tasks_pendingActionId_fkey" FOREIGN KEY ("pendingActionId") REFERENCES "recruiting_research_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_tasks" ADD CONSTRAINT "recruiting_research_tasks_createdByRunId_fkey" FOREIGN KEY ("createdByRunId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "recruiting_research_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_roleRevisionId_fkey" FOREIGN KEY ("roleRevisionId") REFERENCES "recruiting_role_revisions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_requestArtifactId_fkey" FOREIGN KEY ("requestArtifactId") REFERENCES "artifacts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_contextArtifactId_fkey" FOREIGN KEY ("contextArtifactId") REFERENCES "artifacts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_receiptArtifactId_fkey" FOREIGN KEY ("receiptArtifactId") REFERENCES "artifacts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_effectId_fkey" FOREIGN KEY ("effectId") REFERENCES "external_effects"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_assessments" ADD CONSTRAINT "recruiting_assessments_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "recruiting_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_assessments" ADD CONSTRAINT "recruiting_assessments_roleRevisionId_fkey" FOREIGN KEY ("roleRevisionId") REFERENCES "recruiting_role_revisions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_assessments" ADD CONSTRAINT "recruiting_assessments_createdByRunId_fkey" FOREIGN KEY ("createdByRunId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Creating a role and revision one is one transaction despite the required cycle.
ALTER TABLE "recruiting_roles" ALTER CONSTRAINT "recruiting_roles_currentRevisionId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "recruiting_roles" ADD CONSTRAINT "recruiting_roles_revision_positive" CHECK ("revision" > 0);
ALTER TABLE "recruiting_role_revisions" ADD CONSTRAINT "recruiting_role_revisions_revision_positive" CHECK ("revision" > 0);
ALTER TABLE "recruiting_research_tasks" ADD CONSTRAINT "recruiting_research_tasks_state_check" CHECK ("state" IN ('active', 'completed', 'closed', 'unknown'));
ALTER TABLE "recruiting_research_tasks" ADD CONSTRAINT "recruiting_research_tasks_revision_positive" CHECK ("serverRevision" > 0);
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_delivery_check" CHECK ("deliveryState" IN ('prepared', 'sending', 'accepted', 'rejected', 'unknown', 'superseded'));
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_kind_check" CHECK ("kind" IN ('create', 'continue'));
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_receipt_check" CHECK (("receiptArtifactId" IS NULL) = ("receiptArtifactHash" IS NULL) AND ("usage" IS NULL OR "receiptArtifactId" IS NOT NULL));
ALTER TABLE "recruiting_research_actions" ADD CONSTRAINT "recruiting_research_actions_hash_check" CHECK ("requestArtifactHash" ~ '^[a-f0-9]{64}$' AND "contextArtifactHash" ~ '^[a-f0-9]{64}$' AND ("receiptArtifactHash" IS NULL OR "receiptArtifactHash" ~ '^[a-f0-9]{64}$'));
ALTER TABLE "recruiting_assessments" ADD CONSTRAINT "recruiting_assessments_version_check" CHECK ("version" = COALESCE("basedOnVersion", 0) + 1 AND "version" > 0 AND ("basedOnVersion" IS NULL OR "basedOnVersion" > 0));

CREATE FUNCTION recruiting_reject_snapshot_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Recruiting snapshots are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER recruiting_role_revisions_immutable BEFORE UPDATE ON "recruiting_role_revisions" FOR EACH ROW EXECUTE FUNCTION recruiting_reject_snapshot_update();
CREATE TRIGGER recruiting_assessments_immutable BEFORE UPDATE ON "recruiting_assessments" FOR EACH ROW EXECUTE FUNCTION recruiting_reject_snapshot_update();

CREATE FUNCTION recruiting_check_current_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "recruiting_role_revisions" WHERE "id" = NEW."currentRevisionId" AND "roleId" = NEW."id" AND "revision" = NEW."revision") THEN
    RAISE EXCEPTION 'Current recruiting revision does not match role' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER recruiting_roles_current_revision_check AFTER INSERT OR UPDATE ON "recruiting_roles" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION recruiting_check_current_revision();
