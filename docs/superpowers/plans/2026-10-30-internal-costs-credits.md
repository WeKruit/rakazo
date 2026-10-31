# Internal costs and product credits implementation plan

**Goal:** Customer usage exposes only product credits. Verified operator staff have a separate Internal Costs tab with all accounts and vendor/model token and cost breakdowns.

**Architecture:** Reuse the durable usage ledger and existing RPC/settings shell. Product credits equal USD vendor cost divided by (1 - 0.5) times 100; the conversion rate is snapshotted on ledger insert. Keep measured costs and unknown measurements distinct. External calls already include any provider-owned internal model costs, so do not synthesize those tokens.

**Tech stack:** TypeScript, Prisma/PostgreSQL triggers, oRPC/Zod, React settings, native mobile settings, Vitest and Playwright.

- [x] Add failing accounting, credit privacy, operator authorization, model bucket and historical-rate checks to the existing usage tests; run them before implementation.
- [x] Replace mixed provider-credit totals with product-credit aggregation. Snapshot conversion rate and provider cost on insert through the existing ledger boundary. Preserve explicit unknown costs. Add an additive migration and exercise it in disposable local PostgreSQL.
- [x] Change public contracts to credit-only amounts; expose internal visibility capability and a separately authorized internalCosts RPC with account/vendor/model breakdown. Guard raw list and summary interfaces for nonstaff.
- [x] Build a credit-only Usage panel and a staff-only Internal Costs settings section. Use existing semantic tokens, accessible disclosure controls, readable numeric tables and narrow-screen scrolling. Add focused UI tests and screenshot E2E coverage.
- [x] Update native mobile usage to product credits and cover operator diagnostics through its settings surface.
- [x] Run focused unit/API/PostgreSQL tests, relevant type checks and a local browser workflow for external and verified staff accounts. Inspect desktop-width and narrow-width screenshots. Review the final diff for authorization, double counting, persistence and scope.

No rate limits, payment checkout, credit purchase/expiry policy, or unrelated billing changes are in scope. No production migration or deployment is implied by local validation.

Validation: focused accounting, provider, authorization, UI and executor suites pass. Disposable PostgreSQL migrations and ledger tests cover fractional LLM credits, source receipts, duplicate delivery, changing conversion rates, preserved costs, and operator/customer separation. Browser proof reconciles a synthetic account's model and service costs to customer credits, then checks the verified operator's view of that account. Native mobile has TypeScript validation; device acceptance remains separate. The existing Expo version alignment check reports dependency patch drift; this work does not change dependencies.
