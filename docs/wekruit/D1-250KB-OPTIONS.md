# D1: options for the final 250 KB goal

This is a design decision record, not an implementation or a claim that 250 KB is
achievable with the changes below. The current Chinese cold-entry measurements after
`d2ad4af8f` are contacts **347,873 gzip bytes**, chat **310,602**, and sign-in
**203,472**. Contacts retains its visible directory and role chat, 17 RPC requests,
and zero duplicate recruiting reads. Its gap to 250,000 bytes is **97,873 bytes**.
The first-stage 350,000-byte budget passes; the final goal and deployed LCP remain open.

## Catalog investigation

The installed Lingui Babel macro was applied to the web source modules present in the
measured contacts loading graph. This counts all messages in those source modules,
including callbacks and error text, rather than only currently visible DOM text.
The existing official `createCompiledCatalog` API compiled the Chinese subsets:

| Scope | Message entries | Compiled JSON gzip bytes |
| --- | ---: | ---: |
| Entire catalog | 2,006 | 31,410 |
| Union of initially loaded source modules | 337 | 5,876 |
| Remaining candidate messages | 1,669 | 26,454 |

The difference between the first two rows is **25,534 bytes**. This is a diagnostic
estimate, not a measured production bundle saving or a strict bound. The actual full
Chinese production chunk is 31,448 bytes. Additional loader code, shared messages,
source ownership, compression and feature boundaries will affect the net result.
The subset is a starting point for coverage review, not a ready-to-ship catalog list.
Independent subset gzip sizes are not additive.

The smallest supported approach would use multiple catalog definitions with
`include`/`exclude` in the existing Lingui configuration, aligned with existing base,
recruiting, settings and deferred-feature modules. Preserve message IDs and translations
for all ten locales. Load compiled catalogs through the existing singleton with
`i18n.load`, and wait for both a feature's code and its messages before rendering it.
Do not add a runtime message compiler or display untranslated IDs while loading.

The existing `activationGeneration` must cover the complete locale transition: load
all catalogs needed by currently mounted features before activating the selected locale.
A stale request cannot activate a locale or overwrite saved preferences. Opening a feature
concurrently with a locale switch must join the current transition. If a required target
catalog fails, load the complete required English set and activate it together, rather
than displaying mixed locales. Keep base loading/error messages available independently;
preserve the existing final failure behavior if English also fails.

Acceptance would cover every locale, direct cold contacts/chat, first feature activation,
locale switching with mounted deferred views, concurrent opening/switching, out-of-order
loads, retries and both target/English failures. Check visible labels, ARIA names and error
text, as well as actual route bytes. Extraction coverage must catch new feature messages.
The current implementation has one catalog per locale and already protects latest-selection
activation; feature coordination is additional project work, not something Lingui supplies
automatically.

Sources: [Lingui catalog configuration](https://lingui.dev/ref/conf),
[dynamic catalog loading](https://lingui.dev/guides/dynamic-loading-catalogs), and
[Core API catalog merging](https://lingui.dev/ref/core).

## Action-only boundaries

A read-only review identified recruiting actions such as CRM reply drafting, candidate
feedback/discussion, sequence saving and opening/sending to a role conversation. The
selected source sections independently gzip to roughly 6.2 KB; this is not net route
savings. Creation and message-network actions provide further candidates, but most of
their dependencies are already shared. A few KB to approximately 10 KB across several
boundaries is an investigation estimate, not validated savings.

Retain synchronous optimistic messages, Starting feedback, busy state, notification user
gestures and context-only discussion behavior before awaiting code. Capture the intended
user/space/thread/revision and recheck current-action tokens after loading. Preserve upload
retry identities, cancellation, focus guards and no-extra-read guarantees. Moving whole
hooks merely to a different file does not provide a loading boundary.

## Zod Mini is a public API migration

The actual contacts graph contains 19 Zod modules with **238,183 rendered source bytes**.
Largest contributors include core schemas (70,772), classic schemas (45,070), JSON-schema
processors (24,833) and JSON-schema conversion (15,596). These are pre-compression source
contributions, not separately attributable production gzip costs.

For another diagnostic, the complete source of each of those 19 modules was individually
minified and then concatenated: 157,420 raw bytes / **38,787 gzip bytes**. Complete source
includes code removed by production tree-shaking; compression across the actual main chunk
also differs. This number is neither actual embedded gzip nor a strict savings ceiling.
Mini still needs a parser and other runtime code, so deleting the entire number is not a
valid expected benefit.

Installed Zod 4.6.2 classic constructors attach JSON-schema processors; the base instances
expose `toJSONSchema` and Standard Schema JSON input/output methods. Named imports alone
cannot remove reachable public methods. Aliasing processors to stubs or deleting methods
would change behavior and is not proposed.

An official Mini migration would include these canonical schemas and consumers:

- `auth.ts`: replace chained omit/strict/transform construction and web/mobile `.or()`
  consumers while preserving current and legacy capability validation.
- `thread-message-metadata.ts` and `ids.ts`: ReplyPreview optional/nullable composition.
  The source audit found 84 Id method calls across ten contract files, including domain,
  RPC, events, board, history and recruiting contracts.
- `computer-commands.ts`: RPC extends ComputerCommand with a creation timestamp.
- `reactions.ts`: retain the exact enum and parsing behavior.
- `recruiting-employment.ts`: preserve strict objects, real-calendar refinement, readonly
  results and discriminated unions; update nested optional/nullable composition. The
  editor currently validates synchronously to disable invalid submission, not only on save.

Check ORPC input/output inference and runtime validation, mixed classic/Mini nesting,
JSON-schema generation, error types/issues, unknown-key handling, transforms, readonly
results and date behavior. Mini's default error text differs; explicitly preserve the
current error locale. Avoid parallel browser-only schemas that duplicate canonical rules.
A real parity matrix and production build are needed before estimating net savings.
See the [official Zod Mini API](https://zod.dev/packages/mini).

## Decision options

1. **Continue bounded optimization within current interaction boundaries (recommended
   next experiment).** Implement feature catalog loading first, then independently test
   action-only boundaries. Preserve all visible content and authorization. Expect measurable
   progress, but do not promise 250 KB. Even optimistically removing the entire diagnostic
   38.8 KB of Zod, approximately 25.5 KB of catalog and 10 KB of actions would total only
   about 74 KB, less than the present 97.9 KB gap; these estimates are not additive proofs.
2. **Commission a canonical schema/runtime migration design.** Prototype official Mini
   with explicit public API, ORPC and error parity before changing production contracts.
   This is broader shared-package work with unmeasured benefit, not a simple import edit.
3. **Commission a rendering architecture study, such as SSR or partial hydration.**
   Determine whether less client code can initialize while retaining the same visible
   contacts and chat functionality, isolation and event behavior. Assess server/runtime,
   deployment, hydration and navigation costs separately. No production or cloud change
   is authorized by this document, and no evidence establishes that replacing the stack
   is necessary or sufficient.

No larger implementation was started during this read-only investigation. The decision
should distinguish incremental progress from a commitment to the final byte target.

## Updated measured ownership after chat/catalog boundaries

The latest local Chinese contacts fixture is **322135 gzip bytes**, leaving
72135 bytes to 250000. Its seven actual downloaded JS assets are:

| Asset responsibility | Actual gzip bytes |
| --- | ---: |
| Main application/runtime/auth/RPC | 157099 |
| Shell, transcript/composer state and query cache | 105498 |
| Visible recruiting directory and its model | 41921 |
| Startup translations | 12406 |
| Shared Input/icon factory | 4271 |
| RoleSetup | 512 |
| Bundler runtime | 428 |

Module-level ownership below comes from the immediately preceding confirmation
build's `generateBundle` module records. These are **rendered source bytes**, not
compressed contributions; cross-module minification/compression means they cannot
be subtracted from the gzip budget. Optional catalog changes affect translation
assets and guard calls, not these dependency identities.

- Main: React DOM 460027, Zod 238179, React Router 94927, tailwind-merge 55956,
  better-auth 30242, better-fetch 23509, ORPC client 19805 rendered bytes.
  React DOM currently renders/hydrates the entire interactive app; Router handles
  direct navigation and nested route state; auth/RPC establish this session and
  scoped reads. None is an unopened-feature import. Zod remains used by canonical
  validation, so dropping it or treating schema constructors as globally pure
  would alter the guarantee rather than defer an unused feature. This does not
  prove every byte of those libraries is irreducible.
- Shell: local web code 387718, core 107470, query-core 61796 rendered bytes.
  The largest source modules are controller 41134, conversation 33673, Composer
  32198, recruiting hook 31505, Transcript 21558, Shell 21407, navigation 19542,
  thread hook 18277, roster hook 17367 and message hook 14315. Transcript,
  composer, navigation, subscriptions and query state are active on this route;
  postponing all of them would remove visible controls or move real work outside
  the measurement. Some callback bodies are ordinary remaining split candidates:
  drafting replies, feedback, sequence saves, and group/bot creation. Earlier
  read-only selections estimated a few to roughly 10 KB net potential, not an
  actual saving; synchronous send echo, busy states, revision/space guards and
  post-import cancellation must remain eager.
- Recruiting: web code 156458 and Base UI 64355 rendered bytes. The active
  workspace hook is 32451, CRM wrapper 20978, CandidateDirectory 18717, profile
  model 14038, ContactsTab 12841, EvidenceTab 12675, timeline model 10798 and
  quickOutput 10145. `candidateSections` is called by the visible directory and
  ContactsTab, and uses quickOutput and profile timeline normalization; those
  imports are not merely a closed detail panel. Tabs and checkboxes are visible
  controls. Hook action bodies still mix with read/model code and can be studied
  separately; whole-module deferral would change this cold page.

Concrete choices, with no promise that any one reaches 250 KB:

1. Continue ordinary action-engine extraction, preserving synchronous feedback,
   gesture-sensitive operations and stale-context guards. This is the lowest
   architecture risk but the existing estimate is much smaller than 72 KB. It
   needs delayed-import race tests and matched route measurements, not just a
   source-size subtraction.
2. Design a canonical schema/runtime migration (for example selected Zod Mini
   schemas), preserving full input/output/error behavior and ORPC Standard Schema
   integration. The earlier Zod diagnostic gzip is not removable in full: Mini
   retains runtime validation and current callers use classic fluent APIs. This
   is a cross-package compatibility project, not a browser alias or validation
   bypass; net savings remain unmeasured.
3. Study a narrower rendering/runtime architecture for the authenticated shell
   (server-provided initial view with selective hydration, or lighter controls
   where equivalent accessibility can be demonstrated). This affects routing,
   auth bootstrapping, subscriptions, focus/keyboard and interactive readiness.
   A prototype must measure the same visible interactive page, including all
   hydrated code, rather than hide controls or postpone them past measurement.
   No current evidence establishes a required framework replacement or a numeric
   saving for this choice.

The safe ordinary work completed here includes real dormant dependency removal,
not just repackaging. Remaining opportunities have been distinguished from
currently active requirements; this is not a claim that bundle analysis is
exhausted or that SSR is mandatory. Deployed Fast4G LCP remains unmeasured.
