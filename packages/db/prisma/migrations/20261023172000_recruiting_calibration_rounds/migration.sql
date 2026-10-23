-- Calibration review rounds: which ten saved people each round showed, and the recruiter's decision.
CREATE TABLE "recruiting_calibration_rounds" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "candidateKeys" TEXT[],
    "effectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "approvalSource" JSONB,

    CONSTRAINT "recruiting_calibration_rounds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recruiting_calibration_rounds_effectId_key" ON "recruiting_calibration_rounds"("effectId");
CREATE UNIQUE INDEX "recruiting_calibration_rounds_roleId_round_key" ON "recruiting_calibration_rounds"("roleId", "round");

ALTER TABLE "recruiting_calibration_rounds" ADD CONSTRAINT "recruiting_calibration_rounds_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "recruiting_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
