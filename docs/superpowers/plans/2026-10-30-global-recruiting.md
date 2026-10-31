# Global recruiting implementation plan

**Goal:** Complete PR #597 acceptance in LEFT-NAV-GLOBAL-VIEW.md for product and CRM roles.

**Architecture:** Relocate and reuse existing authorized business reads so the API, pages and builtin tools use one implementation. Existing native crew provisioning, handoff, scheduling, routines and calendars remain authoritative. No schema migration or new scheduler.

- [x] Read repository instructions and diagnosis; rebase the specified branch on current main.
- [ ] Share role campaign/correspondence/calendar readers and add paginated actor+Space account reads with isolation tests.
- [ ] Global URL-addressable views with role picker, actual data and existing calendar.
- [ ] Idempotent global Main provisioning and existing-account backfill; cross-role tools and maintained instructions.
- [ ] Ordinary routine UI and tasks; expose existing native routine thread target without migration.
- [ ] Remove duplicate workflow navigation; mobile global entry and lists.
- [ ] Product-role and CRM regression paths, desktop/mobile screenshots and release regression integration.
- [ ] Focused checks, typechecks, web E2E; inspect staged public diff and push PR branch.
- [ ] Link CI screenshots; deploy only authorized code with no test active; isolated live readback and archive test copies; ready only after acceptance.

Validation commands: `pnpm exec vitest run` with changed recruiting suites; `pnpm --filter @rakazo/web check`; `pnpm --filter @rakazo/api check`; `pnpm --filter @rakazo/adapters check`; `pnpm test:e2e -- --spec=recruiting-global.spec.ts`. Offline fixture proof and live product acceptance are separate results.
