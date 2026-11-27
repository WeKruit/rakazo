# Prune low-value unit tests

Tests cost tokens every time an agent writes, reads, runs or updates them. The suite has grown faster
than the product: on stage (2026-11-14) there are 977 unit test files with about 10,500 test cases
and 325,000 lines, against 405,000 lines of non-test source. Thirteen test files are over 3,000 lines
(about 70,000 lines together); an agent editing the matching module reads them. A unit-shards run
takes about 2.5 minutes on 6 runners and runs for nearly every stage PR.

Rule going forward: AGENTS.md, Development standard 3.

## Done in the standard PR

- Removed `packages/core/src/recruiting-rules.test.ts` (1,654 lines of pinned instruction
  sentences). The maintainer had already deleted it once; it was restored within minutes and grew
  by 28 more commits. Instruction behaviour is covered by the simulated-customer journeys and evals.

## Next, one PR per step, each with before/after test count and shard time

1. **Instruction-text assertions.** `recruiting-defaults.test.ts` and `recruiting-playbook.test.ts`
   hold about 56 `toContain`/`toMatch` checks on prompt wording. Keep the length budgets and anything
   that checks structure (every bot has its tools, a skill exists); drop wording pins that a journey
   covers.
2. **The thirteen 3,000+ line test files.** For each, delete cases that duplicate another case's path
   with different data, cases for removed features, and snapshot-style assertions on copy. Keep one
   case per real branch and every regression case that names its bug. Start with
   `apps/web/src/pages/RecruitingPanel.test.tsx` (9,364 lines) and `apps/api/src/recruiting.test.ts`
   (7,978).
3. **Tests for code that no longer exists.** Find test files whose subject module was deleted or is
   unused (`knip` or a coverage run shows modules imported only by their tests).
4. **Measure.** After each step, record test files, cases, lines and unit-shards wall time here.

Never delete a test that is the only guard for auth, sends, approvals, account isolation,
persistence or recovery.
