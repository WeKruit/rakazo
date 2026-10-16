# Recruiting product implementation — T01–T10

Status: integrated into [PLAN.md](PLAN.md); product implementation is incomplete. T01 code and focused checks are complete but not deployed. T03 has only its empty-body filtering subitem complete in code; the rest of T02–T10 remains incomplete. Existing native features and integration acceptance retain their narrower evidence boundaries.

This is the public, de-identified integration of the supplied reverse-engineering plan. The original design, source conversations, examples and screenshots remain in the private design archive. The imported implementation document SHA256 is `733ef30b2937325789e53db46d035fffa15d6fb9779cd887956c9f68129bd80b`.

## Product outcome and boundaries

Users provide a JD URL, description or document in the existing Main/Sourcer Crew. The product maintains current role requirements, invokes the configured sourcing service, preserves its actual requests/results, evaluates evidence against each requirement, asks about missing definitions or facts, and updates only affected judgments. It restores the same role and task after navigation or restart.

- Keep Rakazo's Web/Electron/Expo, Pi, connections, MCP, MemoryStore, Artifact and original ask/approval flow. No second harness, model service, memory service, candidate master database, execution queue or new dependency.
- Recruiting records live in the independent agent database. Existing CRM identity, organization RLS, source/review operations and later outbound integration remain in the main P0–P6 plan.
- Search and continuation are authorized product capabilities under existing account access, quota and provider rate limits. They do not require approval on every call. Stop for new payment/subscription or exhausted quota; do not invent numeric limits. Handle rate-limit responses without turning an uncertain mutation into a new task. Outreach and other explicitly gated side effects retain their original approvals.
- Build the product first. Planning, opening views, restoring context and loading history never launch a search. No live sourcing task is authorized by importing this plan.
- Every numeric requirement is role data. A JD minimum and a later human revision are distinct sourced versions. Synthetic threshold examples must never become global constants or override the active role.

## Data and invariants

Use only the five proposed recruiting records, supported by existing messages, events and immutable Artifact versions:

| Record | Required meaning |
| --- | --- |
| RecruitingRole | Explicit identity, owner/space/source thread, title, numeric revision and currentRevisionId; never merge positions by company/title. |
| RecruitingRoleRevision | Immutable criteria, preferences, definition questions, source references and creation time; unique role/revision. |
| RecruitingResearchTask | Role, MCP connection/revision, real provider task ID, current action and creating run; unknown creation may have no provider ID. |
| RecruitingResearchAction | One create/continue request: role revision, run/source message, stable nonce, exact request/context/result/output Artifact versions, effect, cursor and scoped usage. |
| RecruitingAssessment | Immutable complete snapshot: role/revision, candidate key, version/basedOnVersion, facts, judgments, questions and sources. |

Thread.activeRecruitingRoleId binds the current role. Run.initialRecruitingRoleRevisionId records initial adoption, while subsequent accepted changes append durable adoption events. Run.checkpoint is not the role/task truth. Actor/owner/run identity comes from authenticated runtime context, never model-supplied mutation fields.

Role revision and assessment updates use CAS. Dispatch checks current role revision, context adoption and action state under the same transaction/lock before claiming the frozen request. Unclaimed old actions become superseded; dispatched requests retain their actual old version. A changed request cannot reuse an old approval. Main/Sourcer handoff and steering retain real authorship; another agent's account of human consent is not new authorization.

Action deliveryState is prepared/sending/accepted/rejected/unknown/superseded, separate from the provider's observed state. Queued/accepted is not completed. A dispatched mutation without a trustworthy receipt is unknown, not permission to retry. Persist the original effect result before business mapping; recovery completes mapping from that result rather than resending. Across runs, stable business action identity supplements the existing same-run effect identity; it does not replace the execution engine.

Provider output is a versioned observation after an action. Unless confirmed by the provider, providerApplicationConfirmed stays false: a local revision does not prove the remote task used it. Save each raw result page before advancing its actual cursor; retain cell value/source_id and _sources. Task usage is not automatically attributable to a batch or person.

Sources point to authorized messages or exact Artifact-version IDs/hashes with locators and read state/time. Distinguish provider_report/original_material/candidate_statement/recruiter_verified. An unread URL has no verified quote. Candidate identity uses a verified canonical profile identifier, otherwise a local unresolved source-row key; names alone do not merge people.

Criteria are atom/all/any/not, priority hard/preferred. Verdicts are met/unmet/unknown. Hard gates are AND; preferences or provider-qualified labels never compensate for a missing hard requirement. Missing facts and proven noncompliance remain different. Experience counting uses the role's defined employment/date/cutoff rules and interval union, with incomplete history or imprecise boundary months explicitly unresolved.

## Native memory lifecycle

Semantic intent distinguishes role changes, one-round recall scope, candidate facts and reusable preferences. No regex decides durable preference or qualification intent. Explicit changes save a receipt; ambiguous wording asks only for the missing definition.

Reuse MemoryStore.commit(expectedRevision) and MemoryRevision. Carry the loaded revision through Web, RPC and tool calls; a last-moment read of the newest revision does not protect previously prepared text. Empty-body replacement revokes the last preference without deleting history; filter empty documents before constructing any heading/path. Authorized history reads preserve source run/thread. User-scope Markdown memory is same-user/space cross-bot memory, not organization sharing.

Immutable context adoption records contain the actual role/revision, actor/run/thread, injected memory revisions/hashes, used/truncated fragments and scope. Revocation affects future adoption, not historical records. Role requirements do not enter the truncatable long-term-preference pool.

## Tasks and dependency order

| Task | Deliverable and existing implementation boundary | Status |
| --- | --- | --- |
| T01 | Shared contracts/core DTOs, three-state truth tables, source/read consistency and closed adoption/action event payloads; no generic MessageBlock extension. | Code complete: 25 focused checks, typechecks and independent spec/quality review pass; not deployed |
| T02 | Five records and Thread/Run binding in existing Prisma/Postgres; authenticated create/bind/workspace/revise/assessment/research RPCs, immutable revisions, transactional CAS and source ACLs. | Not implemented |
| T03 | End-to-end native memory CAS, empty-body revocation/filtering and authorized revision history; reuse current store. | Empty-body loader fix: 4 checks pass, not deployed; CAS/history/adoption gaps remain |
| T04 | Native recruiting_role/recruiting_feedback tools, semantic intent/source verification, current role adoption across send/steering/handoff/restart; exact context Artifact. | Not implemented |
| T05 | recruiting_research prepare/start/status/rows/continue through current MCP discovery/effect execution; frozen request, cross-run action identity, real task mapping and uncertain-result recovery on both API and worker. | MCP substrate connected; domain chain not implemented |
| T06 | Raw material → sourced facts → per-criterion judgment → deterministic hard gate; qualified-month union/precision, source-quote validation and immutable assessment. | Not implemented |
| T07 | Persistent definition/fact questions bound to original ask; new facts update only dependent judgments, revised criteria expire old assessments; external follow-up stays on the real provider task. | Not implemented |
| T08 | One native recruiting panel with five views; corresponding mobile route, typed assessment renderer and original-card custom answer; shared contract/API. | Existing containers reusable; views not implemented |
| T09 | Deterministic end-to-end, real isolated Postgres, owner/space/role/source boundaries, concurrency, restart/unknown and UI checks mapped to AC01–AC26. | Not run for this feature |
| T10 | Private real-sample report with frozen requests, receipts, source material, feedback/reassessment, same-task continuation and restart evidence. | Not run |

T01 → T02 and T03 → T04 → T05 → T06 → T07 → T09 → T10. T02/T03 have separate ownership. T08 can begin with the stable T02/T04 contract and joins the real data chain before T09. Shared executor/router/rpc/event integration has one owner. No runtime or provider SDK rewrite.

T01 files: contracts/src/recruiting.ts and core/src/recruiting.ts, their focused tests/exports and contracts/src/events.ts. T02 uses db/src/recruiting.ts, api/src/recruiting.ts, existing router/rpc and one new migration chosen after the actual latest migration. T03 modifies existing memory call sites/loader/tools and adds memory.history. T04–T07 use adapter recruiting-context/tools/research/assessment modules and the same registered native tool/executor paths. T08 uses Web RecruitingPanel/RecruitingAssessmentCard and Expo recruiting route plus existing thread ask components. Add only the files needed by each actual boundary.

## Five views

| View | Observable product behavior |
| --- | --- |
| Role requirements | Original wording/source, hard versus preferred, logic, missing definitions and version differences; recall scope shown separately. |
| Candidate evidence | Per-item met/unmet/unknown, facts, material locators, source type, gaps and assessment version; old versions visibly stale. |
| Missing information | Role definitions versus candidate facts; original-card answer, supplied material and local reassessment without a forced verdict first. |
| Memory | Role state, reusable preferences, candidate facts and task records remain distinct; actual scope/revision/source/adoption, correction/revocation/history. |
| Judgment record | Saved role → adopted context → actual prompt → provider receipt → material → judgment → feedback difference. This is an inspectable record, not hidden chain of thought. |

Use the existing ResizableSidePanel, tokens/components, native Artifact preview and ToolActivityDisclosure. Mobile uses one native route/sheet with the same API. Generic green-check cards cannot represent three-state evidence. Mobile actions ask gains custom input via threads.answer with the original run/message; onboarding ChoiceCard is not that interface. Do not fabricate arbitrary remote MCP elicitation from a text ask.

Opening/restoring/changing views is read-only. Thread/role changes discard obsolete responses. Layout storage contains view/role/selection references, never evidence, qualifications or authorization. Handle missing JD, clarification, working, empty results, provider error, unread sources, unknown, stale, cancelled and restart states without erasing saved results or weakening criteria.

## Acceptance mapping

| Cases | Required proof |
| --- | --- |
| AC01–AC05 | Human revision wins over old assistant text; complete-prompt display preference; role isolation; staged recall scope; company names are recall cues, not qualification. T02/T04/T05/T09. |
| AC06–AC09 | Provider tags cannot prove personal implementation; unknown employment differs from complete below-threshold and incomplete history. T01/T06/T10. |
| AC10–AC13 | Remote-only versus unknown onsite willingness; all three-state AND/OR/NOT combinations. T01/T06. |
| AC14–AC17 | Criterion revision expires judgments; a geometry fact changes only geometry; vague feedback does not create global caps; memory CAS/revocation/empty/history. T02/T03/T04/T06/T07/T09/T10. |
| AC18–AC20 | Same provider task continuation, queued/unknown/no blind retry; raw cell/source versus read material; persistent new-conversation/restart adoption. T04/T05/T06/T09/T10. |
| AC21–AC23 | Actual author chain, cancelled/old-card nonexecution and real authenticated owner/space/role/source/memory boundaries. T02/T03/T04/T05/T07/T09. |
| AC24–AC26 | Honest usage scope; expanding recall does not weaken qualification; undefined exclusion lists remain questions/unknown. T04/T05/T06/T07/T08/T09/T10. |

Each task leaves one meaningful failing-then-passing check for its behavior. Contract/core tests cover truth tables; T02/T03 use a genuinely isolated PostgreSQL database with no skipped DB suite; adapter tests inspect actual frozen bytes, request/result ordering and interrupted recovery; Web/mobile test original-card IDs, stale responses and mount-without-mutation. Use existing test files/harness rather than another framework.

Run only checks for the changed boundary. Native desktop E2E belongs to existing CI; do not launch Electron or Docker on the maintainer Mac. Existing container-dependent scripted Web E2E runs in an already available CI environment; fake provider results are not live business acceptance. Mobile screenshot acceptance requires an existing configured simulator; until run it stays unverified. Public tests use synthetic people/roles only.

T10 requires current human-defined role data, actual provider permissions/quota, request bytes before dispatch, real task/result/source evidence and a report of unverified boundaries. It never auto-authorizes outreach, candidate approval or CRM stage changes. Its completion alone does not complete the original CRM/Instantly P4–P6 obligations.

Only the main PLAN.md controls P0–P6 completion. Its native, recruiting-domain, integration and live acceptance gates all remain required; a plan document, schema, green unit test or screenshot alone completes none of the end-to-end product gates.

Current integration check: 29 focused checks across T01 and the native memory loader pass; Web typecheck and independent spec/quality review pass. The broader contracts/core regression run had 1,049 pass and 5 skip before the final new-schema URL guard; the final guard was checked by the focused suite and package typechecks. No database migration, provider search or new UI was executed by this code change. Cloud release is held because the current workspace billing summary shows credit adjustments and positive billed usage; additional deployment is not confirmed covered by existing free credit.

Code commits: T01 `105d8c5`; T03 empty-body subitem `740ca4c`. Neither commit changes the deployed application until a release is performed. The account's two search-confirmation rules and existing recruitment skills were updated separately through native product settings/tools; those configuration changes are already saved.
