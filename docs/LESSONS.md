# Lessons

One line per miss: what happened, then the rule that prevents it. Read before starting work; add a
line after a false "done", a reverted fix, a correction from the maintainer, or the same bug twice.
Keep it public-safe (no names, accounts or customer data) and under about 40 lines: merge a lesson
that repeats into the existing line instead of adding another.

- A test runner re-read every conversation every few seconds and used up the shared daily request
  quota, taking staging and production down. **Wait on the live updates the app uses; never poll.**
- One scenario got several instruction PRs in a row and still failed, each adding a sentence and a
  pinned test. **Reproduce it as an eval, fix the mechanism, and change wording last (AGENTS.md
  standard 4).**
- Instruction sentences were pinned in a 1,600-line unit test; the maintainer deleted it and a thread
  restored it eight minutes later. **A maintainer's decision stays made; ask before reversing it.
  Behaviour is checked by journeys and evals, not by pinning sentences.**
- Results were reported as passed when the run had not happened or had hit environment errors.
  **"Not run" is not a pass; claim only what a run in this session shows.**
- A one-off account-copy script broke three different ways on three runs. **Extend the shared tool
  and its tests instead of writing a new script per need.**
- A whole shared file was reformatted in a feature PR and collided with other threads. **Format only
  the lines you changed.**
- New code kept going into one 20,000-line file. **Add a focused module and call it.**
- The simulated customer reported every page as 15 s, a "missing" Word attachment and a phone send
  failure; all three were the harness (network idle never comes with a live stream, a filename filter,
  Enter on a touch screen); later "stuck loading" pages were a snapshot taken on an unrecognised loading
  line, and "unsigned" emails came from a placeholder account name; a "card with no button" was a text
  transcript that never listed any card's buttons. **Before routing an eval finding,
  check the harness could have produced it: read the page's own wording and the account's setup.**
- A scrubbed account copy rewrote emails but kept real LinkedIn URLs, so a simulated batch send let
  Kruit look up six real people's addresses and add them to a draft campaign. **A test copy keeps no
  enrichable identity and has paid lookups turned off; the harness refuses to play if one is on.**
- A new `--mechanism` replay picked a paid journey because it bypassed the paid filter; it was stopped
  before any search. **Every new way to select tests keeps the paid and send gates of the old ones.**
- Four instruction PRs for one feedback round still left the recruiter seeing nine people while a
  different ten were recorded: the chat list and the round record checked repeats differently. **Read
  the run's events before rewording; when two tools judge the same thing, give them one rule.**
- After a pooler failover a worker's database sessions went half-open and twenty jobs, a recruiter's
  search among them, waited with no error and no log for good. **Every network wait gets a
  client-side bound just past the server's own limit, so a lost reply fails instead of hanging.**
- A fix that dropped a new role's copied message from the language decision, so a later
  message in the main conversation could win, also removed the only words the role's first turn
  had, and four new-role checks asked Chinese recruiters in English. **When you exclude a source
  from a decision, test the case where it was the only source, not just the case it overruled.**
- A first-line change let the quick reply carry the answer and told the main answer not to
  repeat it; when nothing was left to add the answer came out empty and the runtime posted
  "No response. Try again.", and the line parroted the prompt's example fact into every reply.
  **When one step may now finish another's job, test the case where the second has nothing left
  to say, and never put a concrete fact in a prompt example the model can copy.**
- Two fixes told the answer to continue from the separate quick first line instead of
  repeating it; the next gate still showed every turn as a line and then an answer saying it
  again. **Two writers of one reply repeat each other: make them one message (the answer takes
  the line's place) instead of instructing one about the other.**
- A judge summary said a wrong-name email "was queued"; it had read a card the customer denied, and the report relayed it to the user as sent. Before reporting a send fault, read the transcript and the records for which card was approved; the judge ties send claims to the approved card and the records only.
- One role ran 18 paid deeper searches in a row that each found nobody (about $10), because the
  prompt said a short target is "never a reason to stop early" and nothing in code counted
  results. **Every paid loop gets a stop in code on what it returned, not a sentence in a prompt.**
- 2026-11-15: a thread branch reused after squash merges was merged with `-X ours`, which brought back a hunk another PR had removed and broke the stage type check. Merge an old thread branch with `-s ours` and typecheck after the merge, before pushing.
- The round check counted a requirement as "new since the last round" by when it was saved, and
  the brief is saved seconds after round one, so every brief field (base pay included) looked new
  and round two came up five short. **Date a requirement by when the person said it, not when the
  record was written.**
- The staging container died at its memory limit twice in a day with only a dozen runs: the worker
  held 2.5 GB with a 0.65 GB JavaScript heap, freed native memory glibc never returned. **Measure
  resident size against the heap before blaming load or buying memory.**
- 2026-11-15 — "#6 and #8 are off, find me more like the rest" was recorded as accepting the
  calibration round, so the next people skipped the round check and the Reviewer. **A message that
  turns some of the round down is feedback for the next round, not acceptance of this one.**
- The worker's startup account walk redid every account on every boot and was cut off by each
  deploy, logging thousands of pool errors as staging accumulated test accounts. **A backfill
  runs once per change, records where it got, and stops with the process.**
- A guard against pasting an email again (#1366) read 「直接贴那一封」 as no request to see it,
  so Kruit described the email instead of pasting it. **A guard that withholds content lists
  every way the recruiter asks to see it, and its test includes the words from the gate.**
- The Connect card took three reply-level fixes before the cause showed: typing past it closed
  the card. **When a card misbehaves twice, check what closes or reopens it before changing
  the replies around it.**
- 2026-11-15 — `corrects: true` was added for recruiter swaps and later reused to mark the
  Reviewer's checked round. The team then used it to slip round-1 people back in and to skip the
  check. **An escape flag has one owner: key a bypass on who is calling (the run), not on an
  argument the model can set.**
- 2026-11-15 — "Find 20" saved 64, then 41, then 29. Each fix capped one call, but four searches
  sent together each saw an empty role (saves are async), and a guard read the role id from the
  thread loaded before the run saved the role. **A limit on a total is checked and reserved in
  one step at the shared boundary, and in-run state is read fresh, not from the run's snapshot.**
- 11-15: #1381 held rounds after feedback, but the round's first picks and streamed round arguments still reached chat before the hold, so the recruiter saw two lists. Rule: a hold on showing something covers every path that posts it (streams, early picks), not only the final record.
- 11-15: the held round waited six minutes because steered follow-ups kept its turn open, and its checked version took a new round number. Rule: once work is handed to a background step, end the turn that handed it off, and a replacement nobody saw takes the original's place rather than a new number.
- 11-15: a long search's 19 people were never scored: one mistyped link refused the Reviewer's whole save with a message that named nobody, and the unsaved turn parked grading with nothing scheduled to try again. Rule: a refusal names the exact rows to fix and matches what it safely can; any wait a background step sets schedules its own wake-up.
- 11-15: #1424 moved the recruiter's follow-ups out of the held turn into a new turn, which ran before the check and wrote the held round out. Rule: a hold applies to every turn until the check lands, not only the turn that set it.
- 11-15: #1430 read the held round once at turn start and matched only profile links, so a turn already running when a teammate held the round summarized its grades by name. Rule: read shared state when you act on it, not when the turn begins, and match what the recruiter would recognize (names), not one format.
- 11-15: The judge still told new roles to ask before searching after the product moved to search-first, so it vetoed correct replies as "asked again" and blocked prod. Rule: when a product decision changes the expected behaviour, update the judge's rule in the same hour and re-grade saved plays with `--calibrate` before the next gate.
- 11-15: The people cap was fixed three times for one journey (#1404, #1409, then this): a run reserved nothing, a finished search held its share 30 s too long, and the plain web search skipped the cap while save_search still saved its people. Rule: **a limit covers every tool path whose output it counts, and a reservation lasts exactly until that output is counted**; list those paths from the save side, not from the tool you first saw.
- 11-15: Two squash merges (#1398, #1414) carried another session's Claude-Session link, copied from a neighbouring commit message. Rule: take commit attribution from this session's own instructions, never from git log or another PR.
- 11-16: One judge reading vetoed the same one-off-email reply as "repeat" while its own note said it was not one, and re-grading the same transcript flipped verdicts between runs, so gates failed on judge noise. Rule: a release-gating LLM judge writes its reasoning before its labels and votes across several readings; check a judge change with `--calibrate` on labelled plays, not one rerun.
- 11-16: A held round was guarded on the Reviewer's side only, so the lead handed it to the Reviewer as a chat turn, a later turn recorded round 3 over it, and its check gave up after six minutes behind other turns; round 2 was never shown. Rule: **a state that waits for one actor guards every other actor's path that could replace or block it**, and its retry lasts as long as the wait itself.
- 11-16: The checked round replaced only people graded Partial, so people whose profiles never showed a must-have (Promising/Uncertain) were shown as checked; a blind full-profile judge passed 4 of 10 in such a round. Rule: **a check passes only what it saw proven**; "not shown" on a must-have is a miss to replace, kept only when no proven replacement exists.
- 11-16: Five guards (#1424–#1462) patched one held-round failure each, because the round's state was inferred from which run's nonce recorded it plus a time window. Rule: **state that decides who may act is stored and changed by conditional updates**, never re-derived from the history of who touched it; a new guard on inferred state is the cue to store it.
- 11-16: #1467 narrowed "a round would be held" to "the latest round is shown", so attempts made while a round was still being checked streamed their picks into chat before the save refused them, and the recruiter saw six people twice. Rule: **when a stored state replaces an inferred one, list every reader of the old answer and check what each does in the new in-between states**, not only the writer.
- 11-16: d6afae8d play 2: a round finished grading at 04:50 but was never shown. The turn-end guard kept re-starting the lead's refused turns (8 autocontinues), and a handoff guard that checked only bot_id let two chat handoffs to the Reviewer through by name. Together they kept the thread busy until the hold expired. Rule: **a guard on an action covers every way of naming its target**, and an automatic retry stops when the work it would retry is waiting on someone else.
- 11-16: The simulated recruiter wrote 「拿到候选人我第一步该做什么」 (reads as "after I have candidates") for the goal "how to get candidates", and the judge failed Kruit for answering the literal question; two judge-wording fixes did not move the verdict. Rule: when a play fails on the customer's own ambiguous words, fix the simulator's phrasing, not the judge.
- 11-16: Three batch-account plays started side by side in one account's main chat (9e15e896), so each judge scored replies meant for the others, and "还没有候选人的回复" was flagged a dead end although it answered the question. Rule: **plays that share one fixture account run one at a time, enforced by the harness**, and a rule check reads "nothing yet" as a state, not a refusal.
- 11-16: Every brief field the recruiter stated became a hard requirement for the Reviewer, including the pay range and office days, which no profile shows; every person was "unknown" on them, nobody could be Strong, and each checked round turned into a full swap. Rule: **a requirement on a person must be something a profile can show**; terms the job offers are not graded on candidates.
- 11-16: The checked-round swap told the lead to fill misfits from saved people "not checked yet" or a fresh search, so seven checked Promising people were swapped for unchecked ones in a 2–3 minute turn. Rule: **a check only ever replaces checked people with people the same check passed**; with none, keep the closest checked ones.
- 11-16 feedback-round edb7834f: "not kwang, not the amazon ones, get 4 more" reached the role's lead quoted in a handoff, which the named-people check never read, so a round of additions was recorded and the turned-down people stayed unreviewed. A check on the recruiter's words reads every block that carries them (typed or handed in), and people are named by name, number or company.
- 11-16 gate 4a731582: a filter that dropped a reply's repeated opening line also dropped a revised email's Subject line. Rule: **a filter that removes repeated text never touches the deliverable itself**.
- 11-16 honest-limits 8a002815: when a record was empty the card said nothing ("no roles" was just missing), so on push-back Kruit apologised and called its correct answer unverifiable. Rule: **a record the agent answers from states none as a definite none**, not by leaving the line out.
- 11-16: A day of my own guard pushes and tool refusals (round-owed push, named-people refusal, a how-to sentence) each fixed one play and the next play failed somewhere else; the failures were hand-offs between agents. Fix the single agent's own search and review path first; delete a rule layer rather than add one.
- 11-16: #1542 let the main chat run people searches with no role to save them in; feedback-round fell to 4 (nothing saved, checked or kept, a snippet's employer stated as fact), and a 2-sample lead was reported to the user as a win before 5 samples showed none. Rule: before moving work into a conversation, check every record that work writes reads that conversation's binding; report a version comparison only at 5 samples or more.
- 2026-11-16: feedback the lead never saved ("senior only, 6+ years") was missing from the next round's check, so the list ignored it. The Reviewer reads the recruiter's own words since the first round, not only what an agent chose to save.
