-- Some imported CRM sources stored a mail workspace id (a UUID) as the person's company.
-- It names no employer: drop it from saved sources and use the first source with a real
-- company instead, or none. New reads skip such ids the same way.
WITH fixed AS (
  SELECT c.id,
    CASE WHEN jsonb_typeof(c.profile->'sources') = 'array' THEN jsonb_set(c.profile, '{sources}', (
      SELECT coalesce(jsonb_agg(CASE
        WHEN s->>'company' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN jsonb_set(s, '{company}', 'null'::jsonb)
        ELSE s END ORDER BY i), '[]'::jsonb)
      FROM jsonb_array_elements(c.profile->'sources') WITH ORDINALITY AS e(s, i)
    )) ELSE c.profile END AS profile
  FROM recruiting_crm_contacts c
  WHERE btrim(c.company) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR c.profile::text ~* '"company": "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"'
)
UPDATE recruiting_crm_contacts c SET
  profile = fixed.profile,
  company = CASE
    WHEN btrim(c.company) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (
      SELECT s->>'company'
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(fixed.profile->'sources') = 'array'
        THEN fixed.profile->'sources' ELSE '[]'::jsonb END) WITH ORDINALITY AS e(s, i)
      WHERE btrim(coalesce(s->>'company', '')) <> ''
      ORDER BY i LIMIT 1)
    ELSE c.company END
FROM fixed
WHERE c.id = fixed.id;
