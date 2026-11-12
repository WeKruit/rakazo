-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction (see prior concurrent index migrations).
-- Covers every column the contacts list and its filter menus read from active CRM contacts, so
-- an account's list is an index-only scan instead of a read of every scattered row.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "recruiting_crm_contacts_owner_list_idx" ON "recruiting_crm_contacts" ("userId", "spaceId") INCLUDE ("identityKey", "id", "crmCandidateId", "firstSyncedAt", "stage", "outreachStatus", "contactStatus", "name", "email", "title", "company", "location", "linkedinUrl", "lastReplyAt") WHERE "archivedAt" IS NULL;
