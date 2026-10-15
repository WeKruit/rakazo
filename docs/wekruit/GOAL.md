# WeKruit recruiting workspace

Run the upstream Rakazo product as a whole: Web, API, worker, Pi runtime, native
Crew, memory, tools, and interaction cards. Use Supabase Postgres and cloud
compute. Reuse upstream features and the native sandbox executor.

## Immediate delivery — Modal login and Crew chat

The current deliverable is one real HTTPS webpage on Modal. A user can sign in
through Rakazo's existing authentication, connect the existing Codex subscription,
and converse continuously with Main and Sourcer in a native Crew group. Refresh,
reopening, and a controlled restart preserve the chat and provider connection.

Use Supabase Postgres for Rakazo's own account, chat, task, card, and memory state.
Retain native authentication; integration with existing Supabase Auth/CRM is later
work. Initialize a dedicated PostgreSQL database in the existing Supabase cluster,
with the user's database-creation approval: the existing CRM already has an
incompatible `threads` table. This keeps upstream migrations and runtime unchanged.
The additional database is managed through Postgres, not Supabase Dashboard/Auth/
PostgREST. Do not create a newly paid project or overwrite existing CRM objects.

The user accepts keeping a sandbox to reproduce the native product first. Defer
the optional-computer refactor. Use an already-supported cloud provider, initially
E2B Hobby if usable credit is verified, with the native Team Computer shared by
Main and Sourcer. Retain native provisioning, workspace persistence, and idle
sleep. Browser work is not part of the initial acceptance. Verify actual resource
allocation, pause/resume, and credit/spending controls before starting compute;
do not infer that a free plan makes usage free or upgrade to a paid subscription.

Modal runs the original Web/API/worker/Pi with deployment configuration. Keep a
small persistent volume for native file artifacts; task, chat, memory, and OAuth
credentials remain in Postgres, with encryption keys in server-side secrets.
No Docker on the user's Mac, new subscriptions, or unapproved paid usage. Check
the existing Modal and sandbox accounts' usable credit and spending limits before deployment.

Do not connect or migrate Autumn, Instantly, Gmail, Calendar, enrichment, CRM,
Slack, or business scripts in this iteration. Existing pilot connections remain
untouched. Script/file-based sourcing and deduplication reported in the current
workflow are later business migration requirements, not completed capabilities.

## Recruiting journey through P6

Main owns scope, calibration, and human approvals. Sourcer returns candidate
sources and evidence. Native Crew, choices/custom input, once-only approvals, and
memory must work before the recruitment loop is accepted. Then connect Autumn,
continue the same sourcing task after feedback, persist evidence and decisions in
the existing authorized CRM, and send through Instantly only after exact-payload
approval. A confirmed reply stops follow-ups. Verify permissions, session switching,
and restart without duplicate effects. Slack is outside scope.

Use existing integration and memory boundaries. Retain upstream authentication for
the initial deployment; a PostgreSQL connection does not establish integration with
existing Supabase Auth or CRM permissions. Do not claim either without acceptance.

## Current evidence

The earlier local pilot connected Codex OAuth, obtained one real model reply, and
installed Instantly's accounts/campaigns/emails GET tools through the native API
source and encrypted secret store. Each Instantly operation returned HTTP 200.
No email was sent or campaign modified. These are pilot results, not cloud proof.

The approved independent database is created and owned by its runtime role. The
temporary administrator SET ROLE grant was revoked. All 102 unchanged upstream
migrations completed, with no unfinished migration; Graphile's schema is present.
The original CRM `threads` schema fingerprint matches the pre-deployment baseline.
The free IPv4 Session pooler reaches the correct database and supports LISTEN.
The original custom-schema investigation was withdrawn; no database adapter patch ships.

Modal SDK 1.6.1 is installed in a project-specific environment. The user authorizes
Modal use after the existing workspace's exhausted free credit was reported; this
validation was proposed with a $5 cap. A dedicated App, Secret and Volume are
deployed. Native readiness is HTTP 200 with Pi, E2B, Graphile, Postgres realtime,
and the encrypted secret store; Web production build and API typecheck pass.
The replacement E2B key passes official read-only authentication; its account
shows $100 credit and no payment method. The native shared E2B computer has run.
Owner signup and official Codex device OAuth completed on the deployed website.
Main and Sourcer replied in a native Crew using the saved OpenAI Codex connection.
Sourcer retained the first turn's role, requirements and marker while incorporating
the next turn's feedback. After container replacement, group/thread/member/model
connection IDs and the original four message hashes and two runs were unchanged.
A new natural chat message then received a correct context-based Main reply,
leaving six messages and three completed runs with no duplicated earlier run.

The frontend's shared two-second thread snapshot deadline cancelled valid remote
history responses. Raising that deadline to cover the API's transaction/pool
budget restored history after refresh; this is the only product source change
in the current deployment. Native sandbox file pause/resume, a separate logout/
login test, exhaustive cards and P0–P6 business acceptance remain open.
