# Resizable chat and side panels: handoff

Branch: claude/resizable-panels (based on origin/main b84f458). Draft PR open against main.

## Done (committed, cb12d20)
- apps/web/src/lib/pane-width.ts: `usePaneWidth(storageKey, fallback)` reads the saved width on first render and writes each change to localStorage. `clampWidth`.
- apps/web/src/components/PaneResizeHandle.tsx: `<hr>` separator with pointer drag, ArrowLeft/Right (16px), Home/End, double-click reset, `data-pane-resizing` on <html> while dragging. Takes a `label`, `edge` ("start"|"end"), min, max.
- apps/web/src/pages/ResizableSidePanel.tsx: right panel now uses both (double-click reset added). Key `rakazo:right-panel-width` unchanged. Existing e2e spec `resizable-side-panel.spec.ts` expects label "Resize panel" and aria-valuemax 364 at 1000px, 864 at 1500px. Keep those.
- styles.css: `html[data-pane-resizing]` disables transitions while dragging. The biome-ignore comment is misplaced: move it inside the rule, directly above `transition: none !important;`.
- locales: extracted msgids for "Resize navigation" and "Resize chat" (not yet used).

## NOT done: Shell.tsx (uncommitted, working tree is BROKEN)
Running `biome check --write` reformatted all of apps/web/src/pages/Shell.tsx (1322+/960-). The working copy is not committed. First step for the next session: `git checkout HEAD -- apps/web/src/pages/Shell.tsx`, then apply these edits (none committed yet):
1. Imports: `PaneResizeHandle` from ../components/PaneResizeHandle; `clampWidth, usePaneWidth` from ../lib/pane-width; add `CSSProperties` to the react type import.
2. After the showToolActivity useSyncExternalStore: `botsSidebarWidth` = usePaneWidth("rakazo:bots-sidebar-width", showToolActivity ? 316 : 260); `botsSidebarMaxWidth = max(220, min(480, innerWidth-480))`; `roleChatWidth` = usePaneWidth("rakazo:role-chat-width", clampWidth(innerWidth*0.34, 320, 420)); `roleChatMaxWidth = max(320, min(720, innerWidth-480))`.
3. Bots aside: `md:static` -> `md:relative`; expanded class `md:w-(--bots-sidebar-width) md:max-w-none` (drop the 316/260 branch); style `--bots-sidebar-width` = clamp(botsSidebarWidth, 220, max). Before `</aside>`, when not collapsed, render PaneResizeHandle label "Resize navigation", edge end, className md:block.
4. Edge toggle button: render only when `botsSidebarCollapsed` (add `|| !botsSidebarCollapsed` to its condition); class start-0 only.
5. Role chat main: style `--hire-role-chat-width` = clamp(roleChatWidth, 320, roleChatMaxWidth) px when roleChatWorkspace. Handle label "Resize chat", edge start, className min-[941px]:block, as the first child of the role-chat section (before the "Inside main so the composer" comment), when roleChatWorkspace && roleChatOpen.
6. Run `npx lingui extract` (in apps/web) after strings are used; do NOT run biome --write on Shell.tsx (it reformats the whole file). Use `biome lint` or check formatting by diff.

## Checks
- tsc (apps/web): passes on the committed set.
- Vitest apps/web/src: 2 i18n-catalog failures and desktop.test "keeps conversation header controls clickable" fail on HEAD too (pre-existing). Not caused by this work.
- Web e2e not run. Verify in browser: drag each pane, reload (no jump), keyboard focus, RTL, 940px breakpoint.

## Open decisions
- Bots (developer tool-activity) mode loses click-to-hide on the edge when expanded. Collapse still works from the RecruitingNavigation control in the recruiting view. Bots mode needs an explicit collapse control, or accept the regression.

Shell.tsx working copy is formatter-rewritten and uncommitted. Restore it from git, then reapply the 11 edits.
