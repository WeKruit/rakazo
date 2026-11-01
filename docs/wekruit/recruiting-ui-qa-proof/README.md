# Recruiting UI acceptance checks

All images here contain synthetic data. They show the actual app, not hosted customer acceptance.

- Global search: [1440px](search-sequence-1440.png), [390px](search-sequence-390.png). `recruiting-search-focus.spec.ts` types with the physical keyboard immediately after opening from the Sequence field, then reopens through the sidebar or phone drawer. Both openings must focus the search input and show the matching contact within three seconds.
- Phone role directory: [drawer](phone-role-drawer-390.png), [directory](phone-role-directory-390.png). `recruiting-mobile-directory.spec.ts` uses six fixture roles, the condition under which View all roles appears, and clicks through the real drawer into the directory.
- Full offline-server journey: [global Main answers](journey-global-Main-actual-tool-answers.png), [native sequence details](journey-native-sequence-actual-metrics-and-contact.png). `recruiting-global-journey.spec.ts` creates two roles through normal chat, checks nine global/role/mobile views and their saved records, waits for the real background Inbox projection, and checks native campaign observations and role/global chat scope. It uses synthetic service/model fixtures and answers no external-send approvals.

The search PostgreSQL check seeds 30,000 owned contacts and 30,000 saved messages. Filtering preserves canonical identity, source revisions, corrections, aliases, attachments, unread state and owner/space isolation. The query sorts scalar identity/state and hydrates message bodies and files only for the selected page. There is no provider read or new search store on this path.

The 24,000-message Inbox check must also run against a newly created, fully migrated local fixture database before `ANALYZE`. A materialized matching-thread join could choose a quadratic plan without statistics, so the query directly windows the narrow corpus instead. The broad first-page assertion has a five-second budget. The complete 12-test Inbox suite passes on two independently created databases with autovacuum disabled for the fixture message table and both analyze timestamps still absent.

Local measurements are implementation evidence. Staging must separately confirm the real search latency, direct typing on reopen, and phone drawer navigation. The Sequence saved-page repair is a separate change.
