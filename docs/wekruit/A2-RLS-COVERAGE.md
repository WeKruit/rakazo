# A2 full-schema policy coverage inventory

All 92 application tables are accounted for below. Six have opt-in policies and restricted-role PostgreSQL tests; the remaining 86 still rely on application authorization. This inventory is not an implementation claim. No remote or production operation was performed.

## Implemented / tested (6)

`artifacts`, `messages`, `recruiting_roles`, `recruiting_role_revisions`, `recruiting_candidates`, `recruiting_calibration_rounds`.

## Auth / system / membership boundary (14)

`user`, `session`, `account`, `verification`, `rateLimit`, `organization`, `billing_accounts`, `member`, `spaces`, `space_members`, `invitation`, `deployment_settings`, `integration_provider_configs`, `push_tokens`.

## Shared Space authority (6)

`action_approval_rules`, `bot_deletions`, `agent_secrets`, `boards`, `tickets`, `ticket_comments`.

## Personal across Spaces (3)

`user_model_credentials`, `user_voice_credentials`, `secrets`.

## Child ownership / multiple parent consistency (21)

`chat_group_members`, `events`, `attempts`, `external_effects`, `memory_revisions`, `computer_updates`, `computer_execution_leases`, `messaging_channels`, `messaging_channel_members`, `messaging_outbound`, `agent_connections`, `external_messages`, `recruiting_research_tasks`, `recruiting_research_actions`, `recruiting_assessments`, `recruiting_candidate_pages`, `recruiting_candidate_occurrences`, `recruiting_crm_imports`, `recruiting_replies`, `recruiting_crm_role_contacts`, `steering_messages`.

## Personal Space rows (42)

`ai_data_consents`, `action_auto_review_preferences`, `space_model_preferences`, `space_backup_models`, `space_voice_preferences`, `bots`, `bot_sections`, `chat_groups`, `threads`, `tasks`, `runs`, `cloud_agents`, `routines`, `scratchpad_items`, `taught_skills`, `agent_skills`, `connections`, `capability_installs`, `memory_documents`, `agent_homes`, `browser_profiles`, `computers`, `usage_records`, `notification_preferences`, `space_memory_configs`, `mcp_servers`, `mcp_oauth_sessions`, `bot_mcp_servers`, `messaging_identities`, `messaging_link_codes`, `bot_secrets`, `external_conversations`, `recruiting_reminders`, `recruiting_crm_roles`, `recruiting_crm_contacts`, `recruiting_crm_messages`, `recruiting_crm_sync_progress`, `recruiting_candidate_notes`, `recruiting_saved_profiles`, `recruiting_crm_workspace_attachments`, `recruiting_crm_campaigns`, `recruiting_crm_leads`.

## Remaining work and concrete semantic dependencies

- Personal Space rows have usable owner keys today. They are not permission-blocked. Add owner/Space/current-membership policies and positive and cross-owner fixtures per delegate. Reminders, notes and saved profiles use `ownerUserId`, not bot attribution. `usage_records` needs a separately authorized deployment-owner aggregate path before restricting operator reports.
- Research tasks/actions/assessments/pages/occurrences have independent parent references. The schema does not prove all parents have one owner. Actions must match task/revision/run/source message/artifacts; pages must match role/revision/task/action/effect/artifact; occurrences must match both page and candidate role. Add coordinated `WITH CHECK` clauses and mismatched-parent fixtures. A role-only predicate is insufficient for writes. Avoid policy recursion through pendingActionId and currentRevisionId.
- CRM imports/replies inherit occurrence/revision ownership plus native effect references for binding, provider evidence and send approval. Complete `external_effects` -> `runs` ownership before covering those relationships. CRM role/contact links must validate both endpoints. External organization IDs are not product authorization; CRM mirrors retain local user/Space isolation.
- Events/attempts/effects/leases inherit thread/run/computer scope. Agent connections have two bots; confirm intended visibility to requester and target before choosing one-parent isolation. Messaging channels/members/outbound have optional identity/thread links; orphan/shared-channel visibility needs explicit tests, not NULL-as-allow-all. Steering messages must validate both their message and optional run.
- Boards/tickets/comments intentionally support Space collaboration. Creator IDs are attribution, not exclusive ownership. Action rules and agent secrets also use Space authority. Separate member reads from administrative writes and test shared members before enabling policies.
- Auth/session/account/verification/rate-limit queries run before actor resolution and keep their explicit system client. That is not a reason to grant actor roles unrestricted access: audit actual RPC use and reduce grants or add user policies. Push tokens link both session and user. Membership/Space/invitation/billing paths support creation/removal and switching Spaces; active-Space-only isolation would hide valid navigation. Define navigation reads and membership-admin writes, and avoid membership policy recursion.
- Credentials span a user's Spaces; nullable-Space secrets may be user-global. Deployment settings/provider configuration are system-level authority. Audit actor reads and grant only necessary operations; do not add implicit privileged fallback.

These are outstanding local design, implementation and regression tasks, not cloud permission blockers. Only production role/credential/grant/policy activation, deployment, actual transaction-pooler execution and online p95 require unavailable production authorization. The separate publication pause prevents push/PR/merge.

## Expanded local batch

The script now protects role revisions, candidate selections and calibration rounds in addition to the original three tables. Roles do not query revisions in their policy, avoiding a policy cycle. Candidate writes require an accessible shortlist message; approval attribution must match the actor. Membership predicates now include the organization/Space/member joins used by `requireMembership`.

`RLS_TEST_DATABASE_URL=<dedicated-local-db> pnpm test packages/db/src/actor-db.postgres.test.ts`: 8/8 passed. Coverage includes missing owner filters, foreign parent links, own revision transaction, stale organization membership, native transactions, actor cleanup, startup validation and deferred iterators. The existing API isolation fixture also passed against all six policies: 143 OK, zero leaks/warnings, 99 owner-empty reads unexercised. This does not prove unimplemented policies or production latency.
