# D1: defer optional-page translation catalogs

Draft [#304](https://github.com/WeKruit/rakazo/pull/304) targets
`claude/project-thread-f1cbzk`; it has not been merged by this task.

This follow-up keeps the existing UI and parser contracts. It does not claim the
final 250 KB goal is complete. It builds on `34b9eb587` / `d2ad4af8f`; earlier D1 work
and its measurements remain separate. Ordinary merge `bb10b0f3e` integrates the published
`d4fae3df1` dependency base, including the existing timer and lazy-palette fixes.

## Behavior and scope

The existing full catalog is partitioned into complementary startup and optional-page
catalogs using the official Lingui extractor. The startup catalog covers the current
entry views and shared components; 33 already-lazy top-level pages load their additional
messages through their existing code boundary. Window chrome and the resizable side panel
remain in startup. Indirect developer-sidebar and side-panel boundaries also wait for
messages before rendering dependent pages. No visible contacts, role chat or controls are
hidden, and no schema or authorization behavior changes.

Startup contains 1,421 extracted entries and optional pages 722, with shared messages in
both where needed. This avoids keeping two complete translation catalogs. A comparison
using the official compiler verified the pre-split catalog against the merged result in
all ten locales: 2,006 compiled IDs per locale, zero changed or missing values. Existing
missing translations retain their original English fallback.

`withFeatureMessages` waits for activation before a lazy view renders. Locale switching
loads the required startup and optional catalogs before activating; the existing latest-
selection generation prevents stale activation. An optional view opening during a newer
locale transition waits for that transition too. Target-language failure falls back to a
complete English set. If both fail, the view rejects into its existing loading/error boundary
rather than rendering untranslated IDs. The standalone helper can retry; this does not add
a new retry UI to React's cached lazy-error behavior.

The first optional page opens the combined optional catalog for the current locale. It
therefore loads some other optional-page messages earlier than strictly necessary. The
choice keeps coordination small rather than adding a feature registry. Catalog ownership
is explicit in `lingui.config.ts`; when moving a source across catalogs, retain its existing
translations before extraction. Shared-value tests detect inconsistent duplicate translations.

## Actual Chinese production cold loads

All auth/API responses are synthetic. Same locale, gzip method and page completion conditions
as the preceding D1 measurement scripts; no production or real candidate data.

| Entry | Before gzip bytes | After gzip bytes | After JS / total requests |
| --- | ---: | ---: | ---: |
| Contacts with visible role chat | 347,938 | **339,147** | 7 / 35 |
| One-message authenticated chat | 310,672 | **301,872** | 8 / 39 |
| Signed-out sign-in | 203,469 | **194,711** | 7 / 15 |

Contacts still makes 17 RPC calls and zero duplicate recruiting reads. Request counts are
unchanged. Machine-readable contacts evidence: [d1-catalog-contacts.json](evidence/d1-catalog-contacts.json). Contacts improves by 8,791 bytes but remains **89,147 bytes over 250,000**; chat
remains 51,872 bytes over. This is smaller than the earlier maximal source-subset estimate
because only established optional-page boundaries were split. No schema/runtime migration
or rendering architecture rewrite was attempted.

## Verification

- Web: **1,694/1,694 tests**, 149 files, 35.20 s; web type check and production build pass.
- Existing recruiting routes, cold contacts keyboard/detail/focus, bilingual controls,
  and new optional catalog activation: **15/15**, 40.1 s, real local production Chromium.
- Expanded settings tests switch English → Chinese and Chinese → English while mounted:
  **2/2**, 5.3 s. The optional catalog is absent before opening settings and present after.
- Four new loader tests cover deferred loading, latest-locale races, full English fallback,
  failure without rendering untranslated features and helper retry. Shared-catalog parity
  covers every supported locale. Existing message/translation assertions remain intact.
- Component tests now use the actual Lingui Vite catalog loader. Board/paywall assertions
  wait for their newly real catalog import; their prior access and capability assertions
  are unchanged. Extracted source-origin assertions follow the actual D4 file locations.

Reproduction from the repository root, with matching Chromium installed:

```sh
pnpm --filter @rakazo/web check
pnpm exec vitest run apps/web/src
RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web build
RAKAZO_ALLOW_DEV_SECRETS=1 MEASURE_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec tsx scripts/measure-contacts-load.ts dist
RAKAZO_ALLOW_DEV_SECRETS=1 MEASURE_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec tsx scripts/measure-first-load.ts dist
RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec vite preview --host 127.0.0.1 --port 5202 --strictPort
# Run in another terminal while the local preview is active:
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5202 pnpm --filter @rakazo/web exec playwright test --config playwright.catalog.config.ts
```

The initial conservative experiment deferred only settings and a few routes, saving about
2 KB while duplicating a full catalog. It was replaced by the complementary split above.
An initial component run lacked a PO loader and failed; enabling the same real compiler as
the build resolved it. Initial browser fixtures omitted two settings RPCs; explicit synthetic
responses were added, retaining the no-unknown-RPC assertion. None of these failed attempts
are claimed as acceptance results.

The matched before figures come from the published dependency build (`d4fae3df1`),
including its timer fix. Before that merge, this branch measured contacts 347,873 →
339,039, chat 310,602 → 301,760 and sign-in 203,472 → 194,660 bytes; do not mix the
two baselines. The final table uses the merged build and published dependency baseline.
Deployed Fast4G LCP and other browsers remain untested. See
[D1-250KB-OPTIONS.md](D1-250KB-OPTIONS.md) for further design choices; these results do not
establish that a different rendering stack is necessary or sufficient.

## Second bounded slice: deferred recruiting views

On published integration `f0752e539`, actual chunk/module attribution found 17 recruiting
view/helper sources absent from both the contacts entry graph and its immediately rendered
content. These include CRM history, candidate detail/presentation, scheduling/calendar,
role/summary/legacy views and feedback. Their existing dynamic boundaries now wait for
optional messages; static children are covered by those parent boundaries. The source audit
also checked the recruiting barrel's current type-only consumer. No new feature registry or
UI hiding is involved.

Startup now has 984 extracted entries; the optional catalog has 1,225 (shared IDs appear
in both). Compared with the preceding published catalog build, Chinese cold contacts is
**339,147 → 332,440 gzip B**, chat **301,872 → 295,153**, sign-in
**194,711 → 187,986**. Contacts retains 7 JS / 35 total requests, 17 RPC / zero duplicates;
chat and sign-in retain their preceding counts. This additional 6,707-byte contact saving
is measured, not the earlier maximal catalog estimate. Contacts remains 82,440 bytes above
250,000.

Web **1,694/1,694** (149 files, 31.73 s), web check, production build, all locale catalog
checks, and the same **15/15** production browser cases (40.5 s) pass. Commands are the
same as above. First-stage and second-slice measurements are kept separate. No schema,
authentication plugin, or server behavior was changed in this slice.

## Separate unused web organization-client registration

The web app consumes no Better Auth organization actions, hooks, reflected properties or
organization endpoints. Space membership/selection uses the existing authorized product
RPCs. Removing only the unused browser plugin leaves the server organization plugin,
session client, permission enforcement and RPC behavior intact. A named session-state
interface keeps the controller's exported type portable; session fields are unchanged.

After the second catalog slice, this independently measured change takes contacts
**332,440 → 329,543 gzip B**, chat **295,153 → 292,260**, and sign-in
**187,986 → 185,083**. The 2,897-byte contacts saving is actual route gzip, not the
roughly 13 KB rendered-source attribution that motivated the audit.

Web **1,694/1,694**, web type check and production build pass. A new actual local Chromium
test passes (**1/1**, 3.1 s) through session display, selected-Space request-header change,
logout/selection clearing and login. It observes no organization endpoint requests.
All endpoints are synthetic. The fixed synthetic server verifies client transport, not
server authorization; the existing App/Shell tests still verify scoped state replacement.
No real account was used, no email sent and no server auth configuration changed.

## Canonical link parser boundary (local follow-up)

The existing Linkify parser and its exact rules now live in a canonical leaf;
`markdown.ts` retains its public exports. Initial contexts and URL helpers use a
light shared module. Plain text without a colon or at-sign cannot match the
existing explicit-scheme/email grammar and renders synchronously. Potential
links load the original parser and original link component; no replacement
parser or weaker URL sanitation is introduced. Fullwidth markers conservatively
load the parser. Bare domains remain literal, matching the existing
`fuzzyLink: false` behavior. Pending imports retain visible text with `aria-busy`.

Matched production builds, Chinese locale, synthetic fixtures:

| Cold entry | Before gzip bytes | After gzip bytes |
| --- | ---: | ---: |
| Contacts with visible contacts | 329543 | 325302 |
| Plain-text chat | 292260 | 288026 |
| Sign-in | 185083 | 180756 |
| User message with URL, email and bare domain | 410505 | 411345 |

The linked-message case deliberately waits for both original anchors before
measuring. Its URL and mailto hrefs are unchanged; the bare domain stays literal.
It costs 840 additional bytes from the deferred boundary. This is a reduction
for plain entries, not a claim that every message or route gets smaller.
Contacts retains 7 JS requests, 35 total requests, 17 RPC requests and zero
duplicate recruiting reads. The 250000-byte final goal remains unmet (contacts
75302 bytes above it); linked-message rendering is also above 350000 bytes.

Validation commands:

```sh
pnpm --filter @rakazo/chat-ui check
pnpm --filter @rakazo/web check
pnpm exec vitest run packages/chat-ui/src apps/web/src
VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web build
MEASURE_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec tsx scripts/measure-first-load.ts BEFORE_DIST dist
MEASURE_UI_LOCALE=zh-CN MEASURE_MESSAGE_ROLE=user MEASURE_MESSAGE_TEXT='See https://example.com/path and user@example.com plus example.com' MEASURE_EXPECT_LINKS=2 pnpm --filter @rakazo/web exec tsx scripts/measure-first-load.ts BEFORE_DIST dist
MEASURE_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec tsx scripts/measure-contacts-load.ts dist
pnpm --filter @rakazo/web exec playwright test --config playwright.catalog.config.ts
```

Both type checks and production build passed. Combined web/chat-ui tests:
1852 passed across 158 files (32.23 seconds), including canonical parser parity,
Unicode/punycode/email/protocol/newline cases and actual cold first-link rendering.
The source-isolated baseline uses the previous committed chat-ui package with
identical application/catalog/auth sources; its measured plain-entry values
match the preceding committed results. No deployed LCP or real-user data was used.

Production browser gate: all 16 cases passed in 44.0 seconds, covering real
responsive recruiting routes, contacts keyboard/focus, EN/ZH labels, optional
catalog loading/language switching, and auth/session/selected-space behavior.

Follow-up review: https://github.com/WeKruit/rakazo/pull/307 (Draft, targeting the
#263 branch; this document does not assert it has merged).

## Plain-link presentation follow-up

`link-presentation.web.tsx` now owns the original confirmation context/dialog,
anchor, favicon and website-link components. Both Markdown and plain links use
these same canonical components; the public Markdown exports remain compatible.
Plain links no longer import ReactMarkdown, GFM/CJK parsing or table rendering.
No math/highlighting engine was found in this dependency path.

Matched Chinese cold-message production results (same content and visible links):

| Case | Before gzip bytes | After gzip bytes |
| --- | ---: | ---: |
| User URL + email + literal bare domain | 411345 | 354913 |
| Bot formatted Markdown, link and inline code | 410702 | 411337 |
| Contacts | 325302 | 325328 |
| Sign-in | 180756 | 180757 |

The 56432-byte plain-link reduction is real; complete Markdown costs 635 extra
bytes because its presentation is now shared across a module boundary. Contacts
has no meaningful benefit (+26 bytes), so this does not reduce its remaining
75328-byte distance to 250000. The linked-message case remains 4913 bytes above
350000. All values include loaded dynamic dependencies, not just the entry file.

Commands are the previous measurement command with user text unchanged, plus
`MEASURE_MESSAGE_ROLE=bot MEASURE_MESSAGE_TEXT='**Important**: See [example](https://example.com/path) and code.' MEASURE_EXPECT_LINKS=1` for formatted content
(the measured case used inline-code backticks around code). Both browser cases
waited for the actual anchors before collecting their final asset set.

Further ordinary opportunities are not exhausted: an unopened confirmation
dialog still shares the link presentation module, and some optional chat
controls still contribute startup translations. Their net savings have not been
measured. Neither is evidence that contacts can reach 250000. The visible
React DOM/router, client auth/RPC, Zod validation, Shell state and visible
recruiting controls remain in the loaded graph. Removing them changes behavior;
selective schema API migration or server-rendered/partial-hydration work needs
separate design and parity verification. These are alternatives to study, not
claims that a stack replacement is required or guaranteed to meet the target.

Follow-up validation: web/chat-ui typechecks, production build and Biome passed;
`pnpm exec vitest run apps/web/src/pages/Shell.test.tsx packages/chat-ui/src`
passed all 370 tests in 10 files (31.73 seconds). Existing confirmation,
sanitization, table and Markdown assertions remain intact.

## Closed confirmation and optional chat catalogs

The original external-link alert now loads only after a guarded link click.
`preventDefault()` still runs synchronously, before any import. Pending/error
states cannot open the destination. Cancel ignores a late import. The loading,
error, Refresh and Cancel strings reuse existing translated IDs. A real Chromium
failure test found that retrying the same failed dynamic import remains cached;
the error state therefore offers an explicit **Refresh**, not an ineffective
in-place retry. Refresh reloads the app; clicking the link again still shows the
original confirmation before navigation. It can discard unsent local state, so
it is never automatic from this component; Cancel remains available. The app's
pre-existing idle preload-recovery policy is unchanged.

Eight already-deferred chat/control source modules join the existing optional
catalog: AskCard, message-cards, dialogs, ComputerUpdateProgress, LiveWork,
bot-panel, bot-credentials and ApprovalRulesSettings. Every direct lazy consumer
is guarded, including supplementary recruiting cards. Existing LiveWork's
immediate Starting fallback is unchanged. No content is hidden to avoid loading:
messages containing these controls load the optional catalog before rendering.
All 2006 existing compiled message IDs/translations match the preceding commit
in each of the ten locales (official Lingui catalog API comparison).

Chinese production cold entry, compared with the preceding presentation split:

| Case | Before gzip bytes | After gzip bytes |
| --- | ---: | ---: |
| Contacts | 325328 | 322135 |
| Plain chat | 288026 (preceding parser slice) | 284874 |
| URL + email + literal bare-domain user message | 354913 | 291476 |
| Sign-in | 180757 | 177577 |

The intermediate confirmation-only contacts result was 325418 (+90 bytes), and
links 294762 (-60151 bytes). Optional chat catalogs then reduced contacts by
3283 bytes and links by 3286. The plain-chat baseline is explicitly the preceding
parser slice rather than a newly measured matched presentation baseline.
Contacts keeps 7 JS/35 total requests, 17 RPC calls and zero duplicated recruiting
reads. It remains **72135 bytes above 250000**. A complex message may load both
Markdown and optional control catalogs, so these are fixture-specific results.

Validation: combined web/chat-ui 1854 tests across 159 files passed (32.31s),
including canceled imports and synchronous navigation prevention; both package
type checks and the production build passed. Existing translation concurrency,
fallback, all source coverage, Shell immediate-send and zero-extra-read checks
remain intact. Production recovery is reproducible after asset measurement with:

```sh
MEASURE_UI_LOCALE=en MEASURE_MESSAGE_ROLE=user MEASURE_MESSAGE_TEXT='See https://example.com/path' MEASURE_EXPECT_LINKS=1 MEASURE_CONFIRM_RECOVERY=1 pnpm --filter @rakazo/web exec tsx scripts/measure-first-load.ts dist
```

This synthetic check aborts the alert chunk once during the existing automatic
reload cooldown, stubs external navigation, clicks Refresh, then verifies the
original alert and Cancel after reload. Its output logs recovery separately;
post-reload requests are not included in the cold payload measurement.

Final production browser gate: all 16 responsive route, keyboard/focus, auth,
optional-catalog and bilingual cases passed (43.1 seconds). Biome formatting and
`git diff --check` passed after formatting the newly wrapped lazy imports.
