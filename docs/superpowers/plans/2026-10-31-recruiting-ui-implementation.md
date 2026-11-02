# Recruiting UI implementation

Approved input: PR #750 and its review. This plan implements the agreed contracts. Existing provider drafts remain the only Sequence state; existing Reviewer results remain the only fit grades. No external sends, deployments or production data changes are part of development checks.

## Parallel work and ownership

1. Ranking/filter/provenance: contracts candidate filters/recruiting candidate fields, database candidate read, merged role-candidate read, useRoleCandidates and CandidateDirectory. Preserve Reviewer source/version before filtering; tier-only group mapping. Query/filter/count/sort before paging. One meaningful failing regression check for old-vs-current, old-provider and missing grades, ties and pagination.
2. Sequence: existing native draft operations and focused contract/service/web editor modules. No Sequence table, no duplicate steps/delivery state. Exact selected campaign, authorized connection, optimistic stale-edit detection by current provider content if supported, zero recipients and save never activation. Parent owns shared RPC/index/router wiring. Tests cover ownership, empty recipients, no-send allowlist and existing draft edits.
3. Analytics: shared scoped metric contract, stored evidence aggregation, web analytics surface. Person unit, original first-send cohort, imported history coverage, distinct account vs role identity. Cumulative stats not date-filtered, partial history is explicit. Parent owns shared wiring. Tests cover cross-role dedupe, cross-window replies, missing first-send history, zero denominator and import provenance.
4. Parent: update #750 contracts; shared exports/RPC/router wiring, application unread thread cursor persistence and Inbox list/detail integration; scheduling proposal-vs-booking presentation and native operation reuse; Profile/Contacts logo and avatar wiring coordinated with existing components, no synchronization/sorting changes. Do not rewrite shell or role creation.

## Integration and verification

- Work from latest stage, preserve other branches. Use existing workspace dependencies with supported Node.
- Native read cursor: user+space initialization baseline, source thread cursor shared across roles, inbound only, old history read at initialization, markUnread persists, read only through observed message timestamp. No provider unread writes or subject-based guessed identity.
- Scheduling: keep one-slot Cal.com plan, Google direct event path; optional times form proposals, extra guests use native existing operation, location supported by selected calendar path only, notes preserved in confirmation. No plan-as-generic-workflow abstraction.
- Reuse PersonAvatar, CompanyLogo, ProfileImage and saved profiles. Only media projection/display changes; do not re-fetch an existing saved lookup or add a provider.
- Run focused unit/service tests, generated Prisma client, affected package typechecks, UI build and accessibility/layout checks at320 and1440. Existing desktop tests must not steal focus.
- Review spec compliance, then code quality, fix material findings; create implementation PR(s) to stage with exact verification and limitations. Keep offline checks distinct from staging/live acceptance and never use real customer data for tests.

## Implemented scope and release handoff

- Reviewer-provenance/version-aware groups and server-side filtering/order/count before pagination; legacy scores never manufacture a Reviewer grade.
- Existing native zero-recipient sequence drafts, guarded create/save/pause and chat handoff for approved sending. Unsupported rich drafts are read-only to preserve their content.
- Personal inbound read cursors shared across role views, durable first-use baseline, explicit unread, account-switch isolation and bounded batch reads beyond 200 threads. One additive migration; no provider unread writes.
- Existing profile/avatar/company/school projection reused for Contacts, with LinkedIn glyphs. Contacts synchronization and ordering remain with their existing owner.
- Multiple interview times become an exact proposal draft in existing conversation; the one-slot booking path remains separate.
- Analytics exposes observed CRM evidence and explicit incomplete coverage. Native/imported historical coverage and complete first-ever send/rate metrics remain unavailable; missing evidence stays unknown.
- Shared sidebar/header/navigation work remains owned by the parallel shell work. This change does not claim a pixel-for-pixel implementation of all 99 reference states.

Verification uses synthetic local UI at 320 and 1440 pixels and isolated local SQL fixtures; these are implementation checks, not live-product acceptance. The inbox migration was exercised in a rolled-back disposable database transaction, not applied to staging or production. Release requires Claude review, stage merge, staging migration and real authenticated save/read/display checks, then the unified stage-to-main release. No customer messages or provider sends were used for checks.
