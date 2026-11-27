-- Each saved row's display report, projected once when the page is saved.
-- NULL for rows saved before this column; the list then reads the saved page as before.
ALTER TABLE "recruiting_candidate_occurrences" ADD COLUMN "report" JSONB;
