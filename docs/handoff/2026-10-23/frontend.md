# Frontend (line E) handoff: "Workloop frontend patterns"

Paste this whole file as the first prompt of the next frontend session. It is self-contained.
Overall project handoff: `docs/handoff/2026-10-23/00-OVERALL-HANDOFF.md`.

## Your role
- You own **line E**: the unified recruiting frontend in the public repo `WeKruit/rakazo` (web + Electron, which hosts the web UI).
- You **merge every PR**, including Core's and other threads': merge commits only (`merge_method: "merge"`). Set `draft:false` before merging. **Do not wait for CI**: run focused local checks, then merge.
- After each merge, tell the coordinator the new main SHA (`message_coordinator`). Release thread deploys only on coordinator "go".
- Reply to the user in Chinese (they write Chinese and English; match the latest message). Keep replies short, results first.
- Never rewrite history on someone else's branch. Never force push. Never `reset --hard`. Never drop someone else's WIP.

## Current state (2026-10-23 ~16:05 UTC)
- **main = `0aea24c2`** (merge of #65). Order today: #71 → a168e5b7, #75 → 5dcdd489, #73 → 729e7f20, #65 → 0aea24c2.
- **Live (deployed)**: `162b6ea2` (#51), deployed 15:18 UTC. Everything after it is merged but NOT deployed.
- **Merged, not deployed** (#52–#75 that are on main): #52 sort persist + `?detail=` sync, #53 Inbox projection + 「确认回复」 card, #54 HubSpot memo + activeSince/resumedAt, #55 reminders (migration 20261023000000), #56 steer/resume indicators, #57 assessment rows, #59 experience/education, #60, #61 needsInput sidebar, #62 archived-role page, #63 `?detail=` deep link, #64 Activity + Tasks tabs, #66 stage + attention badges, #67 luna fast turns + `thought`/`summary`, #68 boot timestamps, #69 Home dashboard, #70 reply to leads without CRM record, #71 hide internals + card labels, #73 remote-MCP Inbox reads, #75 setup-checklist removal + CRM wording scrub, **#65 playbook stage machine + turn-end auto-continue (migration `20261023153000_recruiting_role_playbook_stage`, env `RAKAZO_AUTOCONTINUE_MAX` default 3)**.
- Next deploy target: `0aea24c2` or later. Migrations before API/worker. Tell the coordinator.

## Open PRs and merge order
1. **#72** CRM sync (draft, CRM-sync thread; migration 20261023160000, new tables only). Handoff `docs/handoff/2026-10-23/crm-sync.md`. Merge when that thread or the coordinator says it is ready; it has passing Postgres tests. Must merge before #74 (migration order).
2. **#74** Juicebox notes / shortlistedAt / multi-key reminders (draft, WIP; migrations 20261023170000 + 171000). **Do not merge** until its "Not done" list is cleared (Postgres tests, apps/api recruiting.test failures). Handoff `docs/handoff/2026-10-23/juicebox-profile.md`.
3. **Resizable panels** (Haiku thread), branch `claude/resizable-panels`. No open PR was visible at 16:05. Shell.tsx edits are uncommitted per `docs/handoff/2026-10-23/resizable-panels.md`. When a PR appears, merge it after checking Shell.tsx was NOT reformatted by biome (diff should be small).
4. Migration prefixes must stay distinct and increasing: 20261023000000 (#55), 20261023153000 (#65), 20261023160000 (#72), ≥20261023170000 (#74). Never renumber an applied migration.

## Pending frontend work (in priority order, rough ETAs for one session)
1. **Collapsed chain of thought** (~45 min). Core #67 emits `thought` (≤200 chars) on `thread.progress` and blocks with `phase:"thinking"` + `summary` (≤80). Today `reduceLiveMessageBlocks` in `packages/core/src/events.ts` keeps only text/activity/pendingToolNames/compacting, so the UI shows generic labels. Keep `summary`/`thought` there, then in `apps/web/src/components/LiveWork.tsx` render the latest line live and, when done, one collapsed "Thought for Ns" row (Workloop style) that expands to the lines. User explicitly asked for this.
2. **Hide auto-continue messages** (~30 min). #65 injects a visible user message 「继续下一步：…」 with `trigger:"follow_up"` and clientNonce `autocontinue:<runId>:<n>`. Until Core makes it hidden, render it in the transcript as a small system line, not a user bubble. Check `packages/core/src/message-visibility.ts`.
3. **Chinese titles for every approval card** (~30 min). Outbound titles are done (#51: 确认发送首封邮件 / 确认回复 / 确认预约面试 …, `packages/adapters/src/approval-ask.ts` `OUTBOUND_TITLES`, translated in `apps/web/src/components/AskCard.tsx approvalTitle`). Still English or internal: "Confirm requirements" → 确认岗位要求, "Approve documents", "Approve calibration", any "Review CRM …" title. Grep AskCard and approval-ask for remaining titles.
4. **Activation card labels** (~20 min): match #71's payload labels 岗位 / 发件人 / 收件人 (N) / 发送时间 in the card UI (payload `{campaignName, mailbox, recipients[], recipientCount, stopOnReply, schedule?}`).
5. **Duplicate role titles** (~20 min): in `apps/web/src/pages/shell/RecruitingNavigation.tsx`, when two roles share a title, show a muted second line (created date or stage label).
6. **Results first page speed** (~60 min): `useRoleCandidates` reads everything client-side; Data Infra (134) takes 20–25 s. Switch to backend `recruiting.roleCandidates` with paging/cursor and a skeleton.
7. "Sudden refresh while Working": diagnosed as the vite preload-recovery reload after a deploy (`apps/web/src/lib/preload-recovery.ts`), not a run-end reload. Make it wait until no run is active (or show a "new version" toast) instead of reloading mid-run.

## File ownership
- **Juicebox thread**: `apps/web/src/pages/recruiting/DetailPanel.tsx` contact body, `profile.ts`, AssessmentCard, ProfileTimeline, Activity/Tasks/Notes tabs, Home dashboard files. Coordinate before editing.
- **Haiku resize thread**: pane resize in Shell.tsx layout, `PaneResizeHandle.tsx`, `pane-width.ts`, `ResizableSidePanel.tsx`.
- **Core**: `packages/adapters/**` (executor, turn-end-guard, approval-ask), `apps/api/src/recruiting.ts`, db.
- **E (you)**: everything else in `apps/web` (Shell.tsx, RecruitingPanel.tsx, recruiting tabs, RecruitingNavigation, LiveWork, AskCard, RoleSetup), shared UI.

## UI rules (user's own rules)
- **Vendor-free**: never show Instantly, Cal.com, Gmail, HubSpot, Composio etc. in chat, cards or emails. Connector card is the only exception.
- **No internals**: no CRM, campaign, leads, mailbox, setup, task/artifact IDs, tool names or JSON in recruiter UI. Use 联系人 / 候选人进展 / 岗位阶段. Diagnostics only in deployment-owner developer view.
- Card titles in plain Chinese describing the decision: 「确认发送首封邮件」「确认回复」「确认预约面试」. Never "confirm G0".
- Always show a loading state (skeleton + retry). Chat open by default and auto-open on a pending card. No sudden page refresh while Working.
- Sidebar must separate needs-input / unread / read (done in #61/#66: badges 需要确认 / 需要输入, bold + dot for unread).
- Minimal copy; PRs that add copy must quote it and justify it. Monochrome UI tokens from `@rakazo/ui-tokens`; shadcn components in `packages/ui-web`.
- "UI太一般": target Juicebox/Metix polish.

## Contracts on main
- `Group.needsInput?: boolean`, `Group.attention?: "approval"|"question"|null`.
- `recruiting.roleSetup(threadTarget)` → `{ready, items[], attention:{kind:"approval",threadId,cardId,createdAt}|null, playbookStage?:{stage, label, nextStep}}`. Stages: intake | calibration_10 | feedback | scale | enrichment | outreach | replies | screening | submission | interview | closed. Since #75 the UI shows **only** the stage line (`RoleSetup.tsx`); setup items are not rendered.
- `thread.progress` payload = `RunTimingSchema {activeSince, resumedAt}` + `thought?` (≤200). Blocks may carry `phase:"thinking"`, `summary` (≤80).
- Steering: `threads.send({interrupt:true})`; events `run.steering.claimed {steeringIds, nextMessageSeq}`, `run.requeued {status}`.
- Reminders: `recruiting.reminders.list/create/update/delete` (spaceId + ownerUserId scoped). #74 would add `candidateKeys[]` and notes.
- Detail drawer: `recruiting/detail.ts` `pending` + `restore()`, PENDING_DETAIL_MS 20 s, `?detail=` synced to stack top.
- Saved panel state: `RecruitingPanelState.userSort`; stored sort without it resets to score.

## How to work
- Worktree with real `pnpm install`; run `npx prisma generate` after pulling migrations.
- Typecheck `npx tsc --noEmit -p apps/web` (and apps/api, packages/db when touched). Tests: `npx vitest run <files>` from the repo root.
- i18n: `cd apps/web && npx lingui extract --clean`, then fill zh-CN `msgstr`. On locale merge conflicts: `git checkout --theirs apps/web/src/locales`, re-extract, refill.
- **Never run `biome --write` on Shell.tsx** (it reformats the whole file).
- Do not run the desktop Playwright e2e locally; CI runs it.
- Known failures on main (not yours): `apps/web/src/lib/i18n-catalog.test.ts` (2), `desktop.test.ts` "keeps conversation header controls clickable", flaky RecruitingPanel "drops cached Artifact metadata when its exact reference changes"; `apps/api/src/recruiting.test.ts` 5 cases; `packages/db/src/recruiting-brief.test.ts` 2 (crmBindingReceipt); tsc errors in credential-secrets / recruiting-role-archive / adapters wakeup tests.

## Security constraints (verbatim from the user's handoff)
- 不能导出cookie/OAuth/key到prompt、截图、公共repo或交接正文。不能轮换加密密钥来"修登录"…不能复制管理员私人OAuth给新用户。
- 不reset --hard、不强推、不丢别人WIP。
- 真正外发、外部邀请、预约及其他对外承诺保留精确原生确认。
- 不打印、导出或提交 token、Cookie、密钥，不读取云端 Secret 的值。
- 不新建云资源或 Modal Secret，不强推，不修改默认分支或保护规则。
- Public repo: no secrets, emails, local paths, account IDs or customer data in commits, PRs or comments.

## Thread map
Core "Core Agent optimization workstream" (Mac RC, backend + integrator), Frontend "Workloop frontend patterns" (this one, cloud, merges), "Product acceptance testing" (Mac RC), "Release main to production" (Mac RC, deploys), "Audit of all asks against the plan doc" (cloud), "Zero-downtime deploys" (cloud), "Juicebox-level profile and dashboard" (cloud, #74), Haiku "Resizable panels" (cloud), CRM sync (cloud, #72). Cloud threads cannot message Mac threads directly; the coordinator relays.
