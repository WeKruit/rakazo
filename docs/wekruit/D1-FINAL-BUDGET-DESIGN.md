# D1: final cold-budget compatibility decision

Snapshot: `61b568a12a80dc69dccaa2330702107a574fcde7`. This is a design record,
not a proposed runtime migration. No product code was changed for this review.

## Actual budget and evidence

Chinese direct cold contacts currently downloads **321,748 gzip bytes**, across
7 JavaScript assets and 35 total requests; 17 RPC calls, zero duplicate recruiting
reads. The target is 250,000 bytes: **71,748 bytes (22.30%) remain**.

| Actual requested asset | gzip bytes | Share |
| --- | ---: | ---: |
| index-BMaycWG6.js | 157212 | 48.86% |
| shell-shared-CTT5N68k.js | 104938 | 32.61% |
| recruiting-shared-XniHUR6W.js | 41918 | 13.03% |
| startup-C9bbTUHv.js (zh-CN) | 12468 | 3.88% |
| shared-controls-Cn7Cyi6Q.js | 4271 | 1.33% |
| RoleSetup-Btv98C4a.js | 513 | 0.16% |
| rolldown-runtime-hePW80VL.js | 428 | 0.13% |

These are the actual browser-loaded asset gzip totals from the matched predicate
change measurement documented in D1-FEATURE-CATALOGS.md. Frontend/core/contracts/
chat-ui/ui-web source has no differences between that measured head `a6224fbc0`
and this snapshot. A fresh production diagnostic build at this snapshot emitted
the same seven asset names. Its module records contain 420 positive-length module
IDs, with no repeated IDs across these assets. Source maps were diagnostic only;
source-map comments are not a new production measurement.

Reproduction: use the existing production build and
`apps/web/scripts/measure-first-load.ts` / contacts browser fixture with
`MEASURE_UI_LOCALE=zh-CN`, synthetic session and RPC data. The diagnostic build used
`VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec vite build` with a
throwaway config adding source maps and a `generateBundle` module-record collector;
that config was removed. No backend tests were rerun for this documentation review.

## What is actually in the graph

The following are rendered source bytes, **not additive gzip contributions**.
Compressing individual modules would not measure their removable contribution:
minification, imports, naming and shared compression change with a rebuild.

- Main includes React DOM 460027, Zod 238179, React Router 94927,
  tailwind-merge 55956, better-auth 30242 and ORPC client 19805 rendered bytes.
  `main.tsx -> App` renders the application; App/router/auth and `lib/rpc.ts`
  establish navigation, session and scoped reads. The RPC contract import is
  **type-only**. Both contracts and core already declare `sideEffects: false`.
- `lib/rpc.ts -> @orpc/client` and its fetch adapter reach
  `@orpc/standard-server` / `standard-server-fetch`. Module edges confirm these
  are dependencies of the client transport; their names are not evidence of
  shipping our API router. Normalizing package IDs after the last node_modules
  segment found no Prisma, local DB, API/worker or better-auth adapter runtime.
  Peer dependency names embedded in pnpm directory names are not loaded modules.
- Shell contains the active controller (41134), conversation (33673), Composer
  (32198), recruiting hook (31505), Transcript (21558), Shell (21407), navigation
  (19542), thread hook (18277), roster hook (17367), message hook (14315), and
  query-core (61796). Contacts and role chat share these instances. Removing the
  visible chat to save this chunk would change the required page.
- Recruiting includes workspace (32451), CRM wrapper (20978), directory (18717),
  profile model (14038), ContactsTab (12841), evidence (12675), timeline (10798)
  and quickOutput (10145). Directory/ContactsTab call `candidateSections`, which
  uses quickOutput and timeline normalization for visible data. These are not
  merely unopened-detail dependencies. Base UI serves active tabs/checkboxes.
- `useShellController -> routine-draft -> core/cron` retains small draft helpers;
  the Croner implementation is absent. Markdown plain-text helpers also serve
  previews/notifications, not just dormant voice playback.

There is a **real but small** remaining impurity boundary:
`core/message-replies -> ReplyPreviewSchema -> thread-message-metadata -> ids`.
Source-map inspection shows the unused ActorSchema object and EffectStatus enum
constructors remain as discarded calls in the generated ids slice. A canonical
Id leaf plus reexports could preserve public schema identity and remove these
calls. The entire ids module is only 642 rendered bytes. This is not evidence for
71 KB, and global pure annotations would be an unjustified substitute.

Zod remains genuinely needed: reply previews, computer commands, current
employment validity, and auth capabilities are synchronously validated. Auth uses
`authCapabilitiesSchema.or(legacyAuthCapabilitiesSchema).parse`, including legacy
omit/strict/transform semantics. Employment `safeParse` affects current rendering.
Neither is an action-only dependency. The isolated Mini experiment preserved some
parse/ORPC/JSON-schema cases but failed classic method and ZodError compatibility;
it produced **no valid cold-size result**. It is not proposed again here.

The measured action extraction experiment saved only 558 bytes while introducing
new asynchronous boundaries; it remains excluded. Earlier multi-action estimates
of several KB were estimates, not established savings. No ordinary remaining
import correction has demonstrated the required 71,748-byte reduction. This is a
bounded finding, not a claim that every possible optimization is exhausted.

## Two explicit choices

### A. Preserve current runtime and public API; treat 250 KB as a continuing target

Ship the already validated 350 KB first-stage implementation. Keep React, current
controls, synchronous canonical validation, all visible content and current
contracts. Permit small canonical leaf corrections only with measured net gains;
do not add asynchronous action races for negligible savings.

Estimated effort: 1–2 engineer-days to audit/split the concrete ids leaf and check
other retained constructors; this is an estimate, not a commitment. Public API
impact should be zero, enforced by schema identity/reexport tests and the existing
consumer/type suites. Risk is low for a leaf, but **there is no forecast that this
choice reaches 250 KB**. The decision required is accepting an unfinished final
budget goal while retaining current architecture, not marking D1 complete.

### B. Evaluate a web-only renderer compatibility boundary before considering adoption

Keep canonical contracts, API validation and server behavior unchanged. In an
isolated, separately approved feasibility effort, evaluate React/ReactDOM aliases
to Preact/compat for web/Electron only. Do not change Expo/mobile's React runtime or
shared package source contracts. This targets the largest main-chunk owner rather
than assuming schema construction or hidden UI can be removed.

The official [Preact integration guide](https://preactjs.com/guide/v11/getting-started/)
documents aliases, but its [compatibility guide](https://preactjs.com/guide/v11/differences-to-react/)
explicitly describes differences, including portal event propagation and partial
React-version coverage. Therefore this is **not a drop-in compatibility claim**.
Base UI portals/focus, React Router, external stores, Suspense/error boundaries,
selection, IME composition, optimistic send and desktop integration are blockers
until tested. Public app/component TypeScript APIs should remain unchanged; if
maintaining them requires forks or cross-platform changes, stop and reassess.

Estimated effort: 2–3 engineer-days for a compatibility/size decision, then roughly
1–3 engineer-weeks only if viable for full parity and platform review. These are
planning estimates with high uncertainty. No current build establishes a net byte
saving. A renderer library's advertised size is not this app's route saving.

A **go/no-go budget**, not a forecast: if all other assets stay unchanged, main
must fall from 157212 to at most **85464** to reach 250000. Alternatively, an
explicit two-chunk envelope is main <=100000, Shell <=90000, all other assets
<=59598, totaling249598. The latter additionally requires independently evidenced
Shell savings; it cannot be assumed from a renderer alias. If the measured trial
cannot meet an honest envelope without feature or validation changes, reject it
rather than continue an open-ended migration.

Both choices retain current visible controls. A third, much larger rendering
redesign is not justified by this audit. In particular, SSR alone is not a budget
solution: React's [hydrateRoot documentation](https://react.dev/reference/react-dom/client/hydrateRoot)
requires client React to attach behavior to server HTML. Rendering identical HTML
on the server while hydrating the same tree does not establish a smaller JS graph.
Selective non-hydration of active controls would violate this task. No SSR or
second UI framework is required by the evidence collected here.

## Verification and decision boundary

Before accepting any future runtime change: matched production Chinese cold
contacts and chat, anonymous entry, English/Chinese switching and feature-load
failure recovery; real link/Markdown/ask/approval states; unchanged canonical
validation and errors; zero duplicate reads; fresh-auth/space-switch isolation;
keyboard, portal focus, resize/selection and 1000-row/message virtualization;
instant optimistic echo/Starting feedback; all relevant web/shared type and test
suites. Count all code required for the initially visible controls to work, not a
time-window subset. Require actual <=250000 bytes to claim that final target.

Recommendation: choose A unless a separate bounded renderer compatibility trial
is worth the risk and engineering time. B is a concrete testable option, not a
promise of 71,748 removable bytes. No prototype was started by this review.

The remaining 250 KB gap is a **code/design budget decision**, not a release
permission issue. Deployed Fast4G LCP and production rollout remain release-team
acceptance work; they must be listed separately and must not block reporting the
implemented and locally verified first-stage work.
