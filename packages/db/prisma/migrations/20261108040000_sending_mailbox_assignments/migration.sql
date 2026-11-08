CREATE TABLE "sending_mailbox_assignments" (
    "email" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "assignedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sending_mailbox_assignments_pkey" PRIMARY KEY ("email")
);
CREATE INDEX "sending_mailbox_assignments_userId_idx" ON "sending_mailbox_assignments"("userId");
ALTER TABLE "sending_mailbox_assignments" ADD CONSTRAINT "sending_mailbox_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
