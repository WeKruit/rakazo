-- Sole statement so VACUUM runs outside a transaction. Marks the pages added since the last
-- vacuum all-visible so the contacts list index is read without visiting the table.
VACUUM (ANALYZE) "recruiting_crm_contacts", "recruiting_candidate_occurrences";
