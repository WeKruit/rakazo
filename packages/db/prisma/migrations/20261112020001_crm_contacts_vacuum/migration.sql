-- Sole statement so VACUUM runs outside a transaction. Marks the contacts table's pages
-- all-visible so the list index above is read without visiting the table.
VACUUM (ANALYZE) "recruiting_crm_contacts";
