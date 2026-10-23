# Overview count semantics

These are development semantics, not live acceptance or a new metrics definition.

- **Shortlisted** counts recorded native shortlist decisions. Weekly buckets use actual recorded shortlist timestamps. CRM high-signal labels, pipeline membership, imported contacts and unknown historic dates are not converted into native shortlist decisions or dates.
- **Contacted** cannot be inferred from campaign enrollment. A draft campaign proves zero sends; a started campaign's lead list does not prove how many people received email, so Overview reports this count as unknown until an existing read supplies actual send evidence.
- **Interested** counts reported lead interest statuses already used by the product (interested, meeting booked/completed, won), only when the complete lead list is known.
- **Replied** remains the existing role-scoped CRM projection's outreach-status count. No synced role metadata now means unavailable rather than zero. Existing synchronized rows still do not establish live freshness or a completed historical full sync; that limitation remains, and a new completion receipt is not invented here.
- Campaign identity remains readable if its lead request fails. `leadsComplete` distinguishes complete valid bounded results from failed, malformed, cursor-bearing, or full 100-row pages. Such pages must not become zero or an exact total. Workspace setup also reports recipient totals as unavailable in this case.
- Aggregates remain unknown if any included role has an unknown count. A partial known subtotal is not presented as a complete total or percentage.

No new date filters, interview metrics, historical shortlist backfill, send count inference, campaign creation, or visual redesign is included. The broader unified-workspace Overview checklist remains outstanding. Production data and external providers were not accessed for these changes.
