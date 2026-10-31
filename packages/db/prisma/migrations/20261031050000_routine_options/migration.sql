-- Routine options: session mode, trigger condition, probe, record trigger and team sharing.
-- Additive only: existing routines keep their behavior through the defaults.
ALTER TABLE "routines"
  ADD COLUMN "sessionMode" TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN "condition" TEXT,
  ADD COLUMN "probeCommand" TEXT,
  ADD COLUMN "recordTrigger" TEXT,
  ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sharedFromId" TEXT;

CREATE INDEX "routines_spaceId_shared_idx" ON "routines"("spaceId", "shared");
CREATE INDEX "routines_sharedFromId_idx" ON "routines"("sharedFromId");
CREATE INDEX "routines_recordTrigger_idx" ON "routines"("recordTrigger");
