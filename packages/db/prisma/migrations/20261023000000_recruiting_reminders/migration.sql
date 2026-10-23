-- CreateEnum
CREATE TYPE "RecruitingReminderStatus" AS ENUM ('open', 'done', 'dismissed');

-- CreateTable
CREATE TABLE "recruiting_reminders" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "roleId" TEXT,
    "candidateKey" TEXT,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "RecruitingReminderStatus" NOT NULL DEFAULT 'open',
    "completedAt" TIMESTAMP(3),
    "createdByBotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruiting_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recruiting_reminders_ownerUserId_status_dueAt_idx" ON "recruiting_reminders"("ownerUserId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "recruiting_reminders_candidateKey_idx" ON "recruiting_reminders"("candidateKey");

-- AddForeignKey
ALTER TABLE "recruiting_reminders" ADD CONSTRAINT "recruiting_reminders_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_reminders" ADD CONSTRAINT "recruiting_reminders_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_reminders" ADD CONSTRAINT "recruiting_reminders_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "recruiting_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
