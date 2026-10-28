# D1 isolated Zod Mini compatibility result

**Rejected as a release candidate. No production change, push or PR.** The
prototype branch starts at integration commit `60ccba9a6`; it does not include
the earlier 558-byte action-boundary experiment. Only the import used to build
canonical `MessageReactionSchema` changes from `zod` to official `zod/mini`.
`MESSAGE_REACTIONS` remains the single canonical runtime rule; no browser-only
schema, validation stub or custom compatibility facade is introduced. The test's
classic enum is a reference implementation using that same tuple.

## Observed compatibility matrix

Command:

```sh
pnpm exec vitest run packages/contracts/src/zod-mini-prototype.test.ts
```

Result: **3 passed, 2 failed** (five tests, 282 ms).

Passed for the test corpus:

- All six accepted reactions and representative invalid inputs produce the same
  success/data or complete issue objects under the current English configuration.
- Standard Schema validation, Mini nested in a classic object, and the actual
  ORPC `appContract.threads.react` input schema preserve acceptance/rejection.
- The official top-level JSON Schema conversion functions produce the same
  schema, both directly and when nested in a classic object.

Failed release prerequisites:

1. `retains the canonical schema's existing public methods` fails at `.optional`:
   expected `function`, received `undefined`. A separate inspection confirmed
   the same absence for `.nullable`, `.or`, `.transform`, `.refine`,
   `.toJSONSchema`, `.extract` and `.exclude`. The official top-level functional
   API exists, but it is not the same exported object API.
2. `retains the public error class and formatting API` fails because the Mini
   error is not `instanceof` classic `ZodError`. It is `$ZodError`, and `.format`
   is absent. Both are Error instances and their tested issue payloads match;
   matching issue JSON does not make the error class/API compatible.

The deliberately failing tests remain in this **local experiment only** to make
both rejected prerequisites reproducible. They must not be cherry-picked into
an integration branch as a passing change.

## Why a wider migration is not an ordinary import swap

The repository has concrete classic-method callers: web/mobile auth capability
readers use `.or`, ReplyPreview consumers use `.nullable().optional()`, RPC extends
ComputerCommand with `.extend`, and Id-based contracts compose many `.optional`
and related methods. The prior audit counted 84 Id method uses across ten files.
Migrating those callers is a public schema API change. Reintroducing classic
wrappers would retain classic code and needs its own measured proof; implementing
a custom facade for every method/error is a new compatibility layer, not an
official Mini migration. Neither approach was attempted here.

The simple enum demonstrates that ORPC/Standard Schema nesting itself is not the
first blocker. Public methods and error behavior already fail before the broader
auth/refinement/readonly/transform contracts are migrated. There is no reason to
risk those contracts or promise 250 KB based on this isolated test.

## Checks and measurement boundary

The following commands passed after fixing the test's ESM import extensions:

```sh
pnpm --filter @rakazo/contracts check
pnpm --filter @rakazo/web check
VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web build
```

A successful typecheck/build is **not** public behavioral parity. The requested
local cold-contacts comparison was rejected by automatic approval before process
creation because full parity was a prerequisite and had failed. It did not run;
there are **no new valid cold-byte results** for this prototype. The denial was
not retried or bypassed, and the parent explicitly directed stopping measurement.
No artifact sizes or simulated compression are substituted for that missing gate.

The integrated product remains the already-merged D1 confirmation/catalog work
and complete-catalog failure fix. The 250000-byte final goal remains unmet.
A wider Mini migration would require an explicit compatibility/API design,
including error behavior, rather than weakening the original acceptance rules.
