-- CreateTable
CREATE TABLE "message_embeddings" (
    "messageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_embeddings_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE INDEX "message_embeddings_threadId_idx" ON "message_embeddings"("threadId");

-- AddForeignKey
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

