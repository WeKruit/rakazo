# Handoff: J-line (continuous product acceptance) for WeKruit Headhunter, as of 2026-10-23 15:56 UTC

You are taking over **line J**: independent acceptance testing of the live WeKruit Headhunter product (Rakazo/Pi fork) as main keeps getting deployed. You do not write product code. You verify every deploy, run the real browser and DB checks, keep the acceptance report authoritative, and report findings (with request ids / effect ids) to the coordinator so they route fixes. Reply to the user in Chinese, short and plain.

## 1. Where things are

- Live product: https://wekruit-livekit-agents--wekruit-recruiting-recruiting.us-east.modal.direct
- Modal app `wekruit-recruiting`, CLI `/Users/adam/Documents/ChatGPT/headhunter/work/private/modal-deploy-venv/bin/modal`. Latest at handoff: **v123** (deployed 10:38 CDT = 15:38 UTC, main 00abb64a per coordinator). Every few minutes a new main is deployed by the release thread.
- Authoritative report (Chinese): `/Users/adam/Documents/ChatGPT/headhunter/work/full-product-plan/PRODUCT-ACCEPTANCE-20261023.md`. Newest sections are at the top ("最终确认", "最终状态", per-version tables). Mirror to project files via SendUserFile after each update.
- Acceptance tools (copied from the old scratchpad): `/Users/adam/Documents/ChatGPT/headhunter/work/full-product-plan/acceptance-tools/`
  - `run.py <script.mjs> <containerId> <out.json> [args]` runs a script inside the live container with `node --import tsx -e`, extracts the `ACC_OUT {...}` line, writes JSON (0600). Every script opens a pool with `default_transaction_read_only=on`, `BEGIN READ ONLY`, selects metadata/ids only (no secrets), ROLLBACKs, closes the pool.
  - `postdeploy.sh <sinceISO>`: version/history, container, /health /ready, `board.mjs` safety board, branding/Rakazo-string scan of all JS chunks, 3-min parallel 503 burst. Takes ~5 min.
  - `board.mjs <sinceISO>`: migrations ledger, event-order inversion (agent.tool.called vs completed by executionId), runs/queue, tool errors, takeover/disabled-tool events, effects, outbound-type effects, non-terminal effects (baseline executing 7 / intended 2 / approved 1 / uncertain 1 must never be replayed), ask-card statuses, protected counts, Dyna threads, mail state, cost, users/bots, cross-user owner mismatch.
  - `live.mjs <sinceISO>` (runs/events/effects/cost), `nr2.mjs` (new role watcher), `rep.mjs` (reply card/effects since 15:30), `fin.mjs` / `card.mjs` (activation effect + card), `out.mjs` (all write/send effects since 10-22), `core.mjs` (Instantly effect + mcp_servers row).
  - Pick the container with `modal container list`; during a recreate there may be two; use the one that does not say "shutting down".
- Browser: the **Claude in Chrome extension** in the user's Chrome (signed in as admin). Use `tabs_context_mcp` → work in the MCP tab group. If it disconnects, ask the user to reopen the Claude side panel. Do not enable "Allow JavaScript from Apple Events" (security setting). Chrome is read-only for computer-use. Never click Allow/Confirm on outward cards for the user; bring the tab to front (AppleScript `set active tab index` works) and tell them what to click.
- Gmail of admin1@wekruit.com is available via the Gmail MCP (`search_threads`, `get_thread`) for delivery checks. Read only; do not send without the user's explicit word.
- Auto-mode classifier blocks: further Instantly writes initiated by you in the product, and some prod reads. If blocked, stop and ask the user directly in the thread.

## 2. Key ids

| Thing | Id |
|---|---|
| Admin user / space | brt3jAssLqyUCuj1nFurBBewvzvnt9No / 12033aa4947cfef3e44b5424872ae6ed |
| Dyna · Data Infra | group cmvh05ixi00001hfqqhgpjoiu, thread cmvh05j1n00051hfqd0sqqgxc, role 55eb90bd-55ca-4803-89ab-61fbcbd20862 (134 cands, CRM role d5b8213a-8009-425d-a1fd-d8aebc71f131, org 8a545110-d526-47ff-a530-648ee7be139c, 610 CRM contacts) |
| Dyna · Simulation | group cmvh09kbi000d1hfqtdlzry1m, thread cmvh09kf9000i1hfqif6s17j4, role 92ea41ba-5ed1-4cf8-ba51-1891b1eee878 (16 cands, no CRM binding) |
| Email and interview coordination (no role) | group cmvh18j6l00001hfq5rgif91x, thread cmvh18jev00051hfq0zacsvw7 |
| Test role 「Rakazo 内部测试」 | group cmvl1c44400081hfqbkb0xk2b, thread cmvl1c45x000d1hfqwj82cy4h, role ce604726-fd3c-4ec7-8ef8-2b725ebf4e40 |
| Test campaign | d4b1bc78-5363-437a-bcb1-343ecc9c85ca, lead admin1@wekruit.com id 01a168f2-1dda-7128-ad95-0262d2373e59 |
| Stray empty campaign (never activated) | 6a1364c1-e377-4921-952c-99245c6860ba (Dyna role mapping removed) |
| User's new role | 1c979abd-4b86-4b27-a89d-5853d981af7d 「分拣仓运营主管/经理 — New Jersey」, thread cmvl4csuv00051bfqw3sg5juq |
| Instantly connector | mcp_servers cmvafvgm000091hfqtf254szq, https://mcp.instantly.ai/mcp (serves both remote MCP tools and native_instantly_* REST tools); sending account noah@perfectwekruit.org |

## 3. Instantly loop state (9 steps)

1–4 PASS (one create, idempotent re-run, admin1 lead). 5 PASS: user clicked Allow once 14:54:34, effect cmvl2x4zr001z1ifqnpge2idh activate_campaign completed once, campaign status 1; admin1 received exactly one email 15:02:18 (Gmail thread 1a16948ccc471f3d). 6 PASS: admin1 replied "收到 谢谢" 15:02:35. 7 PASS: Instantly ingested 15:02:58; product read via list_emails/get_email/get_thread_history. 9 PASS: lead status 1→3, stop_on_reply true; campaign now shows Completed/Completed in Sequence.
**Open:** step 8 (agent replies "收到，谢谢" in the same thread via a 「确认回复」 card) — core says the reply path is not shipped; at 15:49 there was no reply_to_email effect or reply card. Also **test-role Inbox still "Not checked yet"** (agent reads are not projected into the Inbox view). Product-side, nothing else was ever sent (verified via out.mjs).

## 4. PASS / FAIL as of 15:55 UTC (v123)

PASS: release safety on every deploy (ledger 114 now; protected counts never dropped; non-terminal effects untouched; no unintended outbound); Data Infra list 134 sorted by score with per-criterion Match/Unclear; Simulation sort by score (after clearing one stale localStorage key `…:group:cmvh09kf9…:recruiting:92ea41ba…` that held sort:"name"); unified candidate list; Contacts 610 + Load more; Inbox full CRM thread (Data Infra); Interview; right panel + Esc; Sequence chips 32/262/316; test-role Sequence card; tool-event order (0 inverted); progress steps + "Worked for…"; cost fields; no computer/browser takeover (B); HubSpot connect card; chat open by default; favicon; sidebar "Needs input" badge; titled former "New role" groups; profile drawer Assessment/Research findings with agent assessment; role-setup checklist bar; card survives restart.
FAIL / OPEN: test-role Inbox projection; step 8 reply card; `?detail=` deep link on load strips param and opens no drawer (clicking a row does set it); two sidebar roles both named 「分拣仓运营主管/经理」; first load of Data Infra list ~20–25 s; Sumeet lookup in the roleless chat (p_org passed the user id, client/role names mismatched) and stale answer in role chat (missed 10-22 16:14 reply because Instantly contact read errored); 503 windows on deploy (26 s / 19 s / 21 s on the last ones, ~13% in a post-deploy burst on v118); new-role rename request ("先叫WeKruit Test") not applied to the title; user-facing card titles still English ("Confirm requirements", "Review before Instantly … activate campaign" with raw campaign_id); composer typed while chat closed was dropped (may be automation-only); HubSpot MCP discovery errors ×13 after the connect card; second real user not available (isolation untested).

## 5. Open checks to run next

1. **New role 1c979abd timing:** last card answered ~15:41:29; first result page landed ~15:52:12 (44 candidates, recruiting_research completed; Autumn reply/get_task continuing). Record tap→first list ≈ 10.7 min, then whether exactly 10 are presented for calibration in chat, Fit/criteria display, sorting, and whether campaign/leads/activate happen only after explicit confirmation. Watch with `nr2.mjs`.
2. Step 8 reply card once core ships it: target thread = admin1's reply message id 01a16949-5a6e-7c4b-ae36-27cede898362, recipient admin1, body "收到，谢谢", once-only; then Gmail shows Noah's reply in thread 1a16948ccc471f3d.
3. Test-role Inbox shows the reply after core's fix.
4. Profile UI (#57/#59): experience timeline in the drawer (scroll), assessment rows.
5. On every deploy: run `postdeploy.sh`, compare to the board, report version + PASS/FAIL to the coordinator, update the report, tell the user in 3–6 lines.
