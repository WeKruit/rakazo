-- The contacts list reads these tables through covering indexes, which skip the table only
-- for pages marked all-visible. A large import leaves new pages unmarked until autovacuum
-- runs, and the default insert threshold (20% of the table) waits far too long. Vacuum after
-- 1% new or changed rows instead.
ALTER TABLE "recruiting_crm_contacts" SET (autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "recruiting_candidate_occurrences" SET (autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_vacuum_scale_factor = 0.02);
