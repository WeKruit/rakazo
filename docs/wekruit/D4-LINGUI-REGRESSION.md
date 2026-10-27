# D4 Lingui macro regression correction

Component extraction moved tagged `t` templates into view files but obtained `t` from the controller/model object. Lingui's compile-time transform requires a local macro binding; a runtime translator passed through an object is not equivalent. The real production browser investigation on the combined branch found empty accessible names despite an otherwise visible conversation. This independent D4 branch contained the same defect, which mocked unit tests and source catalog checks did not catch.

This correction applies local `const { t } = useLingui()` from `@lingui/react/macro` to all seven affected components present at this stage: Shell, RecruitingPanel, RecruitingRoleTab, RecruitingEvidenceTab, ShellConversation, ShellOverlays and ShellSidebar. Strings and interpolation expressions are unchanged. The controller output contract remains compatible. Later D1-only DeveloperSidebar and ShellPanelContent files do not exist here and are not introduced; their still-inline UI is covered by the local Shell/Sidebar bindings.

Only the fixture's optional locale setting and the bilingual production regression were reused from `fb9c4c3ce`; newer D2 fixture contracts and product code were not copied. The original route assertions remain unchanged; readiness synchronization is described below. The new test asserts exact English/Chinese region, export, collapse and candidate-search accessible names, and returns a synthetic ORPC error from threads/messages to assert translated export-error feedback. It never reads or exports real conversation data.

A TypeScript6 compiler-API diagnostic scanned all242 non-test/non-locale production TS/TSX files. It resolved each1543 tagged-template `t` binding to either a `useLingui` macro destructuring or an imported core macro, rather than merely searching for the word useLingui in the file: **zero invalid bindings**. The temporary scanner was not added as a product dependency. The repository's TypeScript7 package exposes only version metadata to require; the installed TypeScript6 compiler API was used for this diagnostic without changing dependencies.

Validation commands:

```sh
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec vite build --manifest
RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec vite preview --host 127.0.0.1 --port 5214 --strictPort
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5214 pnpm --filter @rakazo/web exec playwright test e2e/recruiting-app-routes.spec.ts e2e/recruiting-lingui.spec.ts --workers=1
node apps/web/scripts/check-component-size.mjs
git diff --check
```

Web typecheck/build passed. Full Web unit suite: **1655passed/142files**,20.76s. Targeted Biome passed. Size audit remains242production files with zero files above1500lines. The first browser run passed both bilingual cases and8/10original routes. The mobile navigation case timed out because its loop read an enabled arrow before a pending scroll event disabled it. The scroll-reset case tried to scroll the lazy Sequence panel before its real campaign row existed. Both failures reproduced in an unchanged two-case rerun.

Test synchronization now waits for the actual campaign row before setting scrollTop, preserving the positive-scroll and reset-to-zero assertions. Navigation waits until rAF-observed scrollLeft is unchanged for100ms and the arrow disabled state matches the actual edge after both right and left navigation, then evaluates the next loop iteration. A preliminary two-frame wait passed12/12 but was replaced because it could still observe an animation mid-flight. No product scrolling behavior, disabled condition, accessible-name check or final viewport/ancestor-scroll assertion was weakened. Final repeated browser results are recorded below. Other locales, deployed runtime and external providers remain untested. No publication or cloud changes occurred.

Final production browser run used `--repeat-each=2`: **24/24 passed**, covering the unchanged1440px/390px route assertions twice and English/Chinese names plus error feedback twice. These results apply to the independent D4 production build, not only the combined integration baseline. The earlier failed runs remain recorded above; no assertion was deleted. The temporary loopback preview was stopped after validation.
