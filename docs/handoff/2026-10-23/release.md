# Release handoff — rakazo production (written 2026-10-23 ~15:58 UTC)

You are taking over **production releases** of the rakazo recruiting app (WeKruit Headhunter) on Adam's Mac (Remote Control session, folder `~/wekruit-matching`). Reply to the user in Chinese. Do not deploy until the coordinator (project chat) says "go".

## Live state (verified 15:44 UTC)
- Live SHA: `00abb64ab395ae8529907306bf4d14953edf5e91` (v-latest), container `ta-01M5MPMADSAN9XY784M81C5E2R`.
- Migration ledger (`_prisma_migrations`, finished & not rolled back): **114**. Latest: `20261023000001_recruiting_group_title_backfill`.
- Modal app `wekruit-recruiting`, Secret `wekruit-recruiting-config`, Volume `wekruit-recruiting-files`. Product URL: https://wekruit-livekit-agents--wekruit-recruiting-recruiting.us-east.modal.direct
- DB: Supabase project `fbtovyqmpzofxyzhbzuf`, database `rakazo` (CRM `headhunter-agent` shares the project ref but is a different DB).
- CRM MCP edge function `mcp` = v10 (from headhunter-agent main `3ac9306e`), ACTIVE, verify_jwt=false (function does its own OAuth). Next CRM deploy: `npx -y supabase@2 --output-format text functions deploy mcp --project-ref fbtovyqmpzofxyzhbzuf --use-api --no-verify-jwt` from a clean detached worktree of headhunter-agent main. Never `--prune`.

## Pending batch (merged to main, NOT deployed)
- main = `a168e5b74794c10e65b0698045870409c9d7929d` (may move): #62 archived, #63 detail link, #64/#69 project-thread, #66 stage, #67 luna thoughts, #68 boot timestamps (changes `infra/modal/app.py`: adds `boot.phase` timing lines, migrate no longer `check=True` but `check_returncode()` after logging), #70 reply lead identity, #71 hide internals. No new migrations vs live (ledger stays 114) as of a168e5b7 — re-check.
- **HOLD** until the user's "first-10" search in group 「分拣仓运营主管/经理 — New Jersey」 has landed and the coordinator says go.

## Deploy procedure (one deploy per go)
```zsh
W=/Users/adam/Documents/ChatGPT/headhunter/work/rakazo-wl-h-prewarm
git -C "$W" fetch origin main
SHA=$(git -C "$W" rev-parse origin/main); echo "$SHA"
# 1) migration + infra diff vs live; read every new migration.sql
git -C "$W" diff --name-status <LIVE_SHA> "$SHA" -- packages/db/prisma/migrations infra/modal
# 2) active-run check (rule below), report to coordinator, wait for go
# 3) deploy
zsh /Users/adam/Documents/ChatGPT/headhunter/work/private/core-agent-dev/run/release-main.sh "$SHA" deploy
```
Script: archives the SHA to `private/rakazo-cloud-deploy/releases/<sha>`, `modal deploy --strategy recreate infra/modal/app.py`, waits for the new container, probes `/health` + `/ready` on 127.0.0.1:3100 inside it, checks 7 key-file sha256 vs archive, revision marker, latest migration dir. Must print `RELEASE OK <short>`.
- Script fixes made today: migration assertion compares against the newest migration in the archive (not hard-coded 20261019); post-deploy capture widened `tail -12` → `tail -20` (the 8aec3a5c "RELEASE CHECK FAILED" was this truncation, not a real failure).
- Known gap: "latest migration" is lexicographic. Two migrations share prefix `20261023000000_`; always verify the ledger directly:
```zsh
M=/Users/adam/Documents/ChatGPT/headhunter/work/private/modal-deploy-venv/bin/modal
$M container exec <NEW_CONTAINER> -- node --no-warnings --input-type=module -e "import {createRequire} from 'module'; const {Client}=createRequire('/app/packages/db/package.json')('pg'); const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect(); await c.query('begin read only'); const a=await c.query('select count(*)::int n from _prisma_migrations where finished_at is not null and rolled_back_at is null'); console.log(a.rows[0]); await c.query('rollback'); await c.end();"
```
- Downtime measurement: `$M app logs wekruit-recruiting --since 6m | grep -E "Drained for|Ready for task|worker ready"` → Drained(old) → Ready(new).
- Report one line to coordinator: RELEASE OK, SHA, container, Drained→Ready seconds, ledger.

## Pre-deploy active-run rule (new, from coordinator 15:43)
Recreate kills in-flight runs (15:38 deploy interrupted the user's new-role run ~3 min). Before each go, run read-only on the live container and report:
```sql
select r.id, r.status, b.name bot, g.name grp, r."updatedAt" from runs r join bots b on b.id=r."botId" join threads t on t.id=r."threadId" left join chat_groups g on g.id=t."groupId"
where r.status not in ('completed','failed','cancelled','canceled','interrupted') and r."updatedAt" > now() - interval '30 minutes' order by r."updatedAt" desc;
```
At 15:44: 1 running (`cmvl4ob3900021bfqp0ak3007`, Main, 「分拣仓运营主管/经理 — New Jersey」), 1 old waiting_input (Instantly activation card; cards survive recreate).

## Deploy history today (Drained→Ready downtime)
- b918a01b (12:44, user ran) · 0590e1fe (13:06) · c779d80b (13:18, user) · 16efc914 (13:26, ledger 110→112) · 85f33153 (13:33) · a8d30be5 (13:49, listCandidates P0 fix: 14/15 5xx p50 31s → 0 5xx p50 4.1s) · 40fbb63b (13:58) · 1170ed4d (14:04) · bdbdedaa (14:07) · 5abb6949 FAILED (14:10 Mac network drop, never live) · 3a9886c9 (14:20) · cd033406 · 79d82b50 · 434cb5eb (14:35) · 604d0ce3 (14:42) — all recreate, 45–119 s downtime (median 65 s) with tsx + 0.5 CPU.
- #48 (esbuild bundle + cpu 4.0): 8aec3a5c 26 s · 162b6ea2 19 s · 57fc9a08 21 s (ledger 113, recruiting_reminders) · **00abb64a 93 s** (ledger 114; 32 s drain→migrate done, then ~60 s to worker ready — unexplained regression, flagged to core; #68 boot.phase timestamps in the pending batch should pin it).
- Single-writer constraint: keep `--strategy recreate`, `max_containers=1`; never run two containers. Don't deploy every few minutes — batch.

## Rollback
Re-run `release-main.sh <previous SHA> deploy`. Previous to live: `57fc9a081bdad42aee3581b7f6a8c6810d4738bb`. Migrations are additive (nullable columns, new table, name backfill) — do not roll back schema; stop affected outreach first; never delete data.

## Data changes made today (all reversible)
- 4 legacy bots (admin1@wekruit.com: Main `cmva18nbd00051hfqzyqu4swb`, Sourcer `cmva19wup000l1hfqu7vb3uof`, Outreach `cmvfocnfm00041hfq9o7vo6ig`, Scheduling `cmvfoe3xa000d1hfqo4a7wlzw`) `disabledBuiltinTools` = 9 tools (computer_observe, computer_act, browser_navigate, browser_snapshot, browser_act, open_path, launch_app, request_takeover, request_secret). Previous value `[]` for all four.
- Dyna Data Infra mapping row **deleted** (re-insert to roll back): `{"id":"cmvl0w1os004l1ifqummc3ewc","spaceId":"12033aa4947cfef3e44b5424872ae6ed","runId":"cmvl0uwxv002z1ifqgztk9wep","kind":"instantly_role_campaign","idempotencyKey":"instantly-role-campaign:cmvafvgm000091hfqtf254szq:55eb90bd-55ca-4803-89ab-61fbcbd20862","status":"completed","request":{"roleId":"55eb90bd-55ca-4803-89ab-61fbcbd20862","serverId":"cmvafvgm000091hfqtf254szq"},"result":{"leads":{},"eaccount":"noah@perfectwekruit.org","campaignId":"d4b1bc78-5363-437a-bcb1-343ecc9c85ca","campaignName":"Dyna Data Infra — Rakazo 内部测试"},"createdAt":"2026-10-23T13:45:47.404Z","updatedAt":"2026-10-23T13:45:47.404Z","reviewDecision":null,"reviewReason":null,"reviewModel":null}` (originally campaign 6a1364c1… — never activate that campaign).
- Inserted test-role mapping: external_effects id `01936599-92b2-41b3-af5a-86f1b7eb4670` (role `ce604726-fd3c-4ec7-8ef8-2b725ebf4e40` 「Rakazo 内部测试」 → campaign d4b1bc78…, runId `cmvl1c4nv000g1hfqp2glk28n`). Rollback = delete that id.
- Migration 20261023000001 renamed exactly 2 groups from "New role": `cmvk5658c00091hfqwvypd0x3` → 「分拣仓运营主管/经理」, `cmvl1c44400081hfqbkb0xk2b` → 「Rakazo 内部测试」.
- Dyna duplicate roles: 11 rows, only `939d63f4…` and `d4298147…` empty; nothing changed (core to decide keepers; recruiting_roles now has archivedAt).

## Permissions / safety
- `/Users/adam/wekruit-matching/.claude/settings.local.json` allows: gh pr merge/ready/edit, git push origin *:main, release-main.sh, legacy-bot-tools.sh, the modal CLI path, `npx -y supabase@2`. Compound commands (pipes, `&&` with other binaries) may still be blocked by auto mode — run the allowed binary on its own.
- Never print/export secrets; never `source .env`; read-only queries in `begin read only`; every write in a guarded transaction with rowCount check + read-back.
- Never send real outreach/emails; never activate Instantly campaign 6a1364c1.
- Open items: favicon (#43) shipped in 8aec3a5c; downtime regression on 00abb64a; listCandidates p50 still ~4 s; crmData 5xx are mostly "Client connection prematurely closed" (browser aborts logged as 500).
