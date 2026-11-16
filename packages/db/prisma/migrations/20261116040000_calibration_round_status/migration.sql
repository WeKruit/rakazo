-- A calibration round's state is stored, not inferred from which run recorded it.
ALTER TABLE "recruiting_calibration_rounds"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'shown',
  ADD COLUMN "ownerBotId" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
