# Recruiting playtest

A scoring loop for the bot instructions. Each round runs real recruiting conversations on the live
product, scores what the recruiter saw, and fixes the instructions only for recurring defects.

1. **Run.** Replay each scenario on a fresh test copy with `../recruiting-latency.mjs` (role start,
   intake, first ten, scale) and `../replay-messages.mjs` (later recruiter messages), with `--keep`.
   Two samples per scenario. Approval cards are never answered.
2. **Transcript.** `transcript.mjs --group <id>` prints what the recruiter saw.
3. **Judge.** `judge.mjs --samples <dir>` scores every sample in its own model request with
   `rubric.md`, given the live instructions (`packages/core/src/recruiting-defaults.ts`), the
   scenario and the transcript, and stops at its spend cap (US$3 by default).
4. **Fix.** For each defect that recurs across samples, `judge.mjs` drafts the smallest
   instruction change. Apply a draft only when it holds up. The change must keep every bot within the 12,000-character budget and pass
   `pnpm exec vitest run packages/core/src/recruiting-defaults.test.ts`; ship it through a normal PR
   and release.
5. **Stop** when every dimension averages at least 4.5 for two rounds in a row. One failed sample
   fails the round.

Scenarios come from real conversations that went wrong and stay out of this public repository: keep
them with the project's private files and never commit a real JD, name or conversation. Archive the
test copies after scoring.

`benchmark.mjs` repeats steps 1–3 as one round and appends it to a history file with the change
since the last round, so the same scenarios can be rerun on every release or nightly (US$5 judge cap
by default). Playing scenarios searches on the live product, so it only does so with `--search`.
