-- Code no longer derives or stores which stage a role is in; nothing reads this column.
ALTER TABLE "recruiting_roles" DROP COLUMN "playbookStage";
