# Recruiting UI/UX fixes — desktop and conversation first

## Coverage

| Review item | Resulting behavior | Verification |
|---|---|---|
| A1 | Answering a focused approval returns the side conversation to live updates; current card state is retained | StackedConversation regression |
| A2 | A send receipt clears only the submitted draft revision | Delayed receipt regression |
| A3 | New messages preserve historical reading position; Jump to latest remains available | Scroll-following regression |
| A4 | Current pending answer has a locator; discarded mail starts collapsed; reading views do not open an empty chat or take composer focus | Transcript, mail-card and route checks |
| D1 | Unsaved sequence edits survive SPA navigation by authenticated user/Space and sequence scope; explicit discard/save clears them | Remount, isolation, failure and revision-conflict regressions |
| D2 | Shortlist success follows the actual persistence result, with failure recovery in the profile | Profile and caller regressions |
| D3 | Earlier-message failure preserves the loaded conversation and offers local retry | Inbox pagination failure regression |
| D4 | Core contact columns stay readable; optional columns remain accessible; identity stays visible | Directory tests and desktop visual checks |
| D5 | Recent work/tasks lead the dashboard; unknown metrics and missing schedules use compact disclosure | Dashboard and sequence tests |
| M1 | Narrow contact search gets a full row | Responsive visual checks |
| M2 | Today is enabled when a different day in today's window is selected | Calendar regression |

## Data and approval boundaries

No schema changes or historical data rewrite. Unknown statistics remain unknown. Sequence edits are retained only for the current SPA session, with the existing reload warning; restoring a draft never submits it or replaces the original concurrency revision. Mail still requires the existing exact human approval.

## Copy

New copy is limited to actionable local failures and compact source disclosure:

- “Could not update shortlist. Try again.” identifies a failed persistence action in the profile where recovery happens.
- “Could not load earlier messages. Try again.” identifies only the failed pagination request while existing mail remains readable.
- “Saved calendar checks” labels the collapsed source/coverage details.
- “Historical totals · — Not reported” consolidates repeated missing-data legends.

The two failure messages appear only when relevant. Source/coverage detail is collapsed rather than persistent explanation. Existing “Needs an answer”, “Jump to latest” and column controls are reused.

## Release acceptance

Automated UI fixtures use synthetic records and are distinct from staging acceptance. After review and staging deployment, verify desktop conversation continuation, unsent input, historical reading, sequence navigation, profile recovery, inbox recovery, compact overview/contact views, and the two phone cases. Record the deployed revision and screenshots before marking release acceptance complete.
