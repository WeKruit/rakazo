# Core-session handoff — WeKruit Headhunter (Rakazo) — 2026-10-23 16:00 UTC

You are the main integrator of the WeKruit Headhunter recruiting-agent product (Rakazo monorepo). Mainline = `main`; everything targets main and deploys from main. Frontend thread owns the web UI (`apps/web`, PRs `claude/e-*`), the release thread deploys, the acceptance thread verifies live and reads prod DB. You own backend/runtime (`packages/*`, `apps/api`, `apps/worker`, `infra/modal`), integration order, and live closed-loop proof.

## Standing rules (user-stated today, verbatim intent)
- 不等用户、不等 CI：reversible work (branches, PRs, test-role actions as admin1) just do it and report. Only three things go to the user: clicking merge (frontend thread merges), running deploy (release thread), and real outbound-send confirmation cards.
- 「一个岗位开箱即用」: a new role needs zero manual rows; campaign/mailbox/CRM setup is silent.
- Never expose vendors or internals to the user: no Instantly / Cal.com / Gmail / MCP / CRM / campaign / leads / mailbox / setup words in chat, cards or emails. Recruiter language only (候选人, 联系人, 邮件, 第一封邮件, 回复, 面试). Connect-request card is the one exception.
- Agent must never stop without a deliverable or a blocking question; push open questions actively; batch clarifications; the sidebar shows 需要输入 / 需要确认.
- Playbook is the stage machine (`/Users/adam/Downloads/recruiting_playbook_agent.md` v1.0, H23: calibration = exactly 10 profiles, approved before scale).
- Our own dev agents: basic tasks on Sonnet, design-heavy on Opus. Product agent model is NOT to be changed (it runs openai-codex: gpt-6.1-sol for Main, gpt-6-luna otherwise; PR #67 routes light turns to luna).
- Deploys: only via the release thread, `--strategy recreate`, batched; never recreate while a user run is active; fresh migration timestamp prefix (≥ 20261023160000), never reuse 20261023000000/1.
- Never read/print/commit secrets; never read `work/private/agent-runtime.env`; never touch worktree `ui-routines-release-worktree` (31a8852c, 10 uncommitted WIP files); never `git stash` across worktrees (compare via `git worktree add`); no production writes by you (release/acceptance do guarded data ops).
- Do not test outbound mail on Dyna roles; use the internal test role 「Rakazo 内部测试」.

## Paths (Adam's Mac)
- Repo worktrees: `/Users/adam/Documents/ChatGPT/headhunter/work/rakazo-wl-*` (one per line; `rakazo-wl-af-score-domain` is a clean checkout of main to branch from: `git -C … worktree add -b codex/<name> …/rakazo-wl-<name> origin/main`).
- Node: prepend `/Users/adam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`; `pnpm install --frozen-lockfile`; `(cd packages/db && pnpm exec prisma generate)`; run vitest from repo root `pnpm exec vitest run <paths>`; biome `pnpm exec biome check <files>`.
- Private scripts: `/Users/adam/Documents/ChatGPT/headhunter/work/private/core-agent-dev/run/release-main.sh <sha> deploy` (release thread runs it), `run/prod-numbers.py <since> <label> [isoLowerBound]` (latency from Modal logs), `run/smoke-merged.sh`.
- Modal CLI: `/Users/adam/Documents/ChatGPT/headhunter/work/private/modal-deploy-venv/bin/modal` (`app logs wekruit-recruiting --since 15m`, `container list`, `container exec <ta-…> -- sh -c '…'`). Container env `INSTANTLY_API_KEY` is stale (401) — the product uses the connector's stored credential; do not read it.
- Live app: https://wekruit-livekit-agents--wekruit-recruiting-recruiting.us-east.modal.direct/app ; test role chat 「Rakazo 内部测试」 = `/app/g/cmvl1c44400081hfqbkb0xk2b` ; new role 分拣仓运营主管 = `/app/g/cmvl4cst400001bfqfaqa9j0b`. If a link 404s, open the role from the sidebar.
- Kanban: `/Users/adam/Documents/ChatGPT/headhunter/work/full-product-plan/CORE-WORKSTREAM-STATUS.md`. Memory: `/Users/adam/.claude/projects/-Users-adam-wekruit-matching/memory/rakazo-core-agent-workstream.md`.
- The user drives the same Chrome tab you use (Claude in Chrome tab 693279856). Read page text only; do not navigate while they work.

## Live state
- Last confirmed RELEASE OK: main **00abb64a** at 15:40 UTC (container ta-01M5MPMADSAN9XY784M81C5E2R, migration ledger 114). main HEAD at handoff: **a168e5b7** (#71 merged) — ask release whether a newer deploy happened. Downtime regressed to 93 s on that deploy with no attributable logs → PR #68 adds boot-phase timestamps; next deploy tells.
- Latency on 604d0ce3 (14:43–15:09): threads.send p50 0.61 s; run setup p50 2.2 s; first token after setup p50 0.89 s (cache hit 0.95); threads.get p50 0.37 s; listCandidates p50 0.41 s; crmData p50 1.8 s. New-role JD (2.5k chars) → first bot text 15.3 s.
- Instantly loop on test role 「Rakazo 内部测试」 (campaign d4b1bc78-5363-437a-bcb1-343ecc9c85ca, 1 lead admin1@wekruit.com, sender noah@perfectwekruit.org): steps 1–7 and 9 PASS (activation card → user confirmed → mail delivered 15:02 → admin1 replied 「收到 谢谢」 → agent read it live → lead status 3, follow-ups stopped). Step 8 (agent replies 「收到，谢谢。」 via confirmation card) was blocked by the reply receipt chain requiring a CRM candidate → fixed in #70 (merged, not yet deployed as of 15:55). Role Inbox still shows "Not checked yet": remote-MCP read effects (route at request->3, get_email shape) are not projected → PR codex/wl-ar-inbox-remote (see below). The official Instantly MCP IS connected (server cmvafvgm000091hfqtf254szq, slug instantly); native tools `native_instantly_*` also exist.
- Fresh-role proof (分拣仓运营主管/经理 — New Jersey, group cmvl4cst400001bfqfaqa9j0b): title propagated to sidebar (#44), setup checklist rendered and mailbox auto-picked (#45), 4 clarifying questions + brief confirmation (code gate `requireRecruitingBriefConfirmation` in packages/core/src/recruiting-playbook.ts) → Main handed off to Sourcer at 15:43 → calibration research dispatched (ETA given 9:15 PT). Verify the 10-profile list landed and the feedback loop works.

## PRs (today, backend) — merge order for anything still open
Merged today: #41 score domain, #44 group title, #45 out-of-box role (roleSetup rpc, zero-arg ensure/activate, default mailbox, attention), #53 native reply tool + vendor-free cards + native-read Inbox projection, #54 discovery negative cache + activeSince/resumedAt, #55 reminders table/RPCs/tool, #60 playbook continuation + ETA rule + group-title backfill migration, #67 luna fast turns + `thought` lines + membership cache, #68 boot timestamps, #70 reply via campaign lead without CRM, #71 hide internals (CRM/campaign/leads words).
Open:
1. **#65** `codex/wl-ao-turn-guard` — playbook stage machine (`RecruitingRole.playbookStage`, migration 20261023153000) + turn-end auto-continue guard (`packages/adapters/src/turn-end-guard.ts`, `packages/core/src/recruiting-playbook.ts` classifyTurnEnd/nextPlaybookStep), roleSetup.playbookStage {stage,label,nextStep}. @fcec9e68, rebased on main a168e5b7, MERGEABLE/CLEAN. Phase 1 complete; phase 2 NOT started, exact next steps (file+function) in the PR body: hide the injected continuation message (renders as a user message today), group-listing `attention`, 10-min pending-question nudge, crash sweeper, `<NO_ACTION>`, budget-exhaustion summary. Env `RAKAZO_AUTOCONTINUE_MAX` (default 3).
2. **#73** `codex/wl-ar-inbox-remote` @fdcfd587 — Inbox projection for remote-MCP effects. Root cause: catalog-form effects (route at request[3], id `mcp__instantly__list_emails`) were not accepted by `correspondenceCall`; unscoped list_emails dropped; campaign-less list key threw; strict Email schema rejected the live get_email shape. All four fixed + prod-shape test (257 pass). Merge after #70 (already merged). Evidence: acceptance query 15:49 (3 completed effects in thread cmvl1c45x000d1hfqwj82cy4h, none projected).
3. Pre-existing failing tests on main (not from today): packages/db recruiting-brief.test.ts "CRM binding binding-effect" ×2 (missing externalEffect mock), executor-recent-turn-images ×3, tsc errors in credential-secrets.test.ts / recruiting-role-archive.test.ts / adapters wakeup*.test.ts. Also apps/api recruiting "saved recruiting correspondence" ×3 and "live CRM browser reads" ×2.

## Open bugs / next steps (priority)
1. Deploy batch (#65 + inbox-remote) via release, after the new role's calibration result has landed. Then re-run step 8 in the test chat: 「请在 Adam 的回复线程里回复「收到，谢谢。」，调用回复工具后会出现确认卡」 → 「确认回复」 card → user confirms → check role Inbox shows both mails.
2. Watch the new role: 10 profiles delivered? feedback loop (S4) → scale (S5). If the agent stops without a deliverable after #65 is live, read `run.autocontinue` logs.
3. Guard phase 2 items (above) — the user called "never stop / actively inform" THE most critical issue.
4. Interview scheduling by email (line G) not e2e tested: Cal.com is connected (get_bookings effect 10-22); flow = agent emails 2–3 slots (card) → candidate picks → agent books (card) → confirmation email (card) → Interview view shows booking. Run on the test role.
5. Offer-to-automate (agent proposes a routine after a repeated manual task) — user wants it; not started. Artifact spill — user said skip.
6. HubSpot server fails discovery every run ("Error POSTing to endpoint") — memoised by #54; decide whether to disable the server row.
7. Frontend asks still open on our side: none pending; they have roleSetup.attention / playbookStage / group `attention` (phase 2) contracts.

## Pending user decisions
- None blocking. User owns: clicking Confirm on real send cards; merge clicks happen in the frontend thread.

## Coordination
- Coordinator session id for `send_message`: `session_01FzskKPVojbhfaxy84gUwJt` (visibility `sent_to_shared_agent`). Report in ≤10 lines, evidence first; the coordinator relays to frontend/release/acceptance threads.
- Status cadence: 30 min. Keep CORE-WORKSTREAM-STATUS.md current.
