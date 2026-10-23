# WeKruit product handoff

Updated: 2026-10-16. Start here, then read the linked authoritative plans.

## Responsibility and finish line

Continue delivering the existing Rakazo-based recruiting product. P0–P6 is M1,
not the end of the project. Preserve all 181 applicable actions across M1–M5:

- M1: native Main/Sourcer, memory, recoverable interactions, recruiting loop.
- M2: Juicebox/Metix recruiting workspace and usable candidate/role workflows.
- M3: full Grok Bot-style agent, group, runtime, plugin, file and routine features.
- M4: existing services, source materials, history and ongoing work migration.
- M5: real users/organizations, applicable surfaces, recovery and final acceptance.

Authoritative documents, in order:

1. [GOAL.md](GOAL.md)
2. [PLAN.md](PLAN.md)
3. [PRODUCT-SCOPE.md](PRODUCT-SCOPE.md): stable action IDs and acceptance boundaries.
4. [RECRUITING-DOMAIN-PLAN.md](RECRUITING-DOMAIN-PLAN.md): T01–T10.
5. Repository [AGENTS.md](../../AGENTS.md) and [Modal runbook](../../infra/modal/README.md).

The owner wants a working product, not repeated sourcing demonstrations. Reuse
Rakazo's complete frontend/backend and native primitives. Do not introduce a new
harness, model stack, dependency or test framework to replace working features.
Slack is deferred. No local Docker. Stop before new purchases/subscriptions.
Search/continuation may use existing authorized quotas and provider rate limits;
actual outbound still needs its exact native approval. Historical approvals are
not new authorization. Avoid parallel deployers or competing edits to shared files.

## Repository and release baseline

- Repository: https://github.com/WeKruit/rakazo
- Working branch: `codex/recruiting-workspace`.
- Handoff parent: `4cd47e40b8beee62d1f0acba73673e241054dc70`.
- Last deployed product code: `46b880f20eba854292526e41c3bd907b91455016`.
- Later documentation commits do not imply a new deployment.
- Stack: Rakazo Web/API/worker, native Pi, existing Codex subscription OAuth,
  independent Supabase application database, Modal Secret/Volume and native E2B.
- This is Pi using a Codex OAuth connection, not a Codex CLI native session.
- Production identifiers, private evidence and access instructions belong in the
  separately supplied private access note, not this public repository.

Clone the branch, inspect its current HEAD and read the plans. Do not reset an
existing checkout or overwrite later work. If a newer release exists, verify its
actual code, health and evidence before adopting its claims.

## Proven and incomplete work

Previously verified in the real webpage:

- Owner login, saved Codex OAuth, Main/Sourcer Crew and continuous conversation.
- Native memory write and cross-conversation recall; full user isolation is open.
- Selected native choice/custom-input/approval paths continuing the original run,
  including pending cards restored after actual container replacement.
- Native file bytes and hashes, histories and original waiting state surviving
  replacement. Do not generalize this to every recovery case.
- Normal JD intake creating/binding a role and same-thread revision v1 to v2;
  unchanged criteria/preferences and prior sources were retained.
- Role/revision/binding and immutable completed effect/event commit atomically.
  The latest batch passed 206 real isolated PostgreSQL checks, 120 adapter checks,
  types/format and an independent targeted review. These are historical results,
  not a claim that a new checkout has been tested.
- CRM OAuth identity/organization and Autumn/Instantly read calls; complete
  recruiting writes and outreach have not been accepted.

Open work includes original-material rereading, complete extraction/evidence
assessment, real Autumn feedback and same-provider-task continuation, CRM writes,
exact approved sending and reply-stop, workspace editing/filtering/pagination,
per-bot runtime/connection/plugins, full group/routine/library behavior, second
user/organization acceptance and uncertain external-write recovery.

Do not clear the historical executing test effects, wake their terminal runs,
cancel old human cards, or infer success from a completed run. Their exact IDs
and snapshots are private handoff evidence. No production cleanup is authorized.

## Latest investigation: correct the source diagnosis

An intact saved file with `truncated:false` can coexist with a shortened model
tool result carrying `contextTruncated:true`. The existing retrieval strategy
shortens older ordinary tool results once a later tool call exists. Offline
replay of retained material reproduced this. The actual earlier model projection
was not retained, so do not claim the exact historical projection is proven.

The follow-up role revision persisted, but it did not reread the original blob
or reliably verify the requested condition. Persistence passed; semantic source
verification did not. A role snapshot or old assistant note is not a fresh read.
The natural-language `direct` intent label is not proof that a condition is true.

## First implementation: native saved-artifact reading

Implement the already identified missing capability, then test it in normal chat:

1. Reuse the authenticated actor/blob read behind
   `apps/api/src/artifacts.ts:getSpaceArtifactById`. Put shared behavior below the
   API layer so both API and executor use it; do not call the router from adapters.
2. Add a generic read-only native `artifact_read` tool using actual Artifact ID
   and bounded text offsets. Read the stored version, not a new webpage fetch.
3. Reject foreign actor/space access before blob access. Verify the real bytes,
   hash/length and truthful text/paging state. Keep original metadata distinct
   from context shortening. Use existing contracts, tool catalog, provider-neutral
   ArtifactStore, disabled-tool/read-only controls and error/redaction paths.
4. Preserve exact source text and contiguous offsets across pages, including
   non-ASCII/emoji. Do not change global context budgets or add blanket exemptions.
   Clearly bound supported material formats rather than inventing extracted text.
5. Leave a runnable check for isolation-before-read, exact data/metadata and
   lossless paging. Test computer-disabled operation and saved-file restoration.
   Then use a normal same-thread request to reread the retained material, interpret
   its actual state, and only perform an authorized conditional correction.

Do not replace agent judgment with a hardcoded recruiting flow or regex routing.
When evidence is insufficient, preserve unknown and use the existing original
question card where needed. Do not claim every conditional instruction is enforced
merely because source/CAS checks or an intent label passed.

Relevant existing implementation:

- `packages/adapters/src/runtime-context.ts`: older-tool projection/selection.
- `packages/adapters/src/context-selection.ts`: structured shortening/offsets.
- `packages/adapters/src/pi-runtime.ts`: serialization and native dispatch.
- `apps/api/src/artifacts.ts`: actor-authorized blob reading for the UI/API.
- `packages/adapters/src/builtin-tools.ts`, `executor.ts`: native tool integration.
- `packages/contracts/src/builtin-tools.ts`, `packages/core/src/action-approval.ts`.

Next independent M2 work: reuse the existing role revision API and Panel for
human editing, but record the actual human edit and revision in one transaction.
Keep stable criterion/atom IDs and expression structure, CAS, draft preservation
on conflict and old assessment versions. Structured recall filters are separate
from qualification criteria. See J06 rather than inventing a new role wizard.

## Reproducible verification

Use Node 24 and the repository's pinned pnpm. Install from the lockfile:

```sh
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile
pnpm --filter @rakazo/db generate
pnpm exec vitest run packages/adapters/src/recruiting-tools.test.ts packages/adapters/src/executor-effect-idempotency.test.ts
pnpm --filter @rakazo/db check
pnpm --filter @rakazo/adapters check
```

For actual changes, add the relevant existing tests and package checks, including
API/Web when touched. Do not rerun unrelated suites after checks already pass.
Do not run Electron desktop E2E on the owner's Mac; see AGENTS.md.

PostgreSQL tests require a disposable database with the repository migrations.
Never inherit the production runtime `DATABASE_URL` into a test command:

```sh
# TEST_DATABASE_URL must identify the disposable test database only.
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @rakazo/db exec prisma migrate deploy
VERIFY_DATABASE=1 DATABASE_URL="$TEST_DATABASE_URL" pnpm exec vitest run packages/db/src/recruiting.postgres.test.ts
```

Check the actual database name/host first. Without VERIFY_DATABASE and a URL the
suite skips; the string `0` is truthy and does not disable it. Skips are not passes.
Do not create a paid database or start Docker to satisfy this gate.

For production: follow the existing Modal runbook, archive the exact committed
revision, include `.wekruit-source-revision`, preserve existing Secret/Volume and
encryption keys, and deploy only the identified application. Public SPA URLs
named `/health` or `/ready` are not API health proof. Check the API's internal
health/ready, actual source revision, authenticated UI and persisted records.

Before/after deployment compare existing run/card/source IDs, message history,
role/assessment versions, effects, memory and relevant file bytes/hashes. A cold
start observation timeout is not a failed deployment; inspect/poll the same live
handle instead of redeploying. Existing single-writer storage is not scale proof.

Real browser acceptance must keep the original thread/run/card identity, preserve
old data, record actual allowed effects and display results. Save screenshots and
private receipts; do not publish production data. Only then update plans and
acceptance status. No broad completion claim from a narrow synthetic test.

## Execution and reporting

The owner explicitly returned execution to the local session on 2026-10-16.
This supersedes the earlier cloud-only requirement. Reuse the existing checkout,
preserve private work and uncommitted changes, and continue product development
and isolated nonproduction checks without creating a replacement harness.
Do not resume Dot orchestration or scheduled continuation. Local execution still
requires the computer to remain online; it is not offline cloud execution.

This takeover does not authorize automatic PR merging, deployment, production
migrations or real outbound actions. Keep runtime secrets in their existing
private configuration, Modal Secret and native encrypted SecretStore; GitHub
contains code/plans only. Do not export cookies, OAuth credentials or keys.
Verify the actual execution location and disposable database identity before
tests. Report the current revision, actual checks and remaining acceptance gaps;
the latest local PostgreSQL evidence is recorded in PLAN.md.

Own the responsibility through M1–M5. Parallelize independent work with file
ownership; centralize shared contracts/executor integration and deployment.
Report shipped behavior, evidence and remaining gaps after each meaningful batch.
Keep the Goal active until all applicable actions pass. Stop for new spending;
exact outbound actions remain subject to native human approval.
