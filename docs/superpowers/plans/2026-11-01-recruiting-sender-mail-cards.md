# Recruiting sender and reply cards implementation plan

**Goal:** Complete the two approved #775 comment specifications without adding another router, approval path or message store.

**Architecture:** Existing native tools and per-user/space sender receipts own mailbox setup and reuse. Existing AskBlock/threads.answer/approval effect owns reply editing, dispatch and persistent delivery status. Inbox renders the same stored AskCard through the existing server-paged message reader.

**Stack:** Existing TypeScript contracts, Prisma/PostgreSQL, native connector boundary, React/Base UI and native mobile controls. No new dependencies.

## Sender identity

- Discover currently owned eligible sending domains; do not purchase a new domain. Validate/simulate the proposed concrete mailbox before asking for confirmation.
- Reuse native question cards for company display name and mailbox confirmation. Confirmation is distinct from activation approval. Searches and ordinary drafting remain available.
- Reuse the confirmed sender automatically. Keep owner/space isolation in default selection and every real send. Product mailbox limit defaults to two and is adjustable through existing owner deployment settings.
- Show actual setup/warm-up state. The provider supplies no promised ready date; no date or completed-warm-up status may be invented. Account availability is actual provisioned/active/not-setup-pending state.
- Check idempotent retries, concurrent cap enforcement, sender isolation, existing draft/activation behavior and staging's two native cards.

## Reply card

- Add the typed mail descriptor to the existing AskBlock. The same block, approval effect and receipt supply both conversation and Inbox history.
- Fixed fields: From, original email, To and Subject. Cc and body are editable before sending. Bcc is read-only when present.
- Structured Send answer contains only body/Cc. Revalidate the original anchor, mailbox and To under the existing approval lock. Plain chat text must not bypass this Send click. Discard denies the same approval.
- Persisted effect state drives Needs approval/Sending/Sent/Discarded/Failed. An answer alone is not delivery proof. Actual sent content remains after reload; sending never waits for another LLM turn.
- Reuse existing AskCard and native Ask lane, with a compact sent summary. Keep provider/tool/internal identities out of customer copy.
- Extend existing threads.messages filtering before its existing server limit/cursor; do not load all conversation history or write duplicate Inbox cards.
- Check edits, recipient/anchor tampering, duplicate clicks, discard, failure/uncertain delivery, history reload and cross-account isolation. Verify staging desktop/390px pending/editing/sent/discarded states; test mail only.

## File ownership

Sender work owns native sender helpers, product limit/defaults, provisioning and instructions. Reply backend work owns mail contracts, approval edit/replay/receipt projection and reply dispatch. Web work owns AskCard content, existing API read composition/paging and Inbox rendering. Mobile work owns existing native Ask rendering and its translations/tests. Shared native-mail source edits stay in their separate function ranges.

Release: independent review, merge stage, scoped migrations and staging deployment. A build, merge or healthy endpoint is not real UI/send acceptance. Public proof uses synthetic identities; private mailbox screenshots are not committed.
