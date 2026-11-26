-- An inbox message keeps a copy of the person it is about. That copy was written with the saved
-- person under "autumn" and the key "autumn:<key>"; both are now "sourced" (see
-- 20261126110000_sourced_candidate_keys), and the reader refuses the old shape.
UPDATE "recruiting_inbox_messages"
SET "person" = ("person" - 'autumn') || jsonb_build_object('sourced', "person" -> 'autumn')
WHERE "person" ? 'autumn';

UPDATE "recruiting_inbox_messages"
SET "person" = jsonb_set("person", '{key}', to_jsonb('sourced:' || substr("person" ->> 'key', 8)))
WHERE starts_with("person" ->> 'key', 'autumn:');
