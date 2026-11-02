ALTER TABLE "recruiting_candidate_notes" ADD COLUMN "artifactIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
