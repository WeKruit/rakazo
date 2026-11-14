# Live acceptance tools

Checks that run against a deployed environment (staging by default). Look here before writing a
script: a new test is almost always a new entry in an existing file, not a new file.

## Where a new test goes

| You want to test | Add it to | Run it with |
| --- | --- | --- |
| A recruiter conversation or journey (any language, persona or goal) | `--story "<the case in plain words>"` for a one-off run, or a saved journey (persona + goal, with its source) in `simulated-journeys.mjs` | `node infra/acceptance/simulated-customer.mjs --ui` (`--journeys <name>` for saved ones) |
| A rule about what a recruiter must or must not see in a reply | a check in `real-user-checks.mjs` (with its test) | used by `real-user.mjs` and the simulated customer's judge |
| A page that broke and came back | a check in `ui-regressions.mjs` | release regression |
| Something every release must prove | a layer in `regression.mjs` | release script, after deploy |
| Agent behaviour offline, with a real or emulated model | a case in `packages/testkit/src/evals/cases.ts` | `pnpm test:evals` |

Every conversation tool talks to the product through `real-user-session.mjs`: sign-in, sending,
answering cards and waiting for replies. Wait on the live updates the web app uses, never poll on a
timer: polling burned the shared request quota once. Extend the session client when a journey needs a new action.

## Index

Release gate: `smoke.mjs`, `regression.mjs`, `home-load.mjs`, `ui-regressions.mjs`
(`ui-regressions-checks.mjs`), `card-e2e.mjs`, `card-deadlines.mjs`, `restart-test-app.mjs`.

Conversations and judging: `simulated-customer.mjs` (the one LLM-driven customer; journeys in
`simulated-journeys.mjs`, browser in `simulated-ui.mjs`), `real-user.mjs` (scripted scenarios in
`real-user-scenarios.mjs`, checks in `real-user-checks.mjs`), `real-user-session.mjs` (shared client),
`replay-messages.mjs`, `playtest/` (instruction scoring loop, see its README).

Search and latency: `recruiting-latency.mjs`, `first10-suite.mjs`, `global-recruiting.mjs`,
`global-recruiting-chat.mjs`, `reviewer-grading.mjs`, `tool-timing.mjs`, `slow-tool.mjs`.

Runs and recovery: `follow-up.mjs`, `failure-recovery.test.mjs`, `workloop-browser.mjs`,
`workloop-task-controls.mjs`, `notification-policy.mjs`.

Accounts and cleanup: `account-isolation.mjs` (`account-isolation-checks.mjs`),
`archive-test-copies.mjs`.

`real-user.mjs`, `playtest/` and `simulated-customer.mjs` overlap. New conversation tests go to the
simulated customer; the other two are folded into it, not extended.
