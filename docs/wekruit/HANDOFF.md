# WeKruit Headhunter: product handoff

Snapshot: 2026-10-23 UTC. This records a stopped work session, not product completion. Read the latest Git refs and deployment receipt before using any version below.

## Source of truth and principles

- Repository: https://github.com/WeKruit/rakazo. All further integration and release targets are `main`.
- Read `AGENTS.md`, `docs/wekruit/GOAL.md`, `PLAN.md`, `PRODUCT-SCOPE.md`, `RECRUITING-DOMAIN-PLAN.md`, and `infra/modal/README.md` first. The full confirmed Playbook v1.0 is required; do not reconstruct missing source text from summaries.
- Complete M1–M5. P6 is only the first milestone. Reuse Rakazo/Pi for sessions, tools, memory, delegation, questions, approvals, files and recovery. Autumn owns research, matching and assessment.
- Ordinary users talk to one assistant. Each role has one conversation; specialist details and internal identifiers belong in the developer view. Shared product skills and platform services must retain actual user/Space isolation.
- Internal searches, storage, drafts and delegation are autonomous. Actual external sends/invitations retain native precise confirmation. Do not request a desktop login as a substitute for a connected service.
- The cumulative incremental budget remains US$150; it does not restart with this handoff. No Docker, Slack, new harness, new subscriptions or changes to the legacy CRM schema.

## Verified Git state

| Delivery | State at this snapshot |
| --- | --- |
| Product PR #1 | Merged into `main` as `478572d6e191e02667bda21ef7875a89783cf4a6` |
| Frontend PR #3 | Rebased and merged as `09f8c0283855b0f83e522c646577b7317f3a7991`; web/mobile now share `packages/core/src/thread-reducer.ts` |
| Workloop PR #4 | Merged as `356987cf68e99a12f208cb63b2cf729b549a246d`, containing workloop source `67cb77252d6567e93a1cf6344718f6aca105f396` |
| Core latency PR #2 | Still open, now targeting `main`; inspect its relationship to already integrated core work before replaying it |
| Additional product changes | On `codex/recruiting-workspace`, targeting `main`; `71d68e3d33edbd4fdc8a4406d08eba4d6728fad7` unifies roles and native chat context; `9700d8ca4d2001d90077f75aee770a9dd1716ccf` adds managed recruiting tool restrictions |
| Integration checkpoint | `codex/main-workloop-integration` at the same `67cb7725`; no additional runtime fixes were implemented there |

The latest independently verified deployment from this session is `94cff4c6605e3e11d3ada6db6e6966bbf9c42247`. This session did not deploy the subsequent `main` changes. A merge, branch target or local test is not deployment evidence. Recheck the live source and ready state, including activity by other maintainers.

The topic branch preserves the completed product slice rather than overwriting concurrent frontend/core work. Expect overlapping Shell and event-contract hunks when bringing it onto current `main`; do not copy entire files over the shared reducer or newer workloop code.

## Completed additional changes and implementation checks

### Unified roles and conversation context

The 19-file slice removes the separate legacy-role navigation experience. It reuses canonical CRM role identity and the existing native group creation lock/event, with a blank conversation before first use. First send performs an authorized fresh role read. The UI locator never replaces business authorization or a provider receipt.

Same-nonce retries, actor/Space/role switches, attachment draft isolation, rename/get projection and current connection revision are covered. Source-bound roles retain their original business proof; invalid proof is not silently rebound.

Reported implementation checks include the full Shell suite, six focused backend suites, production types and formatting. Independent review reproduced two projection/isolation defects, the author fixed them, and seven targeted checks passed. These are offline checks; live database, multi-user and business acceptance remain outstanding.

### Managed recruiting tool restrictions

The three-file change reuses `Bot.disabledBuiltinTools` during fresh installation and idempotent managed upgrades. It appends, rather than replaces, restrictions; private instructions, models and grants remain intact. Existing unmanaged/legacy agents are not silently adopted.

Disabled tools: `computer_observe`, `computer_act`, `browser_navigate`, `browser_snapshot`, `browser_act`, `open_path`, `launch_app`, `request_takeover`, `request_secret`. File tools, shell and authorized service MCPs remain separate capabilities. `request_secret` is included because its existing schema can request website passwords.

Bootstrap checks passed 42/42, an existing native direct-call refusal check passed, and API types/format checks passed. **This has not been deployed or applied to existing unmanaged production agents.** Existing active attempts capture the earlier tool policy; a config update is not proof of immediate interruption.

## Highest-priority unresolved work

1. **Hard boundary for takeover events.** Pi and scripted runtimes can emit a takeover event directly. The executor consumer must check the existing disabled-tool set before preparing a computer, acquiring its lease or publishing a Needs you card. The ordinary tool-list/direct-call guard alone is insufficient. No such executor fix was implemented in this stopped session.
2. **Ordered activity completion.** Pi queues tool start but completion can bypass that FIFO and be persisted first. Use the existing FIFO and common durable sink, with the existing execution ID. The shared reducer must retain completed IDs so late start does not reopen activity and completing A does not clear concurrent B. Two minimal in-memory event sequences reproduced these existing defects; the fixes remain unimplemented. Edit the shared reducer, not a second web-only reducer.
3. **Instantly loop.** MCP reads and assigned account/history tools succeeded. The internal seed was sent once through a separate mailbox; no Instantly reply or booking was completed. Correctly scoped contact queries returned empty, which is not a permission failure and does not establish that all non-lead mail is absent. Check the authorized workspace's non-campaign-mail capture and the provider's `lead` filter semantics. The public MCP/API does not expose the non-Instantly-mail preference. Never ask the product user to open a desktop mailbox to retrieve a message.
4. **Intermittent candidate load.** A user reported Could not load candidates. One controlled reload subsequently displayed the saved pool. No matching fresh failed request ID/root cause was captured, so this is recovery, not a demonstrated fix. Older deployment-startup 503s cannot explain a later screenshot without correlation.
5. **Remaining acceptance.** Complete both real-role playbook flows, exact send/read-back and interview loop, two fresh users with private data isolation, all card/restart recovery, routine collaboration/memory, high availability and separate PeopleSearchBench comparison. Do not claim these from unit checks or an administrator account.

Detailed private evidence and account-specific login/resource information are in the deployment owner's private handoff. No credentials or private business records belong in this public document.

## Next maintainer: start and release

```sh
git clone --branch main https://github.com/WeKruit/rakazo.git
cd rakazo
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile
pnpm db:generate
```

Use Node 24 and the existing authorized cloud configuration. Follow `.env.example` and the Modal README; never assume a local environment file contains every live connector credential. Credentials remain in the existing encrypted cloud Secret/native connection store. Personal mailbox/calendar authorization remains account-specific. Do not copy administrator OAuth or history to new users.

Finish the pending product merge on current `main`, run checks for actual overlapping hunks, then freeze an exact `main` commit for deployment. Reuse the existing Modal app, Secret and Volume. Do not deploy a dirty worktree or the older selected-release branch. Keep exact source/archive verification, active-run and native-card preservation, ready checks and a compatible rollback.

The existing deployment is a single writer with a recreate/startup window, not verified high availability. Do not interrupt active or uncertain effects, rewrite historical receipts, clear old cards, or recreate uncertain sends.

**Migration boundary:** current `main` also contains the not-yet-verified-on-live `20261019000000_recruiting_candidate_consideration` application migration, adding nullable `consideration JSONB`. New reads depend on the column. Apply the reviewed application migration before new API/worker reads; it is not a legacy CRM migration. Do not reuse an old no-migration or whole-row-hash baseline: verify the old fields remain unchanged and explain the new null field. Once role-local hold/pass data exists, older code that ignores it is not a safe outbound rollback; never drop the column or clear decisions to manufacture compatibility.

The prior session is stopped. Continuing work, runtime configuration and live acceptance belong to the receiving session; this document does not report them as done.
