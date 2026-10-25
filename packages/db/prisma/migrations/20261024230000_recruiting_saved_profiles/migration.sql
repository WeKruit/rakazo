-- CreateTable
CREATE TABLE "recruiting_saved_profiles" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "personKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceEffectId" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruiting_saved_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recruiting_saved_profiles_spaceId_ownerUserId_personKey_key" ON "recruiting_saved_profiles"("spaceId", "ownerUserId", "personKey");

-- AddForeignKey
ALTER TABLE "recruiting_saved_profiles" ADD CONSTRAINT "recruiting_saved_profiles_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiting_saved_profiles" ADD CONSTRAINT "recruiting_saved_profiles_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
