-- Sole statement so VACUUM runs outside a transaction. Marks the saved search rows' pages
-- all-visible so the list index above is read without visiting the table.
VACUUM (ANALYZE) "recruiting_candidate_occurrences";
