# Docs-only publication review

Audit baseline: `5c210b626c22ab2f1ecd34836c216b52e197bcd6`, 2026-10-25. These are source-defined triggers; no workflow was dispatched during this research. Do not treat Draft status or a commit-message annotation as a deployment safety boundary.

| Event / workflow | What this docs-only change can cause |
| --- | --- |
| Feature-branch push | The inspected workflows do not have a general feature-branch push trigger. External GitHub Apps/hooks are a separate uncertainty. |
| Draft PR opened / synchronized | `ci.yml` has an unrestricted `pull_request` trigger, without docs filtering or a draft guard. It runs lint/type/build/unit/integration/E2E checks. |
| Integration / Web E2E harness | `packages/testkit/src/cli/harness.ts` starts a PostgreSQL Testcontainers instance; CI therefore involves Docker even for a docs-only PR. This is distinct from deploying a server image. |
| CI completion | `publish-playwright-report.yml` accepts successful, failed or timed-out PR CI runs. It reads retained artifacts and calls the trusted report publication script with S3 configuration. |
| S3 report publication | `PLAYWRIGHT_PUBLISH_REPORT=false` for a PR suppresses the full Playwright report upload, **not** screenshot-gallery images/index/manifest, history/dashboard or latest-PR gallery uploads. The script still has unconditional S3 writes for those outputs when execution reaches them. |
| Release validation | `release-validation.yml` also triggers on PRs. Its PR path runs synthetic validation with native PostgreSQL; source packaging is limited to the main workflow-run path. This is not a production deployment. |
| Server image publication | `publish-server-image.yml` PR paths exclude docs; this change does not match its app/package/infra paths. Main/tag/manual image publication remains unrelated to an unmerged docs branch. |
| Staging / production promotion | The inspected staging and promotion workflows require manual dispatch and activation/hold checks. This PR does not authorize or invoke them. |
| External deployment integrations | Earlier hook/deployment metadata checks returned HTTP 403. No newly expanded permission was obtained, so that limitation was not bypassed or repeatedly retried. Empty commit statuses are not proof that external hooks are absent. |

Sources:
[CI](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/.github/workflows/ci.yml),
[PostgreSQL harness](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/testkit/src/cli/harness.ts),
[report workflow](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/.github/workflows/publish-playwright-report.yml),
[report script](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/scripts/publish-playwright-report.sh),
[release validation](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/.github/workflows/release-validation.yml),
[image publication](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/.github/workflows/publish-server-image.yml),
[staging](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/.github/workflows/staging.yml),
[production promotion](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/.github/workflows/promote-production.yml).

At preparation, publishing is held until the pending CI-side-effect decision covers CI Docker test containers and the configured S3 screenshot/report writes, and the external-hook uncertainty is explicitly resolved or accepted within the allowed scope. No workflow, repository setting, permission or check is changed to bypass that decision. Approval to create a research PR is not approval to merge, deploy, invoke research, upload raw candidate records, or modify production.

Related work checked: #112 is a deployment-acceptance handoff; #115 implemented the search-brief changes and merged into this baseline. This research change adds an evidence-based review, not another copy of either implementation.
