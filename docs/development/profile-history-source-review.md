# Candidate history source review and local correction

This increment follows the candidate-profile usability checkpoint `c0074f9a35305e1bb187ad79f0d375ab57700f61`. It fixes retained nested report projection and profile rendering. It does not establish that the candidate in the reported screenshot has structured history in Autumn, or that the screenshot came from this branch. The original image could not be downloaded through the supported Library flow in this executor; visual work used the parent's factual pixel review. All test people, organizations, histories, URLs and images are synthetic.

## Confirmed source trace

| Boundary | Code evidence | Finding |
| --- | --- | --- |
| Requested output | `packages/contracts/src/recruiting.ts`, `RECRUITING_CANDIDATE_OUTPUT_JSON_SCHEMA`; `packages/core/src/recruiting-candidates.ts`, output instructions | `candidate_output_v1` specifies name, LinkedIn URL, current title/company, location, resume URL and evidence URLs. No structured experience, education or asset request is established. Extra columns are permitted. |
| Provider result | `packages/adapters/src/recruiting-research.ts`, `classifyRecruitingResearchResult` | Rows are retained as unknown values. No history flattening occurs here. |
| Durable artifact | `packages/adapters/src/recruiting-tools.ts`, read snapshot; `packages/core/src/recruiting.ts`, `readRecruitingResearchReadArtifact` | Raw provider result and observation are saved with immutable artifact identity/hash. Reading verifies task/action/output continuity. |
| Normalized occurrence | `normalizeRecruitingCandidateRow`; candidate occurrence database model | Identity/current-role fields are normalized separately. They are not a rich-person record; the original row remains in its artifact. No new table is needed for this display correction. |
| Scoped report read | `createRecruitingCandidateReportReader` | Checks actor access, artifact hash, role/task/action/revision/effect/cursor/output/row index; returns `{row, report}`. This is the existing exact raw-row inspection boundary. |
| Report projection | `projectRecruitingCandidateReport` before this increment | Scalar values survived; nested objects and object arrays were omitted. This is a definite Rakazo loss independent of whether the specific candidate contains those fields. |
| CRM profile | `storedProfileFields`, existing CRM history contract and CRM sync delivery document | Existing `title/company/start/end` records were flattened then reparsed. Long text/punctuation could defeat that parser. No structured education contract was found in this CRM profile shape. |
| UI | `candidateSections`, `ProfileTimeline`, `CandidateDirectory` | `Employer descriptions` was not explicitly classified as Experience. A long narrative cannot be separated reliably without its exact source syntax or structured records. |

## Implemented behavior

- The report contract carries JSON structured values, source IDs and source URL maps. Existing scalar fields and native assessment statuses keep their meaning. Original artifacts are unchanged. The existing business/diagnostic key boundary now applies recursively; source IDs remain provenance and are excluded from recruiter-facing source text.
- Known CRM history records render directly without delimiter guessing. A proposed explicit rich-profile interchange shape is supported by the renderer (below); this is not a claim about Autumn's current field names or serializer. Unknown shapes remain inspectable source text without invented jobs, degrees or skills.
- Each supported job has its role, employer, supplied dates/location, separate description and exact source links. Each degree has its own row, including multiple degrees at one institution. Research appointments stay work. Missing degrees/dates stay missing. Explicit `is_current: false` contradicting `end_date: "Present"` preserves the words but does not produce a confirmed current tenure.
- Supplemental unstructured narratives collapse only when structured rows exist. Independently parseable dated text records remain visible and contribute to the existing union of employment ranges. Full business source text stays available; operational metadata stays in the original artifact/owner diagnostics.
- Supplied company/school URLs and logos are used directly. Exact matching organization names can reuse an unambiguous supplied image between list/detail and same-school degree rows. No name-to-logo lookup or guessed URL is introduced.
- Clickable skills include the actual mapped history descriptions and their source context as profile mentions. This does not turn a mention into a requirement match or change ranking.
- Contacts prefers the mapped school/degree summary over the long education narrative.

The only added presentation labels reuse existing localized `Description` and `Source text`. They are collapsed disclosures so full evidence remains available without putting every long paragraph in the primary timeline. No new dependencies, requests, provider configuration, database migrations or production activation were added.

## Upstream handoff: proposal, not a supported request yet

[Autumn outputs](https://www.autumn.ai/docs/concepts/outputs) describes retained rich output and sourced cells. [Structured output](https://www.autumn.ai/docs/guides/structured-output) documents a flat schema of primitive/list-of-primitive fields. These are different capabilities. **Do not append `list[object]` history fields to the public flat schema without a verified supported rich-person/export protocol.** This increment intentionally does not change `candidate_output_v1`, its normalization, or launch a search/enrichment call.

The separate Autumn owner should first inspect the existing saved person/output record and confirm its serializer, identity, source map and read protocol. Then map the observed shape or agree this minimal interchange:

| Object | Proposed fields |
| --- | --- |
| Person | Stable person/LinkedIn identity; `profile_image_url`; `experience`; `education` |
| Experience entry | `title`, `company_name`, `company_url`, `company_linkedin_url`, `company_logo_url`, `location`, `start_date`, `end_date`, `is_current`, `description`, `source_urls` |
| Education entry | `school_name`, `school_url`, `school_linkedin_url`, `school_logo_url`, `degree`, `field_of_study`, `start_date`, `end_date`, `description`, `source_urls` |
| Provenance | Existing `{value, source_id}` cells and `_sources`; preserve actual source IDs and supplied URLs |

Use null/absence for unknowns, preserve original date precision, and keep each appointment/degree separate. A missing end date is not proof of current employment. Use only actually stored asset URLs. Do not invent dates, credentials, logos or source links, or infer degrees from university employment. Fixtures exercise these proposed names and the established CRM shape; they do not verify an upstream response.

**Still unknown:** whether the actual record has structured history/assets, whether a rich-person export is already available, and whether a specific logo URL is absent, expired, denied or otherwise failing. If the exact saved row contains only prose, this increment retains that prose; it deliberately does not hide the upstream gap with an unverified text parser.

## Read-only inspection recipe for the existing owner

No such live read was executed by this task. Use the existing authorized environment and actor/role, not another worker's files or credentials.

1. Resolve the candidate from the current role using the existing `recruiting_candidates` list/resolve operation. Preserve its exact candidate key and role. Do not guess from a similar name.
2. Call its existing `sources` operation with `candidateKey`, optional cursor/limit. Record the exact artifact version ID/hash, row index, task/action/revision/effect/cursor/output identities locally. These are diagnostics, not product labels or public PR content.
3. Prefer the existing `createRecruitingCandidateReportReader` with that actor/role/source. Inspect the returned `row` locally after its ownership/hash/continuity checks; compare it with `report`.
4. If using native `artifact_read`, pass the exact artifact version ID. For JSON without a selected string, page original text with offset/limit and follow `nextOffset` until `hasMore` is false; offsets count code points. `jsonPath` can select a decoded string, **not an object row**. Alternatively materialize exact saved bytes using the already authorized native artifact/file path and inspect locally. Keep hash/identity verification intact.
5. Report only field names/types, entry counts, present/missing asset fields and provenance coverage. Do not paste candidate PII, signed URL credentials or raw private rows into chat or this public repository. Retain an anonymized structural fixture if permitted.
6. If fields are absent in this saved row, the Autumn owner may inspect the already stored rich person/output by its verified IDs using the existing read-only path. Do not run create/continue/reply/search/enrichment to answer a storage question.

## Logo diagnosis

There is no LinkedIn-host denial in the inspected UI. Explicit HTTPS URLs without embedded credentials pass `profileImageUrl`; `ProfileImage` renders a normal image with `referrerPolicy="no-referrer"` and falls back to initials on error. It makes no logo-service lookup or proxy request. A changed URL can be retried; a failed image does not loop.

The local browser test intercepts a synthetic `media.licdn.com`-shaped URL and proves the supplied URL reaches a loaded image. A separate simulated 403 proves fallback. Neither is evidence of the actual candidate's response. [LinkedIn Images API documentation](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api?view=li-lms-2026-08) documents expiring download URLs; that is a general possibility, not a diagnosis of this incident.

## Validation and acceptance status

| Requirement | Code | Local evidence | Owner/live acceptance |
| --- | --- | --- | --- |
| Retain nested observations and provenance | Implemented | Raw fixture → report projection → JSON serialization → contract → sections/timeline tests | Exact candidate record pending |
| Work and education breakdown | Implemented for supported structured shapes | Five work and three education entries; two degrees at one school; long descriptions; missing fields; research-work distinction | Plain-only source remains unsplit; upstream shape pending |
| Supplied logos/links, consistent list/detail | Implemented | Loaded intercepted image, exact links, simulated 403 fallback, Contacts school summary | Actual assets/request response unknown |
| Clickable skill context | Implemented | Mapped description and original source link; no inferred assessment | Actual record pending |
| Responsive/keyboard presentation | Implemented | Actual App/Shell route at 1440×900 and 390×844; description keyboard toggle; six screenshots | Parent reference comparison and combined CRM route review pending |
| Auth/owner isolation | Existing read boundary unchanged | Existing report-reader regression suite included | No live or new native DB verification in this increment |

Final focused command from the repository root:

```sh
node_modules/.bin/vitest run packages/core/src/recruiting-candidates.test.ts packages/adapters/src/recruiting-research.test.ts packages/contracts/src/recruiting.test.ts apps/web/src/pages/recruiting/profileHistory.test.ts apps/web/src/pages/recruiting/ProfileTimeline.test.tsx apps/web/src/pages/recruiting/DetailPanel.test.tsx apps/web/src/pages/recruiting/tabs.test.tsx apps/web/src/pages/recruiting/profileAssets.test.ts apps/web/src/pages/recruiting/CandidateDirectory.test.tsx apps/web/src/pages/recruiting/profile.test.ts apps/web/src/pages/recruiting/profileTimeline.test.ts --maxWorkers=2
```

Result: **274/274 passed across 11 files**, 17.67 seconds. `tsc --noEmit` passed for web, core and API. `NODE_ENV=production node_modules/.bin/vite build` from web passed in 12.13 seconds; existing large-chunk warning remains. Biome checked all 15 changed TypeScript files successfully. `git diff --check` passed.

Browser command: `node_modules/.bin/playwright test --config <local-profile-history-config>` from web. The local config uses the existing Chromium binary, a loopback Vite server, one worker, `testMatch: "profile-history.spec.ts"`, and a local screenshot output directory. All RPC/auth/asset responses are synthetic/intercepted; unexpected RPCs and page errors fail. Final browser result: **2/2 passed**, 14.9 seconds. Screenshot hashes and exact local runner configuration are in the accompanying delivery manifest.

Earlier failed checks are not suppressed: a direct undeclared `zod` import failed and was removed in favor of the existing contract schema; three scalar-only expectations were updated for retained nested values; an obsolete DetailPanel assertion expected unknown saved history to disappear and now verifies that it remains in collapsed source text; a skill-evidence union type error was fixed; one regression caught over-filtering of entry source IDs and was corrected. Their final focused runs pass. No new dependency was installed. A final diff review removed an unintended normalization wrapper so the existing identity normalization remains unchanged; its core regression suite was rerun. Independent read-only review confirmed all four follow-up findings were addressed.

## Integration and remaining checks

Apply this increment over `c0074f9a35305e1bb187ad79f0d375ab57700f61` or reconcile only its stated files onto the CRM integration head. Shared contract/core hunks are `RecruitingCandidateReportSchema`, the shared metadata-display predicate/source-text helper, and `projectRecruitingCandidateReport`. `CandidateDirectory` changes only the school summary/asset selection. No API/DB/schema migration, Shell routing, canonical role binding, Inbox adapter or scheduling code is changed.

Before acceptance:

- Confirm the actual saved row and upstream serializer with the existing owner; record whether the missing data was stored, returned, mapped or absent.
- Reconcile the proposed interchange with the verified upstream shape before promising automatic history delivery.
- Run combined CRM route/type/regression checks and inspect the new screenshots against the original references. The older branch's parent chrome and narrow default drawer are known integration issues; these focused captures do not claim those are fixed.
- Preserve the integration owner’s already recorded native PostgreSQL profile-view results; the producer did not run those checks in its separate environment. This increment adds no database or event changes and does not invalidate the earlier integrated evidence.
- Review with the original handoff owner. Do not mark the product fully fixed or live from synthetic fixture success.

No remote branch/PR was published: the previous external-hook audit returned 403, so deployment side effects remain unexcluded. This is a local text-patch handoff. No merge, deployment, production read/write, paid provider call, outbound message, CRM sync, resource, credential, webhook or subscription was activated.

## Combined integration checkpoint

Integrated on top of `19dfb3c34d9cd3e8bb666a93bec23f4f23de6834`, preserving the unified 600px responsive detail wrapper, existing route composition and scheduling safety correction. Two patch conflicts were reconciled: report projection retains page-aware score normalization alongside structured values; the shared browser fixture retains scheduling/campaign options alongside the new report fixture. The producer patch was reconstructed from complete Library text pages and matched its declared 83,212-byte size after supported binary materialization failed.

The focused combined run passed 288 checks across the same 11 files (counts differ from the producer because this integration includes additional existing regressions). Parent reviewed the producer’s structured row captures positively, but those older captures used its narrow wrapper; final combined screenshots are separate. Neither capture establishes the actual candidate’s saved shape, actual logo availability, or live deployment status. The original `19df` artifact remains immutable.

Final combined validation: web and API TypeScript passed; production web build passed with the existing large-chunk warning. The final actual-route run passed 2/2 (desktop 1440×900 and mobile 390×844) with six fresh captures. The Education capture now waits until its heading enters the viewport instead of capturing during smooth scrolling. An intermediate rerun timed out waiting for the Experience button while files were being edited; the clean final rerun passed, and the failed run is not reported as a pass. Screenshot inspection confirmed the combined 600px desktop wrapper and separate mobile degree rows. No scheduling, API, database or route source changed in this increment.
