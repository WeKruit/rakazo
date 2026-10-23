# Required CRM role correspondence

Development base: `4a3e8e11`. This commit contains only synchronization error handling, the managed Main default, regression tests, and this delivery note. The API companion change is `51ddbff6496a1d35504e42eb9d5f313550f1fdf6`; integrate both for complete error semantics.

Role correspondence is a required synchronization phase. An unsupported source response or any read/authorization failure now fails the current slice. It does not advance to the next role, consume the saved cursor, or report completion. The transaction preserves the prior offset/token and rolls back that slice's writes. After the real source capability or authorization issue is resolved, retry the same cursor within its existing validity period; otherwise start a new pass. A deployment does not imply that existing source permissions have been granted.

Fresh managed Main defaults include `list_crm_role_correspondence`; Sourcer defaults are unchanged. Existing assignments upgrade only when their stored managed signature still matches. Customized tool lists, explicit revocations, and removed assignments remain untouched. No production permission was granted by this development work.

Validation: 68 tests passed across the native PostgreSQL CRM synchronization suite and the managed recruiting bootstrap suite. New cases cover unsupported/missing/denied/failed required reads, unchanged progress and successful same-token retry, and unchanged/customized/revoked/removed managed assignments. API TypeScript, changed-file Biome, and diff checks passed. Test data and provider reads were synthetic; no live CRM synchronization was executed.

No migration, dependency, deployment, production connection, source push, resource creation, or outbound action was added. Local deployment owners must verify the real required source tool and caller assignment before dryRun=true, inspect that result, then use dryRun=false and readback under the separately authorized deployment/sync procedure. Development validation is not live acceptance.
