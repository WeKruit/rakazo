-- Backfill chat group names that still hold the web client's "New role" placeholder
-- with the real recruiting role title. Idempotent: only placeholder names change.
-- Localized placeholders are not listed because every locale's msgstr for "New role"
-- is empty (falls back to the English msgid).
UPDATE "chat_groups" g
SET "name" = r."title"
FROM "recruiting_roles" r
JOIN "threads" t ON t."id" = r."sourceThreadId"
WHERE t."groupId" = g."id"
  AND g."name" IN ('New role')
  AND r."title" <> ''
  AND r."archivedAt" IS NULL;
