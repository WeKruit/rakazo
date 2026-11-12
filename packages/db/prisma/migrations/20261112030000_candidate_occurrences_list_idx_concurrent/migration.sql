-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction (see prior concurrent index migrations).
-- Covers every column the contacts list and its search read from a role's saved search rows,
-- so an account's list is an index-only scan instead of a read of every scattered row.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "recruiting_candidate_occurrences_list_idx" ON "recruiting_candidate_occurrences" ("roleId", "candidateKey") INCLUDE ("pageId", "rowIndex", "name", "title", "company", "location", "linkedinUrl");
