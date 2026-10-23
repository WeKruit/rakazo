# CRM → product sync: field mapping and gaps

Date: 2026-10-23. Sources read: WeKruit/headhunter-agent `supabase/migrations` (CRM schema, `crm_list_candidates`, role/correspondence RPCs) and `supabase/functions/mcp/tools/crm.ts`; WeKruit/rakazo `apps/api/src/recruiting.ts` (`getRecruitingCrmData`, `mergeRoleCandidates`), `packages/contracts/src/recruiting.ts`, `packages/db/prisma/schema.prisma`.

## How it works today

- The product never touches the CRM database directly. Every CRM read goes through the CRM MCP (edge function `mcp`) as the signed-in user, via `recruiting.crmData` (`getRecruitingCrmData`).
- The sidebar lists CRM roles live (`memberships` → `roles`). A role's contacts are read live inside `recruiting.roleCandidates` (capped at 10 pages × 50) and merged with Autumn rows by LinkedIn identity, then email.
- Nothing is stored. A CRM outage means no CRM rows, every open of a role re-reads up to 500 contacts, and most CRM fields (reply, interest, resume, review) are dropped by the read schema.

## The sync

Same authorized MCP reads, written into four owner-scoped tables (`spaceId` + `userId`, like reminders). Keys are the CRM's own UUIDs, so re-running never duplicates. Nothing is deleted: a role or contact that disappears from a complete CRM pass gets `archivedAt`; it is cleared if it comes back. CRM rows are only read. A dry run does every read and reports counts, writing nothing.

Incremental: every live `roleCandidates` read also refreshes that role's rows, and the full sync can be re-run any time (only changed rows are written).

| CRM (MCP read) | Product table / field | Notes |
| --- | --- | --- |
| `list_crm_memberships` → organization id, name | `recruiting_crm_roles.organizationId`, `organizationName` | One CRM connection can have several organizations |
| `list_crm_roles` → client id/label, role id/label, summary | `recruiting_crm_roles` (`crmRoleId`, `clientId`, `clientLabel`, `roleLabel`, `summary`) | Unique per user+space+server+org+crmRoleId |
| `list_crm_candidates` (org-wide pass) `candidate_id` | `recruiting_crm_contacts.crmCandidateId` | Same id as the product's `crm:<id>` list key |
| `full_name` | `name` | |
| `headline` | `title` | CRM has no separate current title |
| — | `company` | **Gap** (see below) |
| `location` | `location` | |
| `email`, `phone`, `linkedin_url` | `email`, `phone`, `linkedinUrl` | |
| derived | `identityKey` | `linkedin.com/in/<slug>` (same rule as the list merge) else lowercased email; used to match Autumn rows |
| `stage`, `contact_status`, `outreach_status` | `stage`, `contactStatus`, `outreachStatus` | Stored exactly as the CRM returns them |
| `interest`, `reviewed`, `last_reply_at`, `resume_received` | `interest`, `reviewed`, `lastReplyAt`, `resumeReceived` | Already returned by the CRM, previously dropped |
| `role_spec_id`, `client_label`, `role_label` | `crmRoleId`, `clientLabel`, `roleLabel` | The contact's canonical pipeline role |
| per-role `list_crm_candidates` (role labels) | `recruiting_crm_role_contacts` (role ↔ contact) | A contact can be linked to several roles; links are archived, not deleted |
| `list_crm_role_correspondence` (per role) | `recruiting_crm_messages` | Message id, candidate, role, direction, date, from/to, subject, body, thread. Mail is immutable, so rows are upserted, never archived. Skipped when the CRM has no role-wide mail read |

## Gaps

1. **Company, experience, education.** The CRM stores them (`candidate_sources.title/company/location`, `candidates.history`, `summary`, `skills`), but no CRM MCP tool returns them. Filling them needs one new read-only MCP tool in headhunter-agent (user-scoped RLS select, no migration) plus adding it to Main's tool allowlist. Not in this PR; the enrichment path can also fill them later.
2. **Correspondence outside a role.** Mail is synced per role. Mail for contacts in no role is not synced (the per-contact read is one call per person).
3. **Outbox drafts** (`crm_candidate_messages`) and review notes are not copied; they stay live reads.
4. The product list still shows the same fields as before (name, title, location, email, LinkedIn, stage/outreach). Showing phone, interest, last reply and company in the list/profile is a small follow-up for the profile redesign.


## Development update (2026-10-23)

See `docs/development/crm-sync-delivery-2026-10-23.md` for the completed field transport, exact-ID absence checks, migration order, local evidence and deployment-owner procedure. Company and lossless stored history/summary/skills/source evidence are now implemented through the existing candidate-list MCP adapter and typed product projection. Inspection found no CRM education field; education remains unknown. Dry run writes only transient server-owned progress metadata, never source data or projection rows. Historical statements above describe the original PR, not the corrected implementation.
