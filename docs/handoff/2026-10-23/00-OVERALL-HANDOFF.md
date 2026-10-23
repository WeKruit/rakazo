# WeKruit Headhunter — Overall Handoff for the New Coordinator

Written 2026-10-23 ~16:00 UTC. You are a NEW coordinator session taking over. Read this whole file first, then the per-thread handoffs in `/mnt/project-files/handoff/`.

Sources: the project memory (pasted by the previous coordinator, quoted below), coordinator updates through ~16:00 UTC (these win over older memory), `docs/handoff/2026-10-23/ask-audit.md`, and the acceptance report `docs/handoff/2026-10-23/acceptance-report.md` (byte-identical to the 15:05 version, so the PASS/FAIL tables below are current as of that file; anything after 15:06 is unknown). Anything marked "unknown" is unknown.

User writes Chinese and English. Reply in the language the user used last.

---

## 1. Mission and user rules

### Mission
Ship and verify the WeKruit Headhunter recruiting product (agent that sources candidates, runs a playbook, drives outreach/replies via Instantly, with a CRM-backed workbench UI). Standard of "done" per the ask-audit: **"已完成 = 线上已部署并经过真实验收"** (deployed live AND really acceptance-tested). Merged PRs, local tests, written code do not count.

Live product: `https://wekruit-livekit-agents--wekruit-recruiting-recruiting.us-east.modal.direct` (Modal app; plan in `docs/wekruit/PLAN.md`, "当前交付状态（2026-10-22）").

### Origin
The paused product session handed the WHOLE WeKruit Headhunter product to this project. Private docs on the user's Mac: `/Users/adam/Documents/ChatGPT/headhunter/work/full-product-plan/TEAM-HANDOFF.md`, `MAIL-AND-READ-HANDOFF.md`, `CORE-WORKSTREAM-STATUS.md`. Goal: M1-M5 / 181 PRODUCT-SCOPE actions.

### User rules (from project memory)
- Everything except the PeopleSearchBench closed-loop must be deployed + verified live. PeopleSearchBench is exempt (user said not needed).
- Never ask per-item approval on reversible changes. We merge ourselves, no CI wait: 「不要等CI，直接merge」.
- 「一个岗位开箱即用」 (one role works out of the box).
- Chat open by default and auto-opens on a pending card.
- Cards never show raw internals; use 「确认发送首封邮件」 / 「确认回复」 / 「确认预约面试」.
- NEVER expose vendor names (Instantly, Cal.com, Gmail...) in chat, cards or emails (the connector card is the only exception). Never expose CRM / campaign / leads / setup to users.
- Dev threads: basic tasks on Sonnet (Haiku when asked); the product agent is not covered by that rule.
- Skip "spill tool output to artifact"; DO build "offer-to-automate" (NOT done yet).
- Product agent may use gpt-6-luna for fast/simple turns and gpt-6.1-sol for heavy reasoning; log the served model per run. Prod agent provider = openai-codex (Codex OAuth).
- Agent must ask clarifying questions immediately per the playbook, never defer with an ETA.
- Keep pushing open questions (batch them into one card). Never stop without a deliverable or a blocking question (P0).
- The working display must show the real compressed chain of thought.
- Sidebar shows needs-input / unread / read. Panels are drag-resizable.
- Workloop harness reference = the user's 15:41 message (find it in the previous coordinator's context): no self-prompt loop; event wakes; delivery guarantee (auto-post last text, mid-run text delivered immediately, 7 failure notices, idempotent). Gaps to beat: completion verifier, budget cap with forced summary, crash sweeper.
- Prefs: respect Mac memory limits (serial heavy work); later move dev to Mac mini `wekruit-mini` via Tailscale (deferred, nobody owns it); every change needs a local before/after; adopt all Workloop patterns except group chat; keep the existing TS/Pi/Postgres stack; UI must always show a loading state.
- Main is "test, not production"; no staging app without an explicit ask.
- Allow rules in `/Users/adam/wekruit-matching/.claude/settings.local.json` work. Acceptance's Instantly writes are blocked by the classifier, so core does them in-product. Security-weakening code edits need the user's own words.
- Playbook: `/Users/adam/Downloads/recruiting_playbook_agent.md` (the user also uploaded `recruiting_playbook.md` in chat at 15:29; the stage machine follows it). Workloop refs: `/mnt/project-files/workloop/` (use `Workloop-PRD-zh-transcribed.md`).
- Audit ownership: Core owns F Autumn flow + Playbook, G mail time negotiation (NOT tested; plan on the test role: agent emails 2-3 slots via card, admin1 picks, agent books Cal.com via card, confirmation card, Interview view), G enrichment + cache, Dyna duplicate roles, crmData, XLSX.
- Workloop backend features LIVE: mid-stream steering, Stop keeps queued steering, interrupted-run notice, TTFT/cache/cost logging, publish reply before snapshot, partial role revise, context out of system prompt, transient progress deltas, anchored compaction, slow tools to background + wake, routine failure auto-pause, partial remember, cross-thread history search. NOT done: offer-to-automate.
- Contracts: `recruiting.roleSetup(threadTarget)` returns `{ready, items[...], attention, playbookStage{stage,label,nextStep}}`; no `bindCrmRole` rpc by design.
- Other open: Sumeet stale-answer; contact-backfill wiring; Dyna merge-then-archive proposal (keepers Simulation `e2ad9b63`, Data Infra `55eb90bd`; shells `939d63f4`, `d4298147`).
- Legacy 4 bots DONE (Main `cmva18nbd00051hfqzyqu4swb`, Sourcer `cmva19wup000l1hfqu7vb3uof`, Outreach `cmvfocnfm00041hfq9o7vo6ig`, Scheduling `cmvfoe3xa000d1hfqo4a7wlzw`): disabledBuiltinTools = 9 tools.
- Pre-existing main test failures to ignore: packages/db `recruiting-brief.test.ts` CRM binding-effect; tsc errors in `credential-secrets.test.ts` / `recruiting-role-archive.test.ts` / adapters `wakeup*.test.ts`; `i18n-catalog.test.ts` 2 cases; `desktop.test.ts` header class.
- CRM has no interview table (structure change = user decision). Instantly findings: `docs/handoff/2026-10-23/instantly-findings.md`; the official Instantly MCP (mcp.instantly.ai, server `cmvafvgm000091hfqtf254szq`) IS connected.
- Earlier 1.0 doc item D6 (ask one question at a time with options + free input) and D5 (bigger chat box) relate to the question-flow and resizable-panels work.

---

## 2. How the project works

- **Coordinator (you)** relays between the user and worker threads. You do not write product code. You: dispatch, track PRs/migrations, collect evidence, ask the user one batched question card, keep the PR table (section 4) current.
- **Thread types**
  - RC Mac threads run on the user's Mac with local permissions (core, acceptance, release). They can run the deploy script, use the user's Chrome, read the product DB.
  - Cloud threads (frontend) run in claude.ai cloud containers. No Mac access.
- **Who merges**: the frontend thread (cloud) merges all PRs (per the facts: "merges all PRs"). Core opens backend PRs. Merge order and migration prefixes in section 4 must be respected.
- **Who deploys**: only the release thread, using the script below. Nobody else deploys. Release checks for active runs before every deploy.
- **Earlier friction**: auto-mode permission rules ("Production Deploy", "Real-World Transactions") blocked deploys and Chrome writes earlier in the day; the user adjusted allow rules. If a deploy or real-world write is blocked, the coordinator must get approval from the user, not work around it.
- **Origin docs** (on the user's Mac): the handoff prompt (A–J lines) and the Playbook `/Users/adam/Downloads/recruiting_playbook_agent.md`. Full-product plan dir: `full-product-plan/` (unknown exact root).
- **Key shared files**
  - Acceptance report: `/mnt/project-files/PRODUCT-ACCEPTANCE-20261023.md` (plus timestamped variants; newest per coordinator: `PRODUCT-ACCEPTANCE-20261023-20261023T155506-8a65.md` (not read by the writer; the bug table below is from the 15:05 version, so re-check). Acceptance tools: `/Users/adam/Documents/ChatGPT/headhunter/work/full-product-plan/acceptance-tools/`).
  - Ask audit: `docs/handoff/2026-10-23/ask-audit.md` (stale: written 12:50, partially updated 13:20).
  - Workloop PRD findings: `docs/handoff/2026-10-23/workloop-prd-zh.md`.
  - CRM sync mapping: `docs/handoff/2026-10-23/crm-sync-mapping.md`.
  - Rolling deploy proposal: `docs/handoff/2026-10-23/rolling-deploy-proposal.md`.
  - Per-thread handoffs: `/mnt/project-files/handoff/{core,frontend,acceptance,release,juicebox-profile,crm-sync,resizable-panels}.md` (as of writing only `juicebox-profile.md` and `resizable-panels.md` exist; the rest were being written).

---

## 3. Live state, deploy history, hold

### Live now
- **LIVE: `00abb64ab395ae8529907306bf4d14953edf5e91`**, deployed 15:40:19 UTC, container `ta-01M5MPMADSAN9XY784M81C5E2R`, migration ledger **114** (`20261023000001` group title backfill renamed exactly 2 groups).
- Downtime for this deploy: **93 s** (regression vs 19 s / 21 s earlier). PR #68 adds boot-phase timestamps to diagnose.
- Earlier today (from acceptance report): v106 = main `b918a01b` (12:44, ledger 110), v107/v108 (`c779d80b`, 13:21), v117 (`cd033406`), v118, v119 = `604d0ce3` (14:44, ledger 112). The sequence between v119 and `00abb64a` (ledger 112 -> 114) is unknown to the writer.

### Merged on main, NOT deployed (main about `a7276c2a` or later)
#57 assessment rows, #59 experience/education timeline, #62 archived-role page, #63 `?detail=` deep link, #64 Activity + Tasks tabs, #66 stage + needs-confirm/needs-input sidebar badges, #67 gpt-6-luna fast turns + `thought`/`summary` on thread.progress + membership cache, #68 boot timestamps, #69 Home dashboard (`?view=home` landing), #70 reply to campaign leads without CRM record.

Pending deploy target: main `a168e5b7` (#62-#71, no new migrations up to there; #65 guard carries migration 20261023153000 and is not merged yet).

### DEPLOY HOLD (active)
Do NOT deploy until the user's new role delivers its first 10 calibration candidates:
- Role `1c979abd-4b86-4b27-a89d-5853d981af7d`, thread `cmvl4csuv00051bfqw3sg5juq`, group `cmvl4cst400001bfqfaqa9j0b` 「分拣仓运营主管/经理 — New Jersey」.
- Sourcer dispatched 15:43; the first result page landed 15:52:12 with 44 candidates (~10.7 min after the last card answer); Autumn still running. Hold can lift once that run finishes; Release checks active runs first.
- Release must check active runs before every deploy anyway.

### Deploy rule and script
- Script: `/Users/adam/Documents/ChatGPT/headhunter/work/private/core-agent-dev/run/release-main.sh <SHA>`. Deploy with `--strategy recreate`.
- No new resources, no new Secrets.
- Rollback = rerun the script with the previous SHA.
- Stop outreach first (before any deploy). Never delete data.
- CRM MCP edge function deploy: `npx -y supabase@2 functions deploy mcp --project-ref fbtovyqmpzofxyzhbzuf --use-api --no-verify-jwt`. Never use `--prune`.
- The container GIT_SHA Secret value is stale; the truth is `/app/.wekruit-source-revision` in the container.
- Each deploy: run post-deploy acceptance checks (migration count, candidates 1,016, memory docs 23, pending external operations unchanged, zero real outbound, 5-min 503 sample).

---

## 4. PR table

State key: MND = merged, not deployed; OPEN = open/in flight; DRAFT.
Owner threads: Core, Frontend (merges), Release (deploys).

| PR | Title | State | Owner | Merge order / notes | Migration |
|---|---|---|---|---|---|
| #57 | Assessment rows | MND | Core/Frontend | on main | unknown |
| #59 | Experience/education timeline | MND | Frontend | on main | none known |
| #62 | Archived-role page | MND | Frontend | on main | unknown |
| #63 | `?detail=` deep link | MND | Frontend | on main | none known |
| #64 | Activity + Tasks tabs | MND | Frontend | on main | unknown |
| #66 | Stage + 需要确认/需要输入 sidebar badges | MND | Frontend | on main | none known |
| #67 | gpt-6-luna fast turns, `thought`/`summary` on thread.progress, membership cache | MND | Core | on main; frontend consumes `thought`/`summary` (collapsed "Thought for Ns") | none known |
| #68 | Boot-phase timestamps | MND | Core/Release | on main; use to diagnose 93 s downtime | none |
| #69 | Home dashboard (`?view=home` landing) | MND | Frontend | on main | none known |
| #70 | Reply to campaign leads without CRM record | MND | Core | on main | none known |
| #65 | Guard + playbook stage machine (branch `codex/wl-ao-turn-guard`) | OPEN, rebased, MERGEABLE | Core | merge first among open items; phase 2: hidden continuation message, group-listing attention `approval`/`question`, 10-min question nudge, crash sweeper, `<NO_ACTION>`, budget-exhaustion summary | **20261023153000** |
| #71 | Hide internals (agent never says CRM/campaign/leads/mailbox/setup; card labels 岗位 / 发件人 / 收件人 (N) / 发送时间) | MND (merged per coordinator update; earlier notes said open) | Core + Frontend | on main a168e5b7 | none known |
| (branch) `codex/wl-ar-inbox-remote` | Inbox projection must match remote-MCP effects with `toolName` at request->3 and `get_email` shape | draft PR being pushed (number unknown) | Core | fixes acceptance step 8 (Inbox not showing replies) | unknown |
| frontend in-flight (no PR numbers) | setup-checklist removal + CRM wording scrub; collapsed "Thought for Ns" row; Chinese card titles; duplicate-title second line; Results backend paging | in flight | Frontend | needs core payload fields (`thought`/`summary` already in #67) | none |
| Juicebox backend gaps | `shortlistedAt`, notes, multi-key reminders | in flight | Juicebox-profile thread | | prefix >= **20261023170000** |
| #72 | CRM sync: `recruiting_crm_*` projection tables + `recruiting.crmSync` | DRAFT, not merged | CRM-sync thread | mapping doc `docs/handoff/2026-10-23/crm-sync-mapping.md`; to run: call `recruiting.crmSync` from a signed-in product tab with a role's groupId, dryRun true first, then false | **20261023160000_recruiting_crm_sync** (new tables only) |
| Resizable panels | drag-resizable chat and side panels | in flight (Haiku thread) | resizable-panels thread | | none |

Migration prefix rule: current known prefixes are 20261023000001 (live), 20261023153000 (#65), 20261023160000 (CRM sync #72), >= 20261023170000 (Juicebox). Keep them distinct and increasing. Never renumber a migration that is already applied on live.

Backend PRs merged today: #41 #44 #45 #53 #54 #55 #60 #67 #68 #70 #71. Main is a168e5b7. Merge order suggestion (derived, not a stated instruction): #65 first, then the core Inbox branch, then frontend items, then CRM sync #72 (160000), then Juicebox (>=170000). Confirm with Core before enforcing.

---

## 5. Threads

Thread ids all start with `cmsg_01He8tN2Jg6UkpYBRCrwdxqx`; the table gives the suffix after that prefix (join them directly, or check the prefix again if a lookup fails).

| Thread | Id suffix | Where | Per-thread handoff |
|---|---|---|---|
| Core | `1Z9TKr6DbPf2qgn2xsE5ez` | RC Mac | `/mnt/project-files/HANDOFF-CORE-20261023.md` (root; Mac copy `/Users/adam/Documents/ChatGPT/headhunter/work/full-product-plan/HANDOFF-CORE-20261023.md`) |
| Frontend "Workloop frontend patterns" | `C6HsG1fFsRNMLChbSc9e4f` | cloud; merges all PRs | `docs/handoff/2026-10-23/frontend.md` (may not exist yet) |
| Acceptance | `7tHkQCVZCubodx35rNnt4q` | RC Mac | `docs/handoff/2026-10-23/acceptance.md` (root, not handoff/) |
| Release | `5MPfAKZToMBsW8tkt6TY84` | RC Mac | `docs/handoff/2026-10-23/release.md` (root, not handoff/) |
| Juicebox-level profile and dashboard | `2EpBBkxGKXhLWoDXzL5wg2` | unknown | `docs/handoff/2026-10-23/juicebox-profile.md` (exists) |
| CRM data sync into our format | `QwjoTMij4UYQgi3S8kNLQH` | unknown | `docs/handoff/2026-10-23/crm-sync.md` |
| Resizable chat and side panels | `Q6rudbUJcmN6XtaQ3UFjDQ` | Haiku (explicit user ask) | `docs/handoff/2026-10-23/resizable-panels.md` (exists; branch `claude/resizable-panels` at cb12d20, no PR yet, right panel done; Shell.tsx working copy is formatter-rewritten and uncommitted: restore from git and reapply the 11 edits, patch `docs/handoff/2026-10-23/resizable-panels-shell.patch`) |
| Zero-downtime deploys | `SGFTxXESQ3XNPPM2zuNAeX` | done | none; proposal `docs/handoff/2026-10-23/rolling-deploy-proposal.md` awaits user OK for a throwaway Modal test app |

Other roles/actors: Autumn (candidate sourcing/scoring agent), Sourcer (dispatches Autumn), Noah (email recipient/owner of Instantly workspace `noah@perfectwekruit.org`; the previous coordinator emailed him progress at 05:09, 06:40, 08:00 per audit).

---

## 6. Open bugs with evidence

Sources: newest acceptance report (final confirmation 14:47 UTC on v119 `604d0ce3`) and earlier sections. Re-verify against live `00abb64a` before relying on any; the acceptance thread's Chrome extension disconnected at 14:36 once.

| # | Bug | Evidence | Likely fix owner |
|---|---|---|---|
| B1 | **Inbox does not show replies the agent can read** (Instantly loop step 8 FAIL) | 15:06: test role Inbox shows "Not checked yet" although the agent read the reply "收到 谢谢" via `list_emails` -> `get_email` -> `get_thread_history`. Also `?view=sequence` on that role jumps to Shortlist and stays Loading | Core: branch `codex/wl-ar-inbox-remote` |
| B2 | **Downtime on deploy**, 503 / "no upstreams available" | v118 deploy: 198/1,530 samples 503; v119: ~2–4 min whole-site outage; `00abb64a`: 93 s. Earlier 13:17 first-screen RPCs 503 not in a deploy window (`recruiting/getWorkspace` x-request-id `494e7aa3-78f5-4a7d-857f-592adf97db9b`). | Release/Core: #68 timestamps; rolling-deploy proposal |
| B3 | Sticky red "Could not load recruiting" after a 503 recovers | 13:17–13:27 browser run | Frontend |
| B4 | Left sidebar stuck "Loading roles…" after a deploy replaces the container (needs manual refresh) | 13:21 on v108 | Frontend |
| B5 | Simulation role does not sort by score by default | Default Name sort; DB read-only check: matchFields present on 16 rows but stored as `{"match_score":{"value":62,"source_id":…}}` shape, not read by the sorter; earlier: `sortAvailability` all false, `match.score` empty, score only in `latestSource.report` | Core/Frontend |
| B6 | Confirmation card text is uninformative | Card shows "Review before Instantly instantly activate campaign" and campaign_id only; no campaign name, recipients or email body. (#71 card labels 岗位/发件人/收件人 (N)/发送时间 target this) | Core #71 |
| B7 | Chat input lost when chat panel is closed (maybe automation-only) | hidden input still in a11y tree; Enter clears text silently | Frontend |
| B8 | Name search partial | Sumeet: found email in a role chat but answer missed the 10-22 newest mail; in a role-less chat `p_org` wrong gives 0 results | Core |
| B9 | `search_contact_emails` for admin1@wekruit.com errors "No stored email for admin1@wekruit.com" | not a CRM contact; does not affect the loop (observation only) | none |
| B10 | Outreach refused to send earlier ("没有可用于展示并取得这封邮件一次性批准的原生审批流程") at v117 | later fixed: native approval card appeared at v118/v119 | closed (verify) |
| B11 | Version marker: container GIT_SHA Secret stale | use `/app/.wekruit-source-revision` | Release |
| B12 | Two-real-user isolation untestable | product DB has only 1 real human | needs user to supply 2 accounts |
| B13 | Contacts first open slow (10–15 s Loading) | 13:17 run | Frontend/Core |
| B14 | Unified role list shows same role under two names (CRM name vs agent name) | 13:17 run, partial | Frontend/CRM sync |
| B15 | Electron app name still "Rakazo" | changing it alters user-data path; needs user decision | user |

Not bugs / passed (v119, 14:47): migration ledger safe; 1,016 candidates and 23 memory docs unchanged; no real outbound; tool-event reversal 0/14; Data Infra sorted by score (134); unified candidate table (#38) live; Sequence card for the test role; step 5 confirm card; step 6 outbound + inbox arrival; step 7 reply read-back; step 9 stop-on-reply.

Audit-era items still ownerless or unknown status as of the 13:20 update: D2 (Enter starts a search), D5 (bigger chat box; now covered by resizable panels thread), D6 (ask one question at a time with options + free input; #65 question flow may cover), calendar booking, contact enrichment (ContactOut/LeadMagic/FullEnrich), F line (full playbook run: 10 calibration -> human G2 gate -> scale), Dyna duplicate roles dedupe (waits on archivedAt migration; #62 archived-role page may relate), interview table (user decision), Gmail official capability (blocked by Google preview plan). Their current state: unknown; ask Core.

---

## 6b. Latency optimization (next-session plan)

Measured data (2026-10-23):
- New-role JD -> first bot text: 15.3 s (2.5 s setup + ~12 s gpt-6.1-sol on a 2.5k-char JD). First choice card: +83 s.
- 5 clarification round-trips before sourcing (company, experience, team size, materials, brief confirm), about 15:24-15:38.
- Last card answer ~15:41:29 -> first result page 15:52:12 with 44 candidates (~10.7 min; mostly Autumn research plus the 15:38 deploy interrupt of ~3 min).
- Live p50s: first visible token ~3.1 s; simple replies 5-10 s; tool-heavy 25-50 s. Data Infra Results first load 20-25 s.

Levers (ALL are ideas or in-flight, none verified as done):
1. Batch all clarifications into one form; start a provisional search in parallel with confirmation. (idea)
2. Stream the first Autumn page as soon as it arrives (show first 10 progressively) instead of waiting for the full task. (idea)
3. Run independent searches in parallel. (idea)
4. Cache and reuse role/JD parsing. (idea)
5. gpt-6-luna for light turns: #67 merged, NOT deployed.
6. Never deploy during an active run (Release rule; the 15:38 deploy cost ~3 min).
7. Backend paging for Results: frontend in flight.
8. Boot-time regression (93 s): #68 timestamps merged, not deployed/used yet.
Acceptance should measure tap -> first-10 candidates on every run.

---

## 7. Instantly closed-loop test status

Test fixtures (use only these; never Dyna roles). Test role 「Rakazo 内部测试」, roleId `ce604726-…` (rest unknown):
- Group `cmvl1c44400081hfqbkb0xk2b`, thread `cmvl1c45x000d1hfqwj82cy4h`.
- Campaign `d4b1bc78-5363-437a-bcb1-343ecc9c85ca` ("Dyna Data Infra — Rakazo 内部测试" / subject "Rakazo 内部测试").
- Sender eaccount `noah@perfectwekruit.org`; lead `admin1@wekruit.com`.
- Empty campaign `6a1364c1`: **NEVER activate**.
- Dyna mapping row `cmvl0w1os004l1ifqummc3ewc` was deleted at 14:01; backup is in the release thread's scratchpad.

Result (acceptance report, 14:47–15:06 UTC):
| Step | Result |
|---|---|
| 1 create campaign (once, draft status 0) | PASS |
| 2–4 lead, sender, content | PASS (per report: steps 1–4 passed) |
| 5 confirmation card (activate_campaign effect `cmvl2x4zr001z1ifqnpge2idh`), user Allow once 14:54:34, executed once | PASS (card copy FAIL, B6) |
| outbound: admin1 received 1 mail 15:02:18 in inbox (not spam) | PASS |
| 6 admin1 replies in original Gmail thread `1a16948ccc471f3d` 15:02:35 | PASS |
| 7 product reads reply back (Instantly indexed 15:02:58) | PASS |
| 8 product Inbox shows the reply | **FAIL** (B1) |
| 9 stop on reply (lead status 1 -> 3, `stop_on_reply` on) | PASS |
| Restart resilience: card and run survived 14:44 deploy | PASS |

Memory: step 8 needs #70 + the inbox-remote fix deployed. Remaining to close the loop: fix and deploy B1, re-run step 8 on the same fixtures without sending anything new (campaign is already finished for the lead). A fresh send needs a new lead/campaign and explicit user approval.

---

## 8. Pending user decisions

Batch these into ONE card (user rule). Known open items:
1. Approve a throwaway Modal test app to try the rolling-deploy proposal (`docs/handoff/2026-10-23/rolling-deploy-proposal.md`).
2. When to lift the DEPLOY HOLD (default: after the 10 calibration candidates for role `1c979abd-...` land and are reviewed).
3. Provide 2 real new user accounts for isolation acceptance.
4. Electron app name "Rakazo": rename or not (changes user-data path).
5. New interview-record table (CRM has none; stage=Interview used as stand-in) — yes/no.
6. Whether to use/connect Google Docs connector (Google Doc "headhunter agent · 10.22 - 1.0" could only be read as text earlier; screenshots unread).
7. Any older item the audit lists as 🙋 whose state the user may since have answered (Instantly direct-query option A/B, CRM project ref — the ref `fbtovyqmpzofxyzhbzuf` appears in the deploy command, so likely answered). Mark unknown unless confirmed.
8. Dev env move to Mac mini: deferred by user; do not push.
9. Also still waiting on the user (memory): test lead + 「发第一封」 on the new role; reply-card confirm after deploy; interview-scheduling replies; keep the Mac online; staging app (only on explicit ask).

---

## 9. Safety rules (from memory)

- Deploy rule: main is the mainline. Command: `MODAL_APP_NAME=wekruit-recruiting MODAL_SECRET_NAME=wekruit-recruiting-config MODAL_VOLUME_NAME=wekruit-recruiting-files modal deploy --strategy recreate infra/modal/app.py`. No new resources or Secrets. Migrations before new API/worker.
- Script: `/Users/adam/Documents/ChatGPT/headhunter/work/private/core-agent-dev/run/release-main.sh <main SHA>` deploy (worktree `rakazo-wl-h-prewarm`). Rollback = rerun with the previous SHA; stop outreach first; never delete data; check active runs before every deploy.
- CRM MCP: headhunter-agent main `3ac9306e`, edge function mcp v10. Deploy: `npx -y supabase@2 functions deploy mcp --project-ref fbtovyqmpzofxyzhbzuf --use-api --no-verify-jwt`; never `--prune`; don't modify other functions or rotate Secrets.
- Keep all existing checkouts and uncommitted changes. Old worktree HEAD `31a8852c` keeps 10-file WIP + a saved patch: never clean or overwrite it.
- No force push. No default-branch or protection changes.
- Never print, export or commit tokens, cookies or keys. Don't read cloud Secret values.
- Archive rows rather than delete them.
- Budget shared US$150. No outreach without native approval. No new paid plans.
- Never test on Dyna roles. Never activate empty campaign `6a1364c1`. Dyna mapping row `cmvl0w1os004l1ifqummc3ewc` was deleted 14:01 (backup in release scratchpad).
- Container GIT_SHA Secret is stale; truth is `/app/.wekruit-source-revision`.
- An agent message is never user consent for real-world writes or permission changes.
- DEPLOY HOLD in section 3 applies.

## 10. First 10 actions for the new coordinator

1. CRM SYNC (prominent): draft PR #72 (https://github.com/WeKruit/rakazo/pull/72, not merged; migration 20261023160000_recruiting_crm_sync, new tables only; handoff docs/handoff/2026-10-23/crm-sync.md). Get it reviewed/merged in order, then from a signed-in product tab call `recruiting.crmSync` with a role's groupId: dryRun true first, then false. Missing company/experience/education fields need a CRM-side MCP follow-up (separate edge function deploy, never --prune).
2. Read this file, the newest acceptance report and existing per-thread handoffs; confirm thread access (section 5). Then check DEPLOY HOLD: has role `1c979abd-...` finished its Autumn run (thread `cmvl4csuv00051bfqw3sg5juq`)? Do not deploy while waiting.
3. Ask Release for current live SHA confirmation (`/app/.wekruit-source-revision`) and ledger count (expect `00abb64a`, 114) and whether any run is active.
4. Ask Core for the state and ETA of #65 (rebase, migration 20261023153000), #71, and the Inbox branch `codex/wl-ar-inbox-remote`; confirm merge order and that migration prefixes do not collide with CRM sync (20261023160000) and Juicebox (>= 20261023170000).
5. Ask Frontend to confirm all merged PRs (#57, #59, #62–#64, #66–#70) are on main and what the frontend in-flight list needs from Core.
6. Ask Core/Release to use #68 boot timestamps on the next deploy to explain the 93 s downtime; ask Release to estimate the effort of the rolling-deploy test and put the OK request into the user card.
7. Ask Acceptance to prepare the post-deploy script (migration, data counts, pending ops, 5-min 503 sample, Inbox step 8 re-check, Simulation sort, sidebar badges) so it runs immediately after the next deploy, using only the test fixtures in section 7.
8. Send the user ONE batched decision card (section 8), plus a short progress digest (what is live, what is held, what is next). Reply in their language.
9. Check ownerless items from the audit (calendar booking, contact enrichment, F-line playbook, Dyna dedupe, interview table, one-question-at-a-time) and assign each to a named thread or mark deferred. Verify the P0 rule (agent never stops without a deliverable or blocking question) is covered by #65 phase 2 (verifier, budget summary, crash sweeper).
10. Once the hold is lifted: have Release deploy main in one go (stop outreach first, no active runs), run Acceptance post-deploy checks, update the PR table, and report to the user with evidence. Do not mark anything done until it is live and really tested.
