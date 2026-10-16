# Recruiting product implementation — T01–T10

Status: this workstream is part of [PLAN.md](PLAN.md) and the larger [full product scope](PRODUCT-SCOPE.md), not the entire Goal. Production source `3d8ee97` adds first-JD native material receipts, standard JobPosting reading and the raw research-snapshot bridge. Real JD bytes/hash and their survival across container replacement are verified, but normal JD role creation still fails and is not accepted. Raw research views have offline checks, without live domain-task result acceptance. The latest generic Ask continuation is not accepted: the original card/run/goal and a 37-unit raw answer survive replacement, but Main repeats its question instead of completing the request. The earlier T07 native question bindings, partial reassessment, saved-candidate Cards/Table and authorized message navigation remain available. One synthetic-profile path is live-accepted: panel selection → second question in the same run → actual container replacement while waiting → custom answer on the original card → one reassessment to version 3, preserving unchanged sources and employment judgments. Normal role-description creation/binding and assessment save/reload/read also have narrower live evidence. First JD URL intake, role-definition revision acceptance, full material extraction, preference lifecycle UI, unevaluated research results and T09–T10 remain incomplete. Two historical executing test receipts remain explicit recovery-audit gaps; later successful runs do not close them. Cross-new-run research read receipt recovery has reviewed code, while live provider recovery acceptance remains open. See PLAN.md for current deployment/check details and historical releases.

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

Known implementation gap: generic role source references currently validate native source access and Artifact identity/hash, while exact material quote/selection validation is implemented for assessments. A native reader receipt proves retained bytes; it does not make every model-authored role quote server-verified. Reuse the existing assessment material checks at the shared role mutation boundary when closing this gap, keeping human intent authorization separate from external JD content.

Source access follows enduring native owner/space/chat authorization, rather than a thread's current role selection. Changing roles cannot invalidate an authorized historical source or creator run. New runtime writes still require the selected role, and role revisions/tasks/assessments cannot borrow another role's identity. A run-owned Artifact resolves its actual run thread before checking native bot/group association; selecting an arbitrary thread of the same bot is incorrect.

Criteria are atom/all/any/not, priority hard/preferred. Verdicts are met/unmet/unknown. Hard gates are AND; preferences or provider-qualified labels never compensate for a missing hard requirement. Missing facts and proven noncompliance remain different. Experience counting uses the role's defined employment/date/cutoff rules and interval union, with incomplete history or imprecise boundary months explicitly unresolved.

## Native memory lifecycle

Semantic intent distinguishes role changes, one-round recall scope, candidate facts and reusable preferences. No regex decides durable preference or qualification intent. Explicit changes save a receipt; ambiguous wording asks only for the missing definition.

Reuse MemoryStore.commit(expectedRevision) and MemoryRevision. Carry the loaded revision through Web, RPC and tool calls; a last-moment read of the newest revision does not protect previously prepared text. Empty-body replacement revokes the last preference without deleting history; filter empty documents before constructing any heading/path. Authorized history reads preserve source run/thread. User-scope Markdown memory is same-user/space cross-bot memory, not organization sharing.

Immutable context adoption records contain the actual role/revision, actor/run/thread, injected memory revisions/hashes, used/truncated fragments and scope. Revocation affects future adoption, not historical records. Role requirements do not enter the truncatable long-term-preference pool.

## Tasks and dependency order

| Task | Deliverable and existing implementation boundary | Status |
| --- | --- | --- |
| T01 | Shared contracts/core DTOs, three-state truth tables, source/read consistency and closed adoption/action event payloads; no generic MessageBlock extension. | Contracts/core code and focused checks reviewed; deployed with the `6554c46` domain baseline |
| T02 | Five records and Thread/Run binding in existing Prisma/Postgres; authenticated create/bind/workspace/revise/assessment/research RPCs, immutable revisions, transactional CAS and source ACLs. | Shared DB/API code deployed with `6554c46`; migration applied only to the independent product database, not CRM; new domain paths still need live acceptance |
| T03 | End-to-end native memory CAS, empty-body revocation/filtering and authorized revision history; reuse current store. | CAS/revocation/history and adoption code deployed with `6554c46`; new lifecycle UI acceptance remains open |
| T04 | Native recruiting_role/recruiting_feedback tools, semantic intent/source verification, current role adoption across send/steering/handoff/restart; exact context Artifact. | Role/context adoption, feedback/native preference guards and ordinary Ask-answer provenance have code; deployed with `6554c46`; preference-source editing and complete acceptance remain incomplete |
| T05 | recruiting_research prepare/start/status/rows/continue through current MCP discovery/effect execution; frozen request, cross-run action identity, real task mapping and uncertain-result recovery on both API and worker. | Native action/receipt code deployed with `6554c46`; cross-new-run read mapping and lease-bound dispatch implemented/reviewed in `2cfb909`, live recovery acceptance still open |
| T06 | Raw material → sourced facts → per-criterion judgment → deterministic hard gate; qualified-month union/precision, source-quote validation and immutable assessment. | Deployed typed-source assessments and deterministic combinations/month bounds; synthetic save/reload/read/restart and partial reassessment accepted. Full material extraction and real numeric-rule acceptance remain open |
| T07 | Persistent definition/fact questions bound to original ask; new facts update only dependent judgments, revised criteria expire old assessments; external follow-up stays on the real provider task. | Deployed with original-answer source metadata in `6db30b2`; two consecutive original cards, selection/custom answer, actual pending restart and one partial reassessment accepted on one synthetic profile. Role-definition revision and real provider follow-up remain open |
| T08 | One native recruiting panel with five views; corresponding mobile route, typed assessment renderer and original-card custom answer; shared contract/API. | Five Web views, saved-candidate Cards/Table, selection/refresh, authorized original-message navigation and original-card answers deployed and narrowly accepted. Raw research snapshot reading is deployed with offline checks; live domain-task rows acceptance, editing, full workspace and mobile remain incomplete |
| T09 | Deterministic end-to-end, real isolated Postgres, owner/space/role/source boundaries, concurrency, restart/unknown and UI checks mapped to AC01–AC26. | Focused offline and real isolated Postgres checks exist; complete AC01–AC26 end-to-end/live acceptance remains open |
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

## Historical implementation and verification records

The following entries describe their own earlier batches, including temporary holds and then-open implementation boundaries. Current production status and remaining gaps are recorded at the top of this document and in PLAN.md; later deployments do not retroactively extend an earlier test's evidence.

Previous T02/T03 integration check: 248 focused checks across 17 files pass, including 22 real isolated Postgres checks with no skips. Two additional targeted native authentication/resource-isolation checks pass; the remaining 23 cases in that filtered suite were deliberately not selected. API/testkit typechecks pass; worker checks also cover adapters/memory/Web/DB. Independent spec and quality reviews pass for T02 and the T03 slice. One new migration was applied only to a fresh local test database; no provider search, production migration, browser/Electron UI acceptance or paid deployment was performed.

The native `read_memory` tool returns complete content and revision, including empty revoked documents. `remember` and `save_shared_memory`, Pi argument translation, scripted writes, imports and Web saves retain the revision used to prepare their content. Conflicts return the live revision without silently upgrading the stale draft. History retains original run/thread references. The existing shared transaction helper now also handles the installed pg adapter's direct serialization/deadlock error shape, bounded to its existing three attempts; application conflicts and unrelated errors are not retried.

Cloud release remains held because the last checked workspace billing summary showed credit adjustments and positive billed usage; additional deployment is not confirmed covered by existing free credit. These code checks do not complete the cloud product or P6 acceptance.

T04 role/adoption slice reuses the native tool/effect and Artifact/event paths. The runtime, rather than model arguments, supplies the actor, run, thread and human message. Atomic guards reject foreign, cancelled, outdated or agent-authored mutation sources. The first run revision stays frozen; later adopted current versions append ref-only events. Exact role text and the included/redacted memory fragments are stored with revisions/hashes and native scope. Current role conditions remain verbatim under context pressure. Revoked memory affects a new adoption without rewriting old snapshots.

Completed domain receipts are persisted before snapshot materialization. Restart or a lost-claim race recovers the current delivery without repeating creation. A cleared role drops the previous delivery Artifact. Steering records its actual injection target separately from human mutation authority. Pi's existing schema conversion now preserves local recursive definitions instead of advertising an expression as a string. This is code-level acceptance, not provider application or cloud UI proof. Failed/duplicate snapshot uploads are retained rather than unsafely deleting a possibly shared blob; storage cleanup remains a documented limit of the current ArtifactStore contract.

This T04 slice passes 379 focused checks across 19 files, including 19 real isolated Postgres checks with zero skips. Native Pi validation accepts the recursive role input; the shared schema/provider-envelope regressions pass. Contracts/DB/adapters/API/worker typechecks, Biome on the 21 changed code files and independent spec/quality review pass. No new migration, live provider request, production database change or paid deployment was performed for this slice. Full T04 and P6 remain incomplete.

The second T04 batch implements strict four-target feedback. Role, round and candidate results are explicitly recorded proposals in the native completed ExternalEffect receipt; they do not claim an Action or Assessment changed. Reusable preferences use exact UTF-16 span edits through the existing MemoryStore, preserving unrelated text and the loaded revision. Generic recruiting memory tools enter the same handler, including native routing when a semantic provider is configured; no second semantic copy is saved.

The native memory transaction checks the live run/binding, actual human source, scope, CAS and server-constructed body, including direct scripted commits. It commits document, revision and a sourced memory.revised event together. The event contains operation, old/new anchors and actual source. An accessible newer recorded source blocks older input; a missing or legacy prior source is explicitly unverified rather than invented or allowed to permanently lock the owner's document. Both original-tool and underlying-memory approval rules and disabled capabilities remain enforced. Unexpected read/commit failures retain the native uncertain-effect path rather than a fabricated completed failure.

Second-batch verification: 527 focused checks across 26 files, including 40 real isolated Postgres checks and zero skips; independent spec and quality review pass. No migration, live search, production database change or new paid deployment was performed. T05/T06 still owe applying round/candidate proposals to actual records and provider tasks.

The next slice gives ordinary Ask answers native human provenance. Card clicks create a genuine human Message with the visible choice label or exact custom answer; composer sends reuse their existing Message, including one answer serving several waiting runs. A closed ref-only `thread.choice` receipt binds the authenticated answerer, original card/block, answer Message and original run in the same transaction. Approval and secret cards never produce this ordinary-answer authority.

The shared source guard verifies those records, selects the latest authenticated answer and matches the quote against that human Message. It supports delegated bot origins and routines without an original message, while rejecting foreign/unclaimed hints and stale input behind newer claimed steering. Executor source retention uses native message order so old completed receipts cannot replace newer human input. Preference UI/current-anchor rebasing and full T04 cloud acceptance remain incomplete.

Ordinary-answer integration verification: 700 checks across 28 files pass with zero skips, including 75 real isolated Postgres checks (41 domain, 20 memory commit, nine context adoption and five memory API). API/worker typechecks, Biome on ten changed code files and independent spec/quality review pass. No migration, live search, production database change or paid deployment was performed. These results establish code-level recovery and provenance, not new cloud screenshots or provider application.

Code commits: T01 `105d8c5`; T03 empty-body subitem `740ca4c`. Neither commit changes the deployed application until a release is performed. The account's two search-confirmation rules and existing recruitment skills were updated separately through native product settings/tools; those configuration changes are already saved.

## T06 next implementation boundary

Reuse the current five records and JSON fields; there is no new harness, service or table. The live independent product database had no assessment rows before this contract transition. Replace the assessment DTO and update all readers/fixtures together, without fabricating historical conversions.

- Keep typed statement/employment/history-completeness facts and exact source selections: native message text block, text Artifact, or a string field in a JSON Artifact, plus non-trimmed UTF-16 offsets and quote. Artifact ownership alone does not establish original-material provenance; provider snapshots remain provider reports.
- The agent supplies semantic atom judgments; the shared server evaluates the existing AND/OR/NOT tree and hard gate. Employment rules come only from the adopted role with explicit counting and cutoff semantics; current 5+ and historical 84-month cases never become a global threshold. Preserve calculation inputs/results for later partial reassessment.
- The native assessment adapter loads authorized Artifact bytes through the existing store. The DB save separately verifies current run/thread/role/adoption/CAS, source metadata/hash and actual selected text, then saves the immutable assessment and native effect recovery receipt atomically. No caller-supplied aggregate conclusion.
- Acceptance covers source-kind/quote/locator/hash, foreign or deleted sources, JSON escaping and emoji boundaries, typed dates/overlap/incomplete history, unknown logic, stale revision, cancellation and commit-success/ack-loss replay. Binary material requires an existing authorized extraction result before text evidence can be claimed.

These are implementation requirements, not a completed tool or live assessment claim.
