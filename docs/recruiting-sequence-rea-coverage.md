# Sequence REA implementation coverage

2026-11-01. Scope: approved UIUX-SPEC sections 4, 5 and 10 and Sequence requirements in JUICEBOX-PRD. Evidence below is local implementation/fixture evidence, not production/provider acceptance.

| Requirement | Implemented behavior | Source boundary |
| --- | --- | --- |
| Overview | Header, date selection, role-scoped Analytics link, New sequence, six metrics, Schedule axes/Today/legend, historical sequence table/search/sort/selection | Missing daily email timestamps and scheduled sends render unknown; aggregate campaign snapshots are not assigned invented dates. 30/90-day selections do not claim snapshot totals describe those periods. |
| Detail | Exact role/campaign selection, seven metrics, Email/Job Posting tabs, all retained template variants and schedule observations, campaign contacts with status/response filters, selection/export/paging | Campaign membership is not a fabricated complete execution history. CRM contact detail uses actual email identity. Owner and executed step remain unknown when not reported. |
| Contact telemetry | Actual provider name/company and per-contact open/click/reply counts retained; missing remains unknown, zero remains zero | No invented Low/Medium/High engagement thresholds or inferred step numbering. |
| Response editing | Unclassified/Interested/Not interested through existing native update operation, exact role/server/campaign/email membership proof, authorization before/after async calls, post-update readback | Provider updates run in background. UI reports pending unless the readback confirms the requested classification. Unclassified is not “No reply”. |
| Editor | Independent Composer pane, collapse/keyboard width adjustment, email navigation/scroll, cards, actual subject/body/variables/preview, timing expansion, sender/timezone, one save, Done/unsaved confirmation | Delivery window and timezone are campaign settings. Plain-text editable subset stays explicit; rich/conditional content is preserved read-only with sandboxed preview and original source. |
| Create/Clone | Real native draft creation and exact saved-template clone, zero-contact readback, independent role-associated identity, existing primary retained, associated draft selector | No lead/history/status cloning and no activation. Exact rich template payload is copied without HTML-to-text conversion. |
| Send boundary | Review/send and Composer prepare native conversation requests naming the selected saved sequence; ambiguous identity requires selection | UI save/create/clone/Done cannot activate or send; activation remains native approval gated. |

## Durability and concurrency

No new Sequence entity or queue was introduced. Existing `ExternalEffect` receipts store the operation nonce, dispatched payload, returned campaign identity and explicit role association. Browser session nonces persist through uncertain create/clone failures. The unique receipt is reserved before dispatch; replay returns the known identity or refuses to repeat a POST whose delivery is unknown. Known identities and secondary role associations are saved in a short database transaction before post-create authorization rejects a revoked caller. No network call runs inside that transaction.

Editable reads return a SHA-256 hash of canonical saved configuration (not telemetry). Save requires that hash, re-reads provider configuration, rejects a stale revision, and uses a unique receipt to prevent two application clients overwriting the same revision. A successful exact retry does not PATCH again. Actual provider readback must match every supplied configuration field (including content, schedule, sender and stop flags) before a save is completed; an ignored PATCH remains unconfirmed and cannot be blindly retried. Create/clone apply the same exact readback check.

Provider ceilings: Instantly documents no idempotency-key mechanism and does not expose a conditional campaign update/ETag in the used API. If a create response is lost before an identity is received, the operation remains visibly unconfirmed and is not automatically retried; provider reconciliation is needed. A provider-side writer can race the final GET/PATCH because no remote CAS exists. A provider success followed by an unavailable local database cannot be made atomic across those systems. These limits are not represented as completed operations.

## Verification

- Native regression coverage: clone retains exact rich source and primary binding; revoked post-create callers retain association; uncertain create/clone retry dispatches once; two-client stale-save rejection and successful retry without second PATCH.
- Service regression: foreign campaign membership prevents response mutation; accepted asynchronous classification remains pending until readback.
- UI regression: response telemetry preserves real zero and pending classification does not optimistically change the source value.
- Playwright synthetic fixture at 1440 and 320 pixels: step navigation, save/reopen, unsaved dialog and viewport overflow; separate new-draft and rich-source preview checks. No provider is called.
- Focused native/service/editor/overview/source-detail/account tests and adapter TypeScript check pass. Full-suite and actual production acceptance are recorded separately by the parent integration task.

Provider references: [Lead schema](https://developer.instantly.ai/api-reference/schemas/lead), [Campaign schema](https://developer.instantly.ai/api-reference/schemas/campaign), [official idempotency conventions](https://github.com/Instantly-ai/instantly-starter-kit/blob/main/docs/conventions.md#idempotency).
