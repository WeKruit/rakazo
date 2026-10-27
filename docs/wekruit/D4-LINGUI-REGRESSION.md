# D4 translated labels and error fallback regression

The unchanged production route test on pre-contact-optimization baseline `f4ad6b091` failed to find `Collapse role chat`. DOM inspection showed the chat was present, open and visible, with a valid active thread snapshot; its accessible names were empty. D4 extraction commit `7c3f0361e` moved template tags into view files while passing `t` through the controller model. These calls no longer had a local Lingui macro binding. D4 baseline `e0eb80130` contains the same affected source. This is not caused by D2 caching or the later contacts lazy-loading work. The exact D4 binary was not separately executed.

Nine extracted view components now obtain `t` locally from `useLingui` imported from `@lingui/react/macro`. Text and interpolation expressions remain unchanged. The controller's output contract remains compatible. Source scanning found no remaining production tagged-template calls without a local macro binding in this baseline; D1's newly extracted views are being corrected separately.

Production browser regression keeps the original route assertions, adds English and Chinese accessible names, and triggers a synthetic export RPC failure to verify the translated error fallback. No actual export data or external service is used. The fixture supports an explicit locale while retaining English by default.

Validation commands:

```sh
pnpm --filter @rakazo/web build
RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec vite preview --host 127.0.0.1 --port 5208
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5208 pnpm --filter @rakazo/web exec playwright test e2e/recruiting-app-routes.spec.ts e2e/recruiting-lingui.spec.ts --workers=1
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
git diff --check
```

Web check/build passed. Full unit suite: 1,676 passed across 144 files, including production catalog tests. Original route suite: 10 passed, covering 1440px and 390px. English/Chinese production accessible-name cases passed. The final English/Chinese run including translated export failure feedback passed both cases (2/2). An initial error fixture omitted ORPC's required `defined` field; corrected to the actual wire envelope before evaluating the fallback.

No publication, cloud changes or real candidate/job tests. Other locales and deployed runtime remain untested.
