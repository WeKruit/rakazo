-- CreateTable
CREATE TABLE "message_thinking" (
    "messageId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "api" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_thinking_pkey" PRIMARY KEY ("messageId")
);

-- AddForeignKey
ALTER TABLE "message_thinking" ADD CONSTRAINT "message_thinking_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
