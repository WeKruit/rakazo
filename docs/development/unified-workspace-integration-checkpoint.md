# Unified workspace integration checkpoint

This is local development evidence, not a completion claim or production acceptance. The canonical [acceptance checklist](unified-workspace-acceptance.md) remains the delivery gate. No publication, deployment, production migration, grant change, CRM sync, mail send or booking was performed for this integration.

## Integrated source

The integration preserves main `94a706a089710cea083192a126ab77a8f577e91c`. Local browser checkpoint: `46db567898a1c29cb56c19e1ef4777f2fe142e41`.

- Profile backend, components and tab integration: `a7e78d43`.
- Final profile visual refinement: `02729feffb02d69a87cf7fef342ce4f2644ad512`.
- Primary Sequence/calendar routes and collapsed secondary actions: `7ec86992`; calendar-order assertion: `cc2980f8`.
- Exact role-owned booking receipts: `adea11a4d5cce3e4ce24bffc01946fed644f5fca`.
- Permission narrowing correction: `cefb44d8e2fa7fe307d5138e5842a4475e9c65e6`.
- Browser fixtures and actual application route specifications: `46db567898a1c29cb56c19e1ef4777f2fe142e41`.

The earlier profile-only review describes its source checkpoint. The combined integration additionally supports authorized canonical CRM attachments for profile activity, uses a responsive 600-pixel default detail width, preserves unknown totals, restores the exact Notes deep link, and applies role-owned calendar receipt checks. Those differences supersede the earlier profile-only description; they do not imply final visual acceptance.

## Executed integration checks

Use the repository's pinned pnpm version. Database commands require a disposable local PostgreSQL database with the full migration chain; substitute a local-only connection for `<isolated-local-database>`. No Docker or production connection was used.

| Command | Result at checkpoint |
| --- | --- |
| `pnpm exec tsc --noEmit -p apps/web/tsconfig.json` | Passed after final source refinement |
| `pnpm exec vitest run apps/api/src/recruiting.test.ts packages/adapters/src/mcp-connector.test.ts` | 514 passed, 2 files |
| `pnpm exec vitest run packages/adapters/src/mcp-crm-scope.test.ts packages/db/src/recruiting-bootstrap.test.ts` | 96 passed, 2 files |
| `VERIFY_DATABASE=1 DATABASE_URL=<isolated-local-database> pnpm exec vitest run packages/db/src/recruiting-profile-activity.postgres.test.ts apps/api/src/recruiting-crm-sync.postgres.test.ts packages/db/src/recruiting-crm-workspace.postgres.test.ts` | 32 passed, 3 files; existing pg concurrent-query deprecation warning |
| `pnpm exec vitest run apps/web/src/pages/recruiting/InterviewTab.integration.test.tsx apps/web/src/pages/recruiting/EmailConversation.test.tsx apps/web/src/pages/recruiting/DetailPanel.test.tsx apps/web/src/pages/recruiting/InterviewCalendar.test.tsx` | 33 passed, 4 files |
| `pnpm exec vitest run apps/web/src/pages/recruiting` | 468 passed, 11 failed, 27 files; fixture/count-expectation corrections underway, not a green run |

Test counts overlap and must not be added into a unique total. Independently run linked scheduling scenarios passed at `cefb44d8`, but use scripted providers and preselected slots. They do not prove fresh pre-dispatch availability checks, actual candidate reply comprehension, delivery or original-thread confirmation. Further scheduling corrections require rerunning the affected scenarios.

The broader PostgreSQL baseline has separately documented existing failures: [comparison](legacy-crm-postgres-baseline-2026-10-23.md). Passing the targeted database suites does not erase them.

## Outstanding integration work

- Reconcile exact mailbox/campaign/thread grouping in the profile Inbox and canonical candidate rail/Profile navigation.
- Validate shared header/mobile chat layout and all five actual routes using the combined source, then inspect desktop/mobile captures against the supplied references.
- Integrate the profile-view late-failure retry correction and rerun affected tests.
- Complete scheduling preflight and original-thread confirmation review through existing assigned provider tools; do not invent provider schemas or imply successful booking from a request alone.
- Produce the final per-item evidence matrix, exact final code/doc SHA, review artifact and operational prerequisites. Source-mail SQL/tool changes remain a separately documented unpublished patch; current customized tool grants are not automatically expanded.

The local owner retains all live verification. A passing development test, a draft PR or a review approval is not authorization for production actions.
