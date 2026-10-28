// zod compiles object parsers with `new Function` after probing for eval. The app's CSP
// forbids eval, so opt out before any schema is built rather than trip the policy.
// zod reads this shared config object from globalThis (4.x).
const scope = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
scope.__zod_globalConfig ??= {};
scope.__zod_globalConfig.jitless = true;
