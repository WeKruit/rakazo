# Shell shortcut extra-read investigation

Observed causal reproduction: D4 d564a9268 + diagnostic 5baba9d3e (d95a112ba cherry-pick), own-checkout @rakazo package mappings, four files maxWorkers=4. /tmp/shortcut-controlled-baseline-local.log: 1 failed / 461 passed, 15.54s, owner=true diagnostics=off 18ms. Extra group-1 read stack: readThreadSnapshot -> refreshGroupThread -> useShellMessages.ts:498 Timeout. It is the 3000ms send-echo fallback of a previously unmounted Shell; no timeout cancellation existed. Initial f28310991 Shell.tsx:3661 contains the same implementation. Historical logs lacked this stack, so their individual failures cannot all be conclusively attributed.

Deterministic real-timer regression: send synthetic message, unmount, wait3100ms. Before fix /tmp/shortcut-unmount-before.log fails expected0 actual1 (5.05s). Fix cancels owned echo timers on unmount and prevents receipt resolving after unmount from scheduling another. Mounted fallback remains unchanged. New parameterized cases cover mounted, unmounted, and late receipt.

Controlled matrix before fix:
- f28310991 four files maxWorkers4:462/462,16.23s /tmp/shortcut-controlled-initial1.log.
- D4 first four:462/462,15.60s /tmp/shortcut-controlled-baseline1.log.
- D2 dc3d4d56e four:463/463,16.00s /tmp/shortcut-controlled-current1.log.
- root ea4d3dbf9 four:464/464,15.27s /tmp/shortcut-controlled-root1.log.
- own package D2 allweb maxWorkers12:1664/1664,19.36s /tmp/shortcut-controlled-current12.log.
- own package f283 allweb maxWorkers12:1649/1649,20.27s /tmp/shortcut-controlled-initial12.log.
- D4 allweb prior symlink correction had CSS Vite cross-root denied-ID,1648passed; not a valid all-pass or strict baseline.
- First four-file D4/D2 dependency symlinks referenced root packages, so not strict source isolation. Later corrected only private checkout node_modules symlinks: external dependencies shared, @rakazo packages point respective checkout. No shared installation modified. Final causal repro uses corrected mapping.

Bounded experiments: fake timer500ms after palette close passed both branches but cannot exclude older real timers. Deliberately unconsumed get.mockRejectedValueOnce demonstrated queue persistence, but prevented initial message mounting rather than reproducing shortcut failure; not evidence for historical cause. No mockReset or assertion tolerance added. Four actual one-shot setup sites explicitly await corresponding reads. Normal trace showed initial group read and only final permitted bot-2 keyboard switch. Snapshot/retry code and original shortcut exact count assertions existed at f283; palette conditional/lazy rendering changed later. No inference that all old failures are fixed solely because reruns pass.

Historical logs: /tmp/d2-d4-merged-tests.log, /tmp/d2-release-web.log, /tmp/d2-lingui-web.log, /tmp/d3-merged-tests.log. Earlier /tmp/d1-webtest-new.log palette-not-mounted failure is different and excluded.

Fix commit1b927fbae: four-file465/46525.07s, web check exit0. Followup durable-event regression explicitly waits3100ms and verifies zero extra reads,1/1pass5.23s in /tmp/shortcut-confirmed-event.log. No shortcuts/count tolerances altered. No publication.

## Original pre-task baseline deterministic comparison

Initial worktree HEAD confirmed f28310991b10e04812631c89bd5114b303484858. Only Shell.test.tsx modified: prior precise shortcut diagnostic plus the same real3100ms unmounted-send regression transplanted from fixed D4 tests. No product fix or other product changes. Own-checkout @rakazo package symlinks retained.

Command (cwd rakazo-shortcut-initial):
PATH=$NODE24_BIN:$PATH pnpm exec vitest run apps/web/src/pages/Shell.test.tsx -t 'cleans up send echo refresh'

Result: exit1;1failed209skipped; test3243ms,total5.86s. Exact assertion expected0 actual1 after unmount and3100ms wait. Log /tmp/shortcut-initial-unmount-before.log; reproducible test-only patch /tmp/shortcut-initial-unmount-test.patch. This directly establishes the same unmount defect on the original baseline, beyond source similarity. Together with D4 unpatched expected0 actual1 and patched passing cases, this is a deterministic before/after comparison. It still does not establish the cause of every historical uninstrumented shortcut failure.
