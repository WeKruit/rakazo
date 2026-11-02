# Synthetic browser proof

These are screenshots of the implemented React screens from the local Playwright scenarios. All people, addresses, sources and companies are synthetic. They establish layout/interaction, not an online deployment, provider delivery or customer-data acceptance.

## navigation-1440

![navigation-1440](navigation-1440.png)

## global-inbox-1440

![global-inbox-1440](global-inbox-1440.png)

## global-inbox-320

![global-inbox-320](global-inbox-320.png)

## profile-drawer-1440

![profile-drawer-1440](profile-drawer-1440.png)

## sequence-1440

![sequence-1440](sequence-1440.png)

## sequence-320

![sequence-320](sequence-320.png)

## analytics-1440

![analytics-1440](analytics-1440.png)

## interview-calendar-1440

![interview-calendar-1440](interview-calendar-1440.png)

## scheduling-review-390

![scheduling-review-390](scheduling-review-390.png)

## shortlist-1440

![shortlist-1440](shortlist-1440.png)

## Recruiting search and collapsed navigation follow-up

Synthetic actual-App browser checks cover the persistent 64px icon rail, full-directory Contacts query, global-search contact detail and exact saved-mail navigation at 390px and 1440px. Table scrollbars are transparent until hover or keyboard focus. The unassigned-sequence sidebar section and its network read have been removed. These screenshots are local implementation proof, not deployed-page acceptance.

- [Collapsed navigation](navigation-collapsed-1440.png)
- [Global search, desktop](global-search-1440.png)
- [Global search, phone](global-search-390.png)

The avatar parser now retains photo-only `profile_picture_url` records, with exact-person regression coverage. Historical records are not backfilled. Missing or expired historical source photos remain missing; new-role ingestion must retain the supplied profile facts for future records.

### Actual-route Sequence and role-directory corrections

The global Sequence route now renders six metric cards, period and schedule controls, a searchable sequence table, saved-contact filtering and numeric/date sorting. Each role cursor reads the existing CRM mirror and retained native campaign associations without provider/candidate/correspondence fan-out. Actual created timestamps are retained when supplied; missing privacy, owner, timing and other metadata remain unknown. Native contact filtering uses completed enrollment receipts (never staged recipients), with partial saved-membership coverage.

Direct group/bot Sequence and Interview routes now load the owned workspace and render their native components. Sequence results preserve exact campaign/source identity, and New sequence chooses a role before opening the existing draft composer. Historical source send totals remain explicitly labeled all-time rather than being presented as a date-filtered contacted count.

View all roles opens `/app?view=roles`: the complete owned active-role catalog, searchable across its 50-row pages. It is distinct from the All roles business-scope selector. Archived role controls remain in the sidebar. Latest stage numbered Contacts/Inbox/role paging and retry behavior are retained.

### Full Sequence, directory and profile-channel layouts

- [Global Sequence, desktop](global-sequences-1440.png)
- [Global Sequence, narrow phone](global-sequences-320.png)
- [All roles, desktop](all-roles-1440.png)
- [All roles, phone](all-roles-390.png)
- [Contacts with supplied profile channels, desktop](all-contacts-1440.png)
- [Contacts with supplied profile channels, phone](all-contacts-390.png)

Contacts reuse the existing Shell query cache, keyed by actor/space, filters and page. A refresh displays the same cached rows while the network read runs. The browser check deliberately holds that response and verifies that the rows stay visible and search stays enabled at desktop and phone widths. Changing filters selects the corresponding cache entry; it never reuses another filter's rows.

Saved profile contact channels retain actual supplied email, GitHub, website and Stack Overflow URLs; absent channels are not invented. Email search includes the actor/space-scoped saved profile email. Company/job fallback uses only an explicitly current position. Company and school assets retain their source identities.

### New-role asynchronous profile contract

New saves retain normalized supplied facts inside the existing receipt; missing facts are explicit nulls/empty collections. This path performs no new profile lookup/upsert, queue write or photo download. Candidate/LLM reads reuse the already authorized receipt, including an earlier profile page when a newer grading page becomes the latest source. Native result saves use the retained saving event in the same existing run-scoped proof query.

The existing background reconciler discovers only version-marked new saves. A single partial index, `20261101170000_recruiting_profile_projection_intent_index`, must be applied standalone outside a transaction; it uses `CREATE INDEX CONCURRENTLY` to avoid blocking application writes. It does not backfill profiles or change sequence drafts. PostgreSQL checks establish index eligibility, pending-intent filtering and deduplication; they are not a production latency benchmark.

Background field projection uses the existing SavedProfile table. Photo fetch/encoding runs outside database transactions, and copied images update only when person, owner, space, source effect, observation time and previous URI still match. Existing source URIs remain in place if copying fails. Completed receipts and existing job deduplication support replay after restart. The existing recruiting change event refreshes the scoped UI cache.
