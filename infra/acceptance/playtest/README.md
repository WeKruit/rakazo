# Recruiting playtest

A scoring loop for the bot instructions. Each round runs real recruiting conversations on the live
product, scores what the recruiter saw, and fixes the instructions only for recurring defects.

1. **Run.** Replay each scenario on a fresh test copy with `../recruiting-latency.mjs` (role start,
   intake, first ten, scale) and `../replay-messages.mjs` (later recruiter messages), with `--keep`.
   Two samples per scenario. Approval cards are never answered.
2. **Transcript.** `transcript.mjs --group <id>` prints what the recruiter saw.
3. **Judge.** A fresh model session per sample scores it with `rubric.md`, given the live
   instructions (`packages/core/src/recruiting-defaults.ts`), the scenario and the transcript.
4. **Fix.** When a defect recurs across samples, change the instruction that caused it. The change
   must keep every bot within the 12,000-character budget and pass
   `pnpm exec vitest run packages/core/src/recruiting-defaults.test.ts`; ship it through a normal PR
   and release.
5. **Stop** when every dimension averages at least 4.5 for two rounds in a row. One failed sample
   fails the round.

Scenarios come from real conversations that went wrong and stay out of this public repository: keep
them with the project's private files and never commit a real JD, name or conversation. Archive the
test copies after scoring.
