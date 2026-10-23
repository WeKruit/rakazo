# Integration hunks for codex/wl-e-memory-search-prompts

Files owned by other agents that must change for this branch's behaviour to be live.
History search `scope:"mine"` and `read_history.threadId` need **no** executor change:
the executor already passes `HistorySearchInputSchema.parse(args)` / `HistoryReadInputSchema.parse(args)`
straight into `searchHistory` / `readHistory`, and the new fields are handled there.

## 1. `packages/adapters/src/executor.ts` — `remember` / `save_shared_memory` edit mode (N7)

Import (next to the existing `nativeMemorySaveError` import from `./memory-tools.js`):

```ts
import { applyMemoryEdit, nativeMemorySaveError } from "./memory-tools.js";
```

In the tool switch (`if (name === "remember" || name === "save_shared_memory") {`, ~line 7246),
replace the body between `const botId = ...` and `try {`:

```diff
             const path = typeof args.path === "string" ? args.path.trim() : "MEMORY.md";
             const scope = shared ? "user" : "bot";
             const botId = shared ? undefined : bot.id;
+            let content = args.content as string;
+            if (args.edit !== undefined) {
+              // Partial edit: merge into the loaded document; commit still checks expectedRevision.
+              const current = await deps.memory.read({ scope, botId, path }, context);
+              const merged = applyMemoryEdit(
+                current.documents[0]?.content ?? "",
+                args.edit as { find: string; replace: string },
+              );
+              if ("error" in merged)
+                return finish({
+                  error: merged.error,
+                  currentRevision: current.documents[0]?.revision ?? 0,
+                });
+              const tooLong = shared ? sharedMemorySaveError({ path, content: merged.content }) : undefined;
+              if (tooLong) return finish({ error: tooLong });
+              content = merged.content;
+            }
             try {
               const saved = await deps.memory.commit(
                 {
                   scope,
                   ...(botId ? { botId } : {}),
                   path,
-                  content: args.content as string,
+                  content,
                   expectedRevision: args.expectedRevision as number,
```

`nativeMemorySaveError` (already called on this path and on the `guardedMemory` path) now accepts
`{ edit:{find,replace}, expectedRevision }` and rejects `edit` combined with `content` or
`recruitingFeedback`, so the guarded recruiting-preference path is unaffected.

## 2. `packages/adapters/src/approval-ask.ts` — approval detail for edit mode (cosmetic)

`formatApprovalDetail` prints `Content:\n${args.content}` for native memory saves; in edit mode
`content` is undefined. Suggested:

```diff
-      `Content:\n${args.content}`,
+      args.edit !== undefined
+        ? `Replace:\n${(args.edit as { find: string }).find}\n\nWith:\n${(args.edit as { replace: string }).replace}`
+        : `Content:\n${args.content}`,
```
