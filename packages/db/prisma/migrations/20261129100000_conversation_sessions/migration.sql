-- Pi agent sessions: one per agent per conversation, with its storage and its input outbox.

-- CreateTable
CREATE TABLE "conversation_sessions" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "storageVersion" INTEGER NOT NULL DEFAULT 1,
    "nextSeq" INTEGER NOT NULL DEFAULT 0,
    "nextInputSeq" INTEGER NOT NULL DEFAULT 0,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "usage" JSONB,
    "leaseOwner" TEXT,
    "leaseFence" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_entries" (
    "sessionId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "seq" INTEGER NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "customType" TEXT,
    "body" JSONB NOT NULL,

    CONSTRAINT "session_entries_pkey" PRIMARY KEY ("sessionId","id")
);

-- CreateTable
CREATE TABLE "session_values" (
    "sessionId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "seq" INTEGER NOT NULL,

    CONSTRAINT "session_values_pkey" PRIMARY KEY ("sessionId","namespace","key")
);

-- CreateTable
CREATE TABLE "session_list_elements" (
    "sessionId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "session_list_elements_pkey" PRIMARY KEY ("sessionId","namespace","key","seq")
);

-- CreateTable
CREATE TABLE "session_usage" (
    "sessionId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "usage" JSONB NOT NULL,
    "entryId" TEXT,
    "adjustment" BOOLEAN NOT NULL,
    "details" JSONB,

    CONSTRAINT "session_usage_pkey" PRIMARY KEY ("sessionId","id")
);

-- CreateTable
CREATE TABLE "session_inputs" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "messageId" TEXT,
    "payload" JSONB NOT NULL,
    "trigger" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "piEntryId" TEXT,
    "operationId" TEXT,

    CONSTRAINT "session_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_sessions_threadId_botId_key" ON "conversation_sessions"("threadId", "botId");

-- CreateIndex
CREATE INDEX "session_entries_sessionId_seq_idx" ON "session_entries"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "session_usage_sessionId_seq_idx" ON "session_usage"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "session_inputs_sessionId_deliveredAt_seq_idx" ON "session_inputs"("sessionId", "deliveredAt", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "session_inputs_sessionId_seq_key" ON "session_inputs"("sessionId", "seq");

-- AddForeignKey
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_entries" ADD CONSTRAINT "session_entries_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_values" ADD CONSTRAINT "session_values_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_list_elements" ADD CONSTRAINT "session_list_elements_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_usage" ADD CONSTRAINT "session_usage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_inputs" ADD CONSTRAINT "session_inputs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
