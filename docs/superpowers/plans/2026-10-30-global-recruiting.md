# Global recruiting implementation plan

**Goal:** Complete PR #597 acceptance in LEFT-NAV-GLOBAL-VIEW.md for product and CRM roles.

**Architecture:** Relocate and reuse existing authorized business reads so the API, pages and builtin tools use one implementation. Existing native crew provisioning, handoff, scheduling, routines and calendars remain authoritative. No schema migration or new scheduler.

- [x] Read repository instructions and diagnosis; rebase the specified branch on current main.
- [x] Share role campaign/correspondence/calendar readers and add paginated actor+Space account reads with isolation tests.
- [x] Global URL-addressable views with role picker, actual data and existing calendar.
- [x] Idempotent global Main provisioning and existing-account backfill; cross-role tools and maintained instructions.
- [x] Ordinary routine UI and tasks; expose existing native routine thread target without migration.
- [x] Remove duplicate workflow navigation; mobile global entry and lists.
- [x] Product-role and CRM regression paths, desktop/mobile screenshots and release regression integration.
- [x] Focused checks, typechecks, web E2E; inspect staged public diff and push PR branch.
- [ ] External acceptance: CI screenshots and isolated production readback. GitHub workflow dispatch currently returns HTTP 422 “Actions has been disabled for this repository”; isolated live fixture credentials are not available. No deployment or live acceptance claimed.

Validation commands: `pnpm exec vitest run` with changed recruiting suites; `pnpm --filter @rakazo/web check`; `pnpm --filter @rakazo/api check`; `pnpm --filter @rakazo/adapters check`; `pnpm test:e2e -- --spec=recruiting-global.spec.ts`. Offline fixture proof and live product acceptance are separate results.
