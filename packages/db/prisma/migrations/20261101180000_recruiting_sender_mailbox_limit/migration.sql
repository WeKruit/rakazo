ALTER TABLE deployment_settings ADD COLUMN "sendingMailboxLimit" integer NOT NULL DEFAULT 2;
ALTER TABLE deployment_settings ADD CONSTRAINT deployment_sending_mailbox_limit CHECK ("sendingMailboxLimit" BETWEEN 1 AND 100);
