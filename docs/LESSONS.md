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
  Enter on a touch screen). **Before routing an eval finding, check the harness could have produced it.**
- Four instruction PRs for one feedback round still left the recruiter seeing nine people while a
  different ten were recorded: the chat list and the round record checked repeats differently. **Read
  the run's events before rewording; when two tools judge the same thing, give them one rule.**
- After a pooler failover a worker's database sessions went half-open and twenty jobs, a recruiter's
  search among them, waited with no error and no log for good. **Every network wait gets a
  client-side bound just past the server's own limit, so a lost reply fails instead of hanging.**
