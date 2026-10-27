# A2 first-batch boundary and full-schema inventory

The first rollout batch is **all 22 `recruiting_*` tables, messages and artifacts, plus threads/tasks/runs/events/external effects as the ownership and receipt dependencies**: 29 tables. Direct queries to a recruiting child no longer depend on the caller remembering its parent filter. Each protected table has nonempty synthetic data for two users, real non-owner/NOBYPASSRLS reads and legal writes. The authenticated actor composition is opt-in and fails closed; workers/auth/migrations retain their explicit system identity.

This is a staged rollout as specified by A2, not whole-schema RLS. The 63 other tables are enumerated for later batches or separate system authorization, not all counted as missing user-data policies in this batch. No production activation or publication occurred.

## First batch (29)

`artifacts`, `recruiting_roles`, `messages`, `recruiting_role_revisions`, `recruiting_candidates`, `recruiting_calibration_rounds`, `threads`, `tasks`, `runs`, `external_effects`, `events`, `recruiting_crm_roles`, `recruiting_crm_contacts`, `recruiting_crm_messages`, `recruiting_crm_sync_progress`, `recruiting_crm_campaigns`, `recruiting_crm_leads`, `recruiting_crm_workspace_attachments`, `recruiting_reminders`, `recruiting_candidate_notes`, `recruiting_saved_profiles`, `recruiting_research_tasks`, `recruiting_assessments`, `recruiting_candidate_pages`, `recruiting_candidate_occurrences`, `recruiting_research_actions`, `recruiting_crm_imports`, `recruiting_replies`, `recruiting_crm_role_contacts`.

## Outside this batch: Auth / system / membership boundary (14)

`user`, `session`, `account`, `verification`, `rateLimit`, `organization`, `billing_accounts`, `member`, `spaces`, `space_members`, `invitation`, `deployment_settings`, `integration_provider_configs`, `push_tokens`.

## Outside this batch: Shared Space authority (6)

`action_approval_rules`, `bot_deletions`, `agent_secrets`, `boards`, `tickets`, `ticket_comments`.

## Outside this batch: Personal across Spaces (3)

`user_model_credentials`, `user_voice_credentials`, `secrets`.

## Outside this batch: Child ownership / multiple parent consistency (11)

`chat_group_members`, `attempts`, `memory_revisions`, `computer_updates`, `computer_execution_leases`, `messaging_channels`, `messaging_channel_members`, `messaging_outbound`, `agent_connections`, `external_messages`, `steering_messages`.

## Outside this batch: Personal Space rows (29)

`ai_data_consents`, `action_auto_review_preferences`, `space_model_preferences`, `space_backup_models`, `space_voice_preferences`, `bots`, `bot_sections`, `chat_groups`, `cloud_agents`, `routines`, `scratchpad_items`, `taught_skills`, `agent_skills`, `connections`, `capability_installs`, `memory_documents`, `agent_homes`, `browser_profiles`, `computers`, `usage_records`, `notification_preferences`, `space_memory_configs`, `mcp_servers`, `mcp_oauth_sessions`, `bot_mcp_servers`, `messaging_identities`, `messaging_link_codes`, `bot_secrets`, `external_conversations`.

## Why the other categories are separate

- Auth, sessions, verification and rate-limit state are used before an actor exists. They require an explicit auth/system role, not a personal active-Space policy. User/member/Space/invitation/billing tables also support authenticated navigation and membership administration across Spaces. A future least-privilege grant review must distinguish these paths and avoid recursive membership policies. Deployment settings/provider configuration are deployment authority. These are not automatically “user rows missing RLS.”
- Shared boards/tickets/comments, action rules and agent secrets use deliberate Space collaboration. Creator IDs are attribution, not exclusive ownership. Their later policy batch must distinguish member reads and authorized administrative mutations; a personal userId policy would break the current sharing contract.
- Personal credentials and nullable-Space secrets can span a user's Spaces. They need a separate secret/credential boundary review. General assistant memory, bots, computers, connectors, routines and messaging are later user-data batches. They retain application authorization now; this release does not claim all possible copies of recruiting text in general assistant memory are database-isolated.
- Remaining child tables belong to general messaging/computer/agent graphs, not the recruiting receipt chain. Agent connections have two parties and messaging links can be optional; define intended visibility in those later batches rather than inventing it here.

## Receipt chain policy and remaining business authorization

Recruiting children inherit a protected role/revision/task/page/occurrence. CRM role-contact links require both protected endpoints. Direct mirrors retain local user and Space keys; an external CRM organization ID never grants product access. Candidate notes/reminders use ownerUserId; saved profiles validate their native source effect. Mutation checks reject foreign runs, artifacts, messages, MCP servers and receipt effects. Native effects inherit their protected run; events inherit their protected thread. Role policies do not query revisions, avoiding a cycle with the role's deferred currentRevision foreign key.

RLS establishes account/Space isolation, not a new recruiting workflow engine. Existing revision matching, approval proof, source validity and tool authorization remain enforced by business services and schema constraints. The tests explicitly distinguish synthetic fixtures from real provider receipts; no source data was fetched and no outreach or external action ran.

## Local evidence

`RLS_TEST_DATABASE_URL=<dedicated-local-db> pnpm test packages/db/src/actor-db.postgres.test.ts`: **12/12 passed**. The 29-table matrix checks nonempty owner reads and absence of foreign rows without application filters. Fixtures for the 23 expanded tables are inserted through the restricted actor client; immutable snapshots use legal inserts, not updates. Legal mutable-row updates exercise WITH CHECK. Fifteen representative cross-parent mutations fail specifically with a row-level-security error. All 29 tables become unreadable after organization membership removal. The schema cascades Space membership deletion; earlier “stale membership” wording was inaccurate and is corrected here. A user who belongs to both synthetic Spaces still sees neither another owner's rows nor their own rows from the inactive Space. Missing actor, privileged role, extra permissive policy, transaction cleanup and async iterators remain covered.

The enhanced original API isolation fixture creates a real synthetic reminder via RPC: **144 OK, 0 leaks, 0 warnings, 98 owner-empty reads** (previously 143/0/0/99). The 98 remain unexercised API paths, not passes. Nonempty database fixtures now separately cover all recruiting tables, including receipts/CRM tables without a direct public list endpoint. This distinction is intentional; it does not turn a database row into a provider-approved product action.

First complete-batch local latency run: baseline p95 9.32 ms, RLS 16.25 ms, **+74.36%**, zero errors (200 requests per mode, concurrency 5). It does not meet the <10% target. Parallel local load may affect results; the benchmark now records all samples in a counterbalanced three-pair run. Transaction-local identity is not weakened for performance: native callback/batch transactions bind once; standalone queries still BEGIN, bind identity, query, COMMIT. Constant membership lookups avoid repeated correlated membership joins. The quiet six-sample run also failed: paired p95 +19.51%, +60.52%, +42.72%. Complete samples are recorded in the pilot report; online/transaction-pooler performance remains untested.

Membership checks now use the wired STABLE SECURITY INVOKER function with a fixed search_path. Startup validates its non-definer/stable attributes; tests reject unsafe changes. This reduces plan expansion without changing transaction-local identity or caching membership. The pilot report contains corrected callback/Promise SQL timing and before/after EXPLAIN evidence; these do not replace HTTP measurement. The final quiet-window HTTP pairs were +58.16%, +5.93%, +16.52%; the local comparison is not consistently within 10%. The formal online gate remains unmeasured because deployment is prohibited.

The latest local helper uses a static PL/pgSQL RETURN EXISTS instead of the SQL-language body. Only PostgreSQL's query plan is reused; actor settings and membership data are read fresh per statement. All 12 safety tests still pass. This refinement's quiet HTTP comparison also did not meet the target: pairs +16.17%/+48.85%/+74.33%, true pooled 600-request p95 +59.21%. All raw durations and prior complete measurements are retained; formal online acceptance is still unmeasured.
