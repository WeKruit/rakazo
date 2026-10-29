# Agent work view polish

Make the chat show what the agents are doing as clearly as current agent UI kits do (agent steps, specialist hand-offs, progress, elapsed time), without breaking the recruiter-facing rules in `AGENTS.md`. The reference is affectUI (affectui.com): Trace Waterfall, Thinking State, Tool Call Card, Agent Handoff, Agent Monitor, Usage Meter.

## Two audiences, two views

| View | Who | May show | Must not show |
| --- | --- | --- | --- |
| Recruiter (default) | every product user | plain-word steps ("Searching candidates"), business progress (people added, emails found), which teammate is working in role words, elapsed time, a short thinking summary | tool names, model names, agent ids, task/run/artifact ids, request JSON, vendor names, raw reasoning, per-step token cost |
| Developer | deployment owner only, explicitly enabled | everything above plus a per-run trace: each LLM call, tool call and hand-off as a timeline bar with duration, tokens and cost, errors and retries | other users' runs (account isolation still applies) |

A Trace-Waterfall-style timeline belongs only in the developer view. The recruiter view stays one assistant with plain steps.

## What already exists (reuse, do not duplicate)

- `packages/core/src/live-work.ts`: `WorkActivity` categories derived from closed tool names, `WorkSession` (start, end, steps per run, current step), `workSessionSteps`, `formatWorkClock`. This is the single source for recruiter-facing step words.
- `apps/web/src/components/LiveWork.tsx`: live step list, shimmer headline, ticking clock, business `detail`, folds to "Worked for 1m 20s" when the turn ends.
- `apps/web/src/components/ToolActivityDisclosure.tsx`: `ToolSteps`, the tool-activity disclosure, tools-only narration line. Live runs show only the last `LIVE_TOOL_STEP_WINDOW` steps.
- `apps/web/src/components/ai/primitives.tsx`: `Shimmer`, `LoadingState`, `SuccessPop`, `MessageSkeleton`, `BuiCard`. Hand-ported from an MIT kit, restyled to our tokens. This is the pattern for borrowing from affectUI too.
- `apps/web/src/components/ai/CollaborationMarker.tsx`: peer hand-off chip and `ActiveBotGlyph` (who is working).
- `packages/contracts/src/events.ts`: message blocks `progress` (with `phase` thinking/compacting/retrying and a user-safe `summary`), `steps`, `subagent`, `child_bot`.
- Cost data: `UsageCostsSchema` in `packages/contracts/src/domain.ts`, run budget in `packages/core/src/run-state.ts`, shown today in settings (`apps/web/src/pages/SettingsOverlay.tsx`).
- Tool activity on/off preference: `apps/web/src/lib/tool-activity-preference.ts`.
- Mobile: `apps/mobile/components/WorkingIndicator.tsx`, `apps/mobile/components/WorkClock.tsx`.
- E2E: `apps/web/e2e/live-work.spec.ts`, `tool-activity.spec.ts`, `tool-activity-disclosure.spec.ts`, `chat-progress-messages.spec.ts`, `peer-messages.spec.ts`, `stuck-work.spec.ts`, fixtures in `apps/web/e2e/fixtures/`.

## Using affectUI

- Install path is a third-party shadcn registry (`https://www.affectui.com/r/<slug>.json`). `AGENTS.md` allows only the official shadcn registry, so do not run `shadcn add` against it.
- About 40 items are free (MIT). A free item may be hand-ported like `primitives.tsx`: read the source, rewrite it on our Tailwind classes, `@rakazo/ui-tokens` semantic colors and `@rakazo/ui-web` components, and keep an MIT attribution comment. Their files use self-contained styles and CSS variables, so they never go in as-is.
- Check each item's badge on its page before porting. Trace Waterfall is Pro. Pro costs US$199 (one person) or US$499 (team), one-time, and is a spend that needs the owner's OK first. Prefer building the small developer timeline from our own run data instead.

## Candidate improvements, in order

1. **Hand-off clarity (recruiter view).** When Main hands work to a specialist, show one line in role words ("Sourcing is looking for people") with that teammate's avatar and a live state, and fold it to a result line when it reports back. Reuse `CollaborationMarker`, `ActiveBotGlyph` and the `subagent` block. No agent names that the recruiter did not see before, no task text dump.
2. **Thinking and retry states.** Render `progress.phase` (thinking, compacting, retrying) and its `summary` inside `LiveWork` as one muted line, never raw reasoning.
3. **Step rows with outcome.** Let a finished step show a short business outcome when the run has one (for example "Searching candidates · 24 found") and a failed step a warning mark, using existing status tokens. Data must come from existing events; add a field to the `steps` block only if the outcome is not already available.
4. **Developer trace (developer view only).** A per-turn timeline: rows for each model call, tool call and hand-off, bar by start and duration, tokens and cost on hover, errors highlighted. Build from data the server already records for runs and usage; if a field is missing, add it through the existing contracts, not a new store.
5. **Mobile parity.** Same recruiter-view states on Expo with native components; the developer trace may stay web-only with a stated reason.

## Rules that apply

- English-first copy; every visible word is UI. Quote any new copy in the PR and say why it cannot be removed.
- No vendor names in product UI (no model, provider or data-source names in the recruiter view).
- Results stream: never hold steps or people back until a turn ends.
- No dead code, no backups, no second implementation of an existing component.
- Monochrome UI; bots carry the only identity color; status colors are destructive, success and warning.
- Tests stay offline and deterministic; add or update the web E2E that opens the changed screen and link its CI screenshot in the PR.
- Never test inside real customer roles; use test copies.
