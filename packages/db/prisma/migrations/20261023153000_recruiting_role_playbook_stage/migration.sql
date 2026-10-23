-- Role playbook stage: intake | calibration_10 | feedback | scale | enrichment | outreach | replies | screening | submission | interview | closed
ALTER TABLE "recruiting_roles" ADD COLUMN "playbookStage" TEXT NOT NULL DEFAULT 'intake';
