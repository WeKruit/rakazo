-- CreateTable
CREATE TABLE "organization_logos" (
    "key" TEXT NOT NULL,
    "host" TEXT,
    "icon" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkAgainAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_logos_pkey" PRIMARY KEY ("key")
);
