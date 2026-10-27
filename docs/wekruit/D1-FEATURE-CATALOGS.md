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
