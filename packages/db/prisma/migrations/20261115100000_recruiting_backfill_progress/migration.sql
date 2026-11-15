-- The startup recruiting walk records how far it got, so a restart resumes and a finished walk is skipped.
ALTER TABLE deployment_settings ADD COLUMN "recruitingBackfillKey" text;
ALTER TABLE deployment_settings ADD COLUMN "recruitingBackfillCursor" text;
