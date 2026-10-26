# Recruiting first-10 flow: what can still run in parallel (2026-10-26)

Baseline: main after #201 (streamed round picks, fast-model intake, no tool catalog before the
first round) and #202. Numbers come from the live test on that build unless marked otherwise.
Each opportunity has an owner slot: write your session or name next to **Owner** before starting,
push to the same PR branch, and tick the matching box in the PR body.

Project rules every item must keep:

- The model chooses people. No local evaluator, score or ranking stands in for it.
- Clarify, never confirm. One question at a time, only for information that is truly missing,
  before the search.
- All saves are non-blocking for the recruiter.
- No dead code and no versioned copies: change the path directly.
- Never test inside real customer roles; use copies and archive them.

## 1. Where the time goes today

Live numbers on the current build:

| Milestone | Link JD | Text JD |
|---|---|---|
| Send → first question (Q1) | 8.4 s | 8.3 s |
| Last answer → first person in chat | 18.8 s | 21.5 s |
| Last answer → all ten in chat | 31.4 s | 43 s |
| Search rows → unique people | 92 → 64 | 97 → 70 |
| Duplicates shown | 0 | 0 |

**The largest remaining gap is the 9–10 s the model thinks after the last answer before any
search goes out, followed by 3–6 s of search.** Everything else is smaller.

Step-by-step, after the last answer (link JD, approximate):

| # | Step | Runs | Time | Notes |
|---|---|---|---|---|
| A | Setup: lease, context, tool discovery join, recruiting context, model key | parallel inside, serial with B | ~0.9 s | `discoveryJoinMs` floor ~0.68 s, the cached per-server fetches |
| B | Prompt notes: job role start, saved job page, intake skill, reply context | **serial before this PR, parallel now** | tens to hundreds of ms | now logged as `turnNotesOwnMs` |
| C | Model thinks and writes four people searches | serial | **9–10 s** | intake turns route to the fast model but inherit the bot's thinking level |
| D | Four searches (25 people each), in parallel | parallel; the model waits for the slowest | 2.5–4.3 s (up to 6 s) | smaller queries were measured and are not faster |
| E | Each search saved to Results before its rows reach the model | serial after each search | not measured until now | now logged as `people_search.autosave` |
| F | Model reads ~70 compact rows and starts the round | serial | ~4 s to the first person | first person streams into chat while the model writes |
| G | Model writes the remaining nine with fit lines | serial (streamed) | 12–21 s | output tokens dominate |
| H | Round recorded, next-step card, brief saved | brief in background | 1–3 s to the card | |

Before the last answer: Q1 at ~8.3 s is mostly one fast-model step (setup ~0.9 s, link fetch on the
link path, then the model). Later questions were not re-measured on this build.

Setup detail from production logs (fast route, ms; each `*OwnMs` is one load on its own):

| Turn | discoveryOwn | memoryContextOwn | recruitingContextOwn | lease / ctx | discoveryJoin | runtimeStart |
|---|---|---|---|---|---|---|
| First turn | 254 | 113 | | | 889 | 1.9–2.7 s |
| First turn | 196 | 77 | | | 911 | |
| Later turn | 594 | 127 | 2155 | 128 / 487 | 1770 | |
| Later turn | 682 | 168 | 1927 | 383 / 786 | 2215 | |
| Later turn | 336 | 73 | 1351 | | 1213 | |

nativeSources, recall, stoppedNotice and turnImages were 0 in every run. Two readings:

- Correction from P16 inspection: `discoveryJoinMs` is cumulative from pickup, while the
  `*OwnMs` values measure individual, overlapping loads. Their sum does not establish uncovered
  waiting. Use the new join interval and each load's start/end offsets to identify the critical path.
- Lease, context and discovery spiked together when two runs shared one worker, which points to
  contention on the worker's database pool (4 connections).
- On later turns `recruitingContextOwnMs` (1.35–2.2 s) is the largest single setup piece.

## 2. Opportunities

Savings are estimates until measured; "Measure" says how to prove them. Effort: S under half a day,
M one to two days. Risk covers quality, cost and the project rules.

### P1. Lower thinking for intake turns (model choice per step)

- **Owner:** shipped in #203 (low thinking level on intake turns); quality check pending the live test
- **Serial today:** step C. Fast routing swaps only the model id and keeps the bot's configured
  thinking level (`executor.ts`, `{ ...configuredRunModel, id: turnModel.model.id }`), so an intake
  step that only writes four search queries can think as long as a heavy turn.
- **Change:** give the fast route its own thinking level for `recruiting_intake` and
  `clarifying_answer` turns (for example "low"), through the shared connection settings rather than
  a new env var. Keep the configured level for the pick (step F/G) unless measured otherwise.
- **Expected savings:** 3–6 s of the 9–10 s after the last answer; 1–3 s on Q1 and each question.
- **Risk:** query wording quality. Low cost risk.
- **Effort:** S.
- **Measure:** `run.timing` model-step time for the turn after the last answer; grade the ten with
  the existing grading scripts against the current build on two role copies (fit score must not drop).

### P2. Write the search plan during the question turns

- **Owner:** shipped in #203 (`plannedSearches` on the last question, run when it is answered); live timing pending
- **Serial today:** the model plans the searches only after the last answer (step C), although by
  the last question it already knows the title, location and most must-haves.
- **Change:** when the model asks a question, it also keeps a short draft of the four query
  wordings in the turn (for example an optional `draftSearches` field on the question it records,
  stored server-side and returned in the next intake note). After the last answer the model edits
  the draft and issues it, instead of planning from scratch. The model still writes every query.
- **Expected savings:** 3–5 s of step C, on top of P1.
- **Risk:** a slightly longer question step (the question must still post first: write the draft
  after the question text, never before it). No extra search cost.
- **Effort:** M.
- **Measure:** time from the answer event to the first `web_search_advanced_exa` tool call in the
  `threads/subscribe` replay; Q-to-Q time must not grow by more than 1 s.

### P3. Speculative searches before the last answer (needs the user's decision)

- **Owner:** _unclaimed, blocked on a product decision_
- **Serial today:** steps C and D both wait for the last answer.
- **Change:** when the last open question cannot change the title or location (the model decides,
  for example a nice-to-have), the model issues the four searches in the same step as the question.
  Results are saved but not shown until the answer arrives; after the answer the model either picks
  straight away or re-searches with the answer folded in.
- **Expected savings:** 9–14 s (C + D) on the happy path; zero when the answer changes the search.
- **Risk:** this runs searches before the recruiter answers, which conflicts with "questions before
  the search" unless results stay hidden. Wasted search cost when the answer changes the plan.
- **Effort:** M.
- **Measure:** share of rounds where the speculative set was used unchanged; extra search cost per
  role.

### P4. Do not let the slowest search hold the pick

- **Owner:** _unclaimed_
- **Serial today:** step D. The model's next step starts only after all four parallel tool results
  return, so the slowest search (up to ~6 s) sets the pace while the fastest returns in ~1.5 s.
- **Change:** a per-search soft deadline (for example 3.5 s after the first search returns): late
  searches keep running and still save to Results, and the model gets a short "still arriving"
  result for them. Calibration still picks from saved rows, so a late search is used by the next
  round or the top-up wave.
- **Expected savings:** 1–2.5 s on the tail.
- **Risk:** fewer rows for the pick when a search is slow (64–70 unique today, the ten need far
  fewer). Medium effort in the runtime's parallel tool execution.
- **Effort:** M.
- **Measure:** spread between the first and last search completion in the event replay; unique rows
  available at pick time.

### P5. Take the per-search save off the model's path

- **Owner:** _unclaimed_
- **Serial today:** step E. Each search's rows reach the model only after the server records the
  save effect, writes the page and upserts candidates.
- **Change:** build the compact rows (candidate key, alreadyInPool from one indexed read, 160-char
  snippet) straight from the search result and return them, while the page write and candidate
  upsert finish in the background. `calibration_round` awaits any pending save for its run before
  recording, the same way it already awaits the job-role save.
- **Expected savings:** the measured `people_search.autosave` duration (expected 0.3–1.5 s).
- **Risk:** a key the model sees must match the saved key: derive both from the same function.
  Saves remain non-blocking for the recruiter.
- **Effort:** M.
- **Measure:** `people_search.autosave` log (added in this PR) before and after.

### P6. Shorter pick output

- **Owner:** no change needed: `calibration_round` already takes only the ten keys and the server
  renders each person. The 12–21 s between the first person and all ten still needs the event
  replay to explain.
- **Serial today:** step G, 12–21 s, dominated by the model writing ten fit lines.
- **Change:** ask for one short fit line per person (the passage already shows the evidence), and
  let the server render name, title, company and location from the saved row so the model writes
  only the candidate key and the fit line.
- **Expected savings:** 4–10 s to all ten.
- **Risk:** fit lines become terse; the model still chooses the people.
- **Effort:** S.
- **Measure:** "last answer → all ten" on both JD types; output tokens of the pick step.

### P7. Keep the intake skill in the cached prefix

- **Owner:** _unclaimed_
- **Serial today:** the intake skill text is injected into the per-turn prompt after the history,
  so the provider cannot reuse it from cache between Q1, each answer and the search turn.
- **Change:** place it where it is stable across turns of the same role (system prompt or the first
  history entry), keeping the timestamp and per-turn notes at the end.
- **Expected savings:** 0.5–2 s of prefill on every intake turn.
- **Risk:** low.
- **Effort:** S.
- **Measure:** `promptCache` cached tokens and model-step time in `run.timing`.

### P8. Start the job link fetch at pickup

- **Owner:** _unclaimed_
- **Serial today:** on the link path the job page fetch starts only after setup (step A).
- **Change:** start the fetch as soon as the run is claimed and the message is known, in parallel
  with setup; the role create still waits for tools.
- **Expected savings:** 0.5–0.9 s on Q1 for link JDs.
- **Risk:** low; the fetch is already idempotent per run.
- **Effort:** S–M.
- **Measure:** Q1 on link JDs; `turnNotesOwnMs` on the first turn.

### P9. Tool discovery below 0.5 s

- **Owner:** _unclaimed_
- **Serial today:** step A, `discoveryJoinMs` ~0.86 s, floor ~0.68 s from per-server cached fetches.
- **Change:** run the per-server cache lookups in parallel, or cache the merged tool list per bot
  and refresh it with the existing 8-minute prewarm.
- **Expected savings:** ~0.3–0.4 s on every turn.
- **Risk:** stale tool list for up to one refresh; the failure-skip TTL already exists.
- **Effort:** S.
- **Measure:** `discoveryJoinMs` in `run.timing`.

### P10. Write brief, round, CRM and next-step card at once

- **Owner:** _unclaimed_
- **Serial today:** after the ten, the next-step card appears 1–3 s later; brief save is already in
  the background.
- **Change:** post the next-step card as soon as the round is recorded and run the brief save, CRM
  upsert and any draft delegation in parallel behind it.
- **Expected savings:** 1–2 s to the card.
- **Risk:** none on the recruiter's side; each write keeps its own idempotency key.
- **Effort:** S.
- **Measure:** time from `calibration_round` effect to the card message.

### P11. Frontend: render saved rows from the event

- **Owner:** _unclaimed_
- **Serial today:** Results refreshes by refetching role candidates after each `effect.recorded`
  for a saved search, one RPC round trip per search.
- **Change:** carry the new rows (or their keys and display fields) in the event payload and merge
  them into the cached list; refetch only to reconcile. Show the recruiter's own message and the
  next-step card optimistically.
- **Expected savings:** 0.3–0.8 s per search on the panel; no change to chat time.
- **Risk:** event payload size (25 compact rows per search is small). Web, desktop and mobile share
  the reducer, so do it in the shared package.
- **Effort:** M.
- **Measure:** time from the effect event to the rows painted (web E2E with timing marks).

### P12. Scale-out to 100 in fewer model steps

- **Owner:** _unclaimed_ (not tested on the current build)
- **Serial today:** scale-out runs waves of four searches, one model step per wave (~10 s thinking
  plus ~3–4 s search), until the role holds the target or a wave adds fewer than five people. With
  ~15–25 new people per wave this is 4–6 sequential steps.
- **Change:** issue 12–16 differently worded searches in one step, then one more step only if the
  role is still short. The model still writes every query and never ranks people between waves.
- **Expected savings:** 30–50 s to 100 people.
- **Risk:** search rate limits on bursts; more overlap between queries. Same cost per search.
- **Effort:** S (instruction change) plus a live test on a role copy.
- **Measure:** "accept → 100 in Results" with the headless latency harness.

### P13. Feedback next round without a second wave

- **Owner:** _unclaimed_ (not tested on the current build)
- **Serial today:** round 2+ runs four searches and, when fewer than ten new people come back, a
  second set in another model step.
- **Change:** first measure how often the second set happens. If often, issue six searches in round
  2+ so the second step is rarely needed.
- **Expected savings:** ~13–15 s on rounds that currently need a second set.
- **Risk:** extra search cost on rounds that did not need it.
- **Effort:** S after measurement.
- **Measure:** count of second sets per round in the event replay; feedback → ten time.

### P14. Prefetch contact details for picked people

- **Owner:** _unclaimed_
- **Serial today:** contact lookups start only when outreach is prepared.
- **Change:** start the lookup for each person as they stream into chat (after the model picks
  them, never before), in the background and reusing paid results.
- **Expected savings:** outreach readiness, not chat time.
- **Risk:** paid lookups for people the recruiter later passes on. Keep it opt-in per role if cost
  matters.
- **Effort:** M.
- **Measure:** time from accepting the round to a ready draft; lookup cost per role.

### P15. Worker database pool contention

- **Owner:** _unclaimed_
- **Serial today:** each worker has a pool of 4 connections. A recruiting turn's setup fires many
  reads at once (context, discovery, memory, recruiting context), so two runs on one worker queue
  behind each other; lease, context and discovery all spiked together in that case.
- **Change:** measure pool wait (time from query issue to connection acquired) first; then raise
  the worker pool through the existing pool setting, within the database's connection limit across
  all workers, or cut the number of setup queries (P16, P17).
- **Expected savings:** 0.3–1.3 s on turns that share a worker (the gap between the uncovered
  wait and the loads).
- **Risk:** total connections across workers and the API must stay under the database limit.
- **Effort:** S.
- **Measure:** pool wait metric; `leaseMs`, `contextLoadMs` and `discoveryJoinMs` with one and two
  concurrent runs per worker.

### P16. Find the uncovered wait in discoveryJoin

- **Owner:** dot (implemented and verified offline 2026-10-26; pairs with P9)
- **Finding:** `discoveryJoinMs` is a cumulative pickup-to-join milestone, not the duration of
  discovery or of the join itself. The earlier comparison with the sum of overlapping `*OwnMs`
  did not demonstrate 0.5–1.3 s of uncovered waiting. MCP server catalog reads and all nine join
  members already run in parallel; no additional serial wait was proven safe to remove.
- **Change:** retain the cumulative mark; add `discoveryJoinStartMs` and `discoveryJoinWaitMs`.
  All nine join members now have `*StartMs`, `*EndMs` and `*OwnMs`, including the previously
  untimed scratchpad, tickets, resume brief and routine history. Native human sources, memory
  and recall are timed at launch rather than when joined. No context or authorization cache added.
- **Reproducible local measurement:** the fake-clock executor test injects 200 ms of prior
  context loading, 30 ms of discovery and 60 ms of scratchpad loading. Observed offsets are
  discovery 200–230 ms and scratchpad 200–260 ms; `discoveryJoinMs=260`,
  `discoveryJoinStartMs=200`, `discoveryJoinWaitMs=60`. This proves that the wait is the slowest
  overlapping load, not their sum, and distinguishes it from earlier setup. These are synthetic
  offline measurements, not production latency or a measured speedup.
- **Validation (repository-root commands unless noted):**
  - `node_modules/.bin/vitest run packages/adapters/src/executor-recent-turn-images.test.ts`:
    exit 0, 24 tests passed (includes the fixed-clock measurement and interval coverage).
  - `node_modules/.bin/vitest run packages/adapters/src/executor*.test.ts`:
    exit 0, 675 tests across 13 files passed.
  - `node_modules/.bin/tsc --noEmit -p packages/adapters/tsconfig.json`: initially exit 1 because
    the pre-existing generated Prisma client lacked current schema models. Regenerated locally
    with `node_modules/.bin/prisma generate` from `packages/db` (exit 0; no migration).
    Rerun exit 0 after generation.
  - `pnpm exec biome check packages/adapters/src/executor.ts`: initial exit 1 because the
    environment's global pnpm attempted an unavailable automatic install. Used existing local
    binaries instead. Initial direct Biome check found formatting (exit 1); applied the formatter.
  - `node_modules/.bin/biome check packages/adapters/src/executor.ts packages/adapters/src/executor-recent-turn-images.test.ts`:
    final exit 0, both files clean. `git diff --check`: exit 0.
- **Limitations / next measurement:** no deployment, external searches or role writes. No
  production time saved claimed. On an approved future release, compare `discoveryJoinWaitMs`
  with the latest join-member end offset minus `discoveryJoinStartMs` (within rounding/scheduling
  overhead), and inspect the
  earlier setup milestones separately. A pool contention diagnosis still needs P15 measurements.

### P17. recruitingContext on later turns

- **Owner:** _unclaimed_
- **Serial today:** 1.35–2.2 s to build the role context on every later turn, more than any other
  setup load.
- **Change:** time its internal reads, run independent ones together, and reuse the rendered
  context while the role revision and round count are unchanged (between two questions they are).
  Mutable business state that matters for authorization is never cached.
- **Expected savings:** 1–1.5 s on every answer turn, including the one after the last answer.
- **Risk:** stale context if the cache key misses a change: key it on role revision, round count
  and the latest feedback id.
- **Effort:** M.
- **Measure:** `recruitingContextOwnMs`.

### P18. Skip the needless save_search

- **Owner:** _unclaimed_
- **Serial today:** on a text JD run the model still called `save_search` after every search had
  already been saved as it returned, costing a model step and ~2 s.
- **Change:** when every people search of the run is already saved, leave `save_search` out of that
  step's instructions and answer it at once from the saved rows (the server already reuses them),
  so the model has no reason to call it.
- **Expected savings:** ~2 s when it happens.
- **Risk:** low.
- **Effort:** S.
- **Measure:** count of `save_search` calls per round in the event replay.

### P19. Keyless people-search fallback and its rate limit

- **Owner:** dot (implemented and verified offline 2026-10-26)
- **Today:** the people search uses the deployment key when one is set and falls back to the
  keyless channel when it is not (`platformMcpCredential` in `mcp-connector.ts`). During the
  search-size measurement the keyless channel returned 429 "free MCP rate limit" after about 150
  calls in roughly six minutes, and later calls came back empty.
- **Production (checked 2026-10-26):** the deployment key is set and sent with every people
  search, so production does not use the keyless channel today. The item covers self-hosted
  deployments and a key that is removed or expires.
- **Risk:** if a deployment runs without the key, a few users scaling to 100/200 at once (5–16
  searches each) hit that limit. Rows then stop arriving and the round looks short for no visible
  reason.
- **Change:** log a warning once per process when people search
  runs keyless. Treat a 429 from the search as rate-limited, back off and retry, rather than as an
  empty result.
- **Expected savings:** none on the happy path. It prevents stalled or short scale-outs.
- **Effort:** S.
- **Measure:** count of 429 responses from people search in the logs. Rows per scale-out wave.

- **Implemented:** a keyless credential load emits `people_search.keyless` once per process;
  keyed connections do not warn. Only the built-in read-search tools retry typed HTTP 429 or an
  explicitly failed rate-limit tool result. Backoff is 1 s then 2 s, at most three calls. Each
  retry rechecks the current assignment and credentials; cancellation interrupts the wait.
  Exhaustion returns a rate-limit error instead of empty results. Other providers, mutation tools,
  non-429 failures and successful result text are not retried. Existing uncertain-outcome semantics
  remain for unrelated failures. Logs contain no query or credential material.
- **Reproducible local measurement:** fake-clock transport tests observed search calls at
  0 / 1,000 / 3,000 ms for two 429s followed by success. Exhaustion made exactly three calls;
  cancellation or revoked assignment during the first wait prevented a second dispatch.
  These are deterministic offline results, not live API latency or throughput measurements.
- **Validation (all from the repository root):**
  - `node_modules/.bin/vitest run packages/adapters/src/mcp-connector.test.ts packages/adapters/src/mcp-people-search-rate-limit.test.ts packages/adapters/src/mcp-transport.test.ts packages/adapters/src/mcp-crm-scope.test.ts`:
    exit 0, 310 tests across four files passed, including 19 new rate-limit cases.
  - `node_modules/.bin/tsc --noEmit -p packages/adapters/tsconfig.json`: exit 0.
  - `node_modules/.bin/biome check packages/adapters/src/mcp-connector.ts packages/adapters/src/mcp-people-search-rate-limit.test.ts`:
    exit 0, both files clean. `git diff --check`: exit 0.
  - One intermediate regression run failed (exit 1) because the test omitted the existing safe-fetch
    network-error prefix. Corrected the expected existing behavior; the final suite above passed.
- **Limitations:** the installed transport SDK does not preserve `Retry-After`; the bounded fixed
  delays may be shorter than the provider's rate-limit window, in which case the caller receives
  the explicit error. No live search, paid lookup, email, CRM sync, deployment or new resource was
  used. No happy-path speedup claimed; production recovery still requires authorized future testing.

## 3. Ranked by expected effect on "last answer → ten"

1. P1 thinking level for intake turns: 3–6 s.
2. P6 shorter pick output: 4–10 s to all ten.
3. P2 search plan drafted during questions: 3–5 s.
4. P3 speculative searches: 9–14 s, needs the user's decision.
5. P17 recruiting context: estimated 1–1.5 s per answer turn. P16 now supplies corrected timing;
   its earlier savings estimate was not established by the cumulative milestone.
6. P18 needless save_search: ~2 s when it happens.
7. P4 + P5 search tail and save off the path: 1.5–4 s together.

Scale-out (P12) is the largest absolute saving, 30–50 s, on the 100-person path.

## 4. Adaptive search size: many queries first, bigger pages for scale-out

Two proposals from the user:

- **A.** First round: many small searches at once, so the first 2–4 people appear almost at once;
  the rest of the ten from normal batches. Scale-out: the first 7–8 people from single fast
  lookups, the rest from large batches.
- **B.** Scale-out (100/200): ask each search for many more results, because small pages may waste
  spend re-finding the same people.

### What was measured (2026-10-26)

People search with highlights (300 chars), the same call shape as production, through the keyless
search channel. Four role copies outside any customer role: a New Jersey sort supervisor, an
Atlanta warehouse operations manager, a Phoenix quality manager and a Bay Area data infrastructure
engineer. Sixteen differently worded queries per role, at 10, 25, 50 and 100 results per query,
four in flight at a time. The keyless channel rate-limited midway through the Phoenix runs, so only
New Jersey and Atlanta are complete and used below. A separate run timed sizes 1, 5, 10 and 25 on
eight fresh queries, one at a time, in random size order.

**Latency does not depend on size.**

| Results per query | Median | Range |
|---|---|---|
| 1 | 2.1 s | 0.4–5.0 s |
| 5 | 1.7 s | 0.5–3.7 s |
| 10 | 1.5 s | 0.6–2.9 s |
| 25 | 2.7 s | 1.6–3.7 s |
| 50 (in the 16-query runs) | 2.2–2.3 s | p90 3.0–3.4 s |
| 100 (in the 16-query runs) | 2.9 s | p90 3.5–5.1 s |

The spread within one size (0.4–5 s) is far larger than the difference between sizes. A one-person
search is not faster than a ten-person search.

**Unique people as queries accumulate** (New Jersey / Atlanta):

| Queries | 10 each | 25 each | 50 each | 100 each |
|---|---|---|---|---|
| 1 | 10 / 10 | 24 / 24 | 48 / 47 | 98 / 94 |
| 2 | 20 / 19 | 48 / 46 | 95 / 88 | 174 / 176 |
| 3 | 28 / 29 | 69 / 70 | 136 / 134 | 241 / 264 |
| 4 | 37 / 36 | 92 / 91 | 179 / 169 | 324 / 323 |
| 6 | 52 / 56 | 128 / 136 | 254 / 257 | 442 / 479 |
| 8 | 71 / 75 | 173 / 181 | 339 / 336 | 582 / 611 |
| 16 | 137 / 148 | 326 / 349 | 604 / 627 | 1008 / 958 |
| Duplicate share over 16 | 14% / 8% | 19% / 13% | 25% / 22% | 37% / 32% |
| Queries to 100 unique | 12 / 11 | 5 / 5 | 3 / 3 | 2 / 2 |
| Queries to 200 unique | >16 | 10 / 9 | 5 / 5 | 3 / 3 |

Location in scope stayed flat with depth (New Jersey 69–75%, Atlanta 93%). A rough title-and-duty
keyword check fell slightly with depth (New Jersey 46% → 43%, Atlanta 74% → 68%): results 51–100
of a query are a little weaker but still usable.

**Production key, checked 2026-10-26 (read-only probe, key not printed):** a people search with 50
results returned HTTP 200 with exactly 50 results and was billed $0.047; one with 100 returned
HTTP 200 and was billed $0.096. The key is not capped at 25, and the bill is about $0.001 per
result returned, highlights included.

**Cost per 100 unique people** at that rate: 10 each ≈ $0.11, 25 each ≈ $0.11, 50 each ≈ $0.12,
100 each ≈ $0.16. Bigger pages cost slightly more per unique person, not less, because the long
tails of different queries overlap more; the difference is a few cents per role. The real gain of
big pages is fewer queries the model has to write and fewer calls against the rate limit.

The measurement used the keyless channel ($0). The production probe cost about $0.24. The US$150
budget is essentially untouched.

### Answer

- **A, tiny searches for the first people: no.** A one-person search is not faster (median 2.1 s
  vs 1.5 s for ten), and the first person in chat waits on the model's 9–10 s of thinking before
  any search goes out, then on its pick. Tiny searches only help if they go out earlier, which is
  P2: queries the model drafts during the questions are sent the moment the last answer arrives,
  as normal 25-result searches. Their rows show in Results as they land; the model still picks the
  ten. Expected: Results rows ~3 s after the last answer instead of ~13 s; first person in chat
  ~8–12 s instead of 19–22 s (P1 + P2 + P6 together).
- **A for scale-out: no.** Scale-out has no first-person wait: each search already saves to
  Results 2–3 s after it is sent.
- **B, bigger pages for scale-out: yes.** The production key returns 50 and 100. Settings:

| Step | Today | Recommended |
|---|---|---|
| First round (ten) | 4 × 25, ~64–70 unique | keep 4 × 25 |
| Scale to 100 | waves of 4 × 25, one model step each | one step of 4 × 50 (~170–180 unique, ~$0.19) |
| Scale to 200 | 3+ waves | one step of 4 × 100 (~320 unique, ~$0.38) or 6 × 50 (~255, ~$0.28) |

All of these are one model step instead of several waves, which is where the time goes (P12).

### PR item

- [x] Confirm the production key's maximum results per request (50 and 100 work).
- [ ] Scale-out instructions: one step of 4 × 50 for 100, 4 × 100 for 200.
- [ ] P2 answer-time dispatch of drafted searches.
- [ ] Live test on a role copy: accept → 100 and → 200 in Results, unique count, cost.

## 5. How to measure

- `run.timing` logs per run: setup marks (`*Ms`, `*OwnMs`, now including `turnNotesOwnMs`), model
  step times and prompt cache use.
- `people_search.autosave` logs the per-search save time (this PR).
- `run.timing` is now also logged for turns that end with a question (`outcome: waiting_input`,
  this PR); before, only completed turns logged it, so question turns had no model timing.
- `POST /rpc/threads/subscribe` replays every event of a group with durations: tool calls, effects
  and messages, which gives every milestone in section 1.
- The headless latency harness in `infra/acceptance/recruiting-latency.mjs` runs text and link JDs
  end to end; run it once per change set, never during another session's test.
