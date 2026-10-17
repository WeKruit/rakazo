ALTER TABLE "recruiting_candidate_pages"
  ALTER COLUMN "taskId" DROP NOT NULL,
  ALTER COLUMN "actionId" DROP NOT NULL,
  ADD CONSTRAINT "recruiting_candidate_pages_task_action_pair_check"
    CHECK (("taskId" IS NULL) = ("actionId" IS NULL));
