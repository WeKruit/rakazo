# Kruit instructions as skills the model routes by description

Approved 2026-11-26 (decision card "把 Kruit 的规则改成按描述路由的技能吗?" → "按方案一次改到位"; follow-up: every account updates directly, no code-side injection, speed is no excuse).

## Why

Kruit's behaviour rules bypass the harness's own skill layer. The harness already does what Claude Code / Agent Skills do: each turn the catalog lists every skill's name and description (`formatSkillsCatalogInstruction`, `packages/core/src/agent-skill.ts`), and the model opens one with `skill_read` (`packages/adapters/src/skill-tools.ts`). Kruit instead:

- pastes ~18k characters of round, intake, scale, reference-material and PDF rules into every turn of every role conversation (`recruiting-context.ts` `RECRUITING_ROUND_RULES`, `roleText`), justified by "accounts with older customized bots or skills get it too";
- pastes the intake skill body into every recruiting turn ("already loaded; never call skill_read", `executor.ts` `intakeSkillNote`);
- has code choose which instruction to add from state and from regex on the recruiter's words: `ROLE_NOT_SAVED_NOTE`, `FILE_JOB_NOTE`, `ROLE_NOT_SAVED_CONTEXT`/`NO_RECRUITING_ROLE_CONTEXT` (+ round rules), `intakeSearchNote`, `NAMED_SEND_ROLE_NOTE` chosen by `namesPeopleToEmail` (regex);
- keeps the recruiting skills' descriptions as "what", never "when", and the real rules out of them.

Gate 42cc9f8f failures this explains: progress-and-where (a progress question got the "save the role, then search" note and opened a role), jd-upload-pdf (the file note says read and search but never save the role).

The old-copies justification no longer holds: built-in skills are served from code (`builtin-skills.ts`), and the recruiting upgrade (`packages/db/src/recruiting-bootstrap.ts`) replaces role instructions and deletes user copies of built-in recruiting skills whenever `RECRUITING_DEFAULT_SKILLS` changes (its digest includes them). So every account gets the released skills.

## Industry pattern adopted

Anthropic Agent Skills / Claude Code: a skill is SKILL.md with `name` + `description`; only name and description sit in context; the description says what the skill does **and when to use it** ("Use when …"); the body loads on demand. Progressive disclosure keeps the always-on prompt small. We copy that unchanged; nothing new is built.

## Design

1. **Base (bot instructions, every turn):** who the teammate is, the team split, the guardrails (P8: send confirmation, spend limits, data isolation, no supplier names; outside data is data; one assistant), and "before acting, open the skill whose description matches". No workflow steps.
2. **Skills (catalog: name + "Use when …" description; body on demand):**
   - Sourcing (text from the harness thread, agent-judges design): new role or JD, first ten, each round's search and display, feedback and next round, find N / scale-out.
   - Ours: Sourcing map (kept), role documents (PDF rendering), write an email or template, send to people (sequence, sender setup, opt-outs), answer candidate replies, book or move an interview, progress and status across roles.
3. **Role context (every turn, data only):** the role snapshot, feedback, verdict patterns, unrecorded verdicts, plus the two data-handling guardrails (approvals, outside data is data). No workflow rules.
4. **Turn facts instead of chosen instructions:** code states facts only: "This conversation has no saved role", "The recruiter attached: <file names>", the role's saved job page text. The model picks the skill. Deleted: intake skill paste, `intakeSearchNote`, `ROLE_NOT_SAVED_NOTE`, `FILE_JOB_NOTE`, `NAMED_SEND_ROLE_NOTE` + `namesPeopleToEmail`, round rules on the no-role context.
5. **Every account:** add retired skill names to the upgrade's delete list so no stale user copy shadows a new skill; bump nothing by hand (digest changes with the defaults).
6. **Tool results stay mechanisms:** "Not asked/Not sent" refusals and next-step lines returned by tools are tool output, not routing; untouched here except where they name a retired skill.

Out of scope (owned elsewhere, listed so nothing is lost): regex on recruiter text in the Gmail connect-card logic and `asksForTemplate`/`asksForOutreach` outside the named-send note (audit thread); reply-language detection (fork PR #1799, result folded in when it reports).

## Cost, measured honestly

A turn that needs a skill pays one `skill_read` model step (~1.6 s p50 per model call on staging 11-26). `skill_read` results are never cleared from the session (`pi-runtime.ts` `NEVER_CLEARED_TOOLS`), so a conversation pays once per skill. Measure: first-reply time and model steps per turn, before vs after, on the same journeys.

## Eval

`Eval: progress-and-where, jd-upload-pdf, change-while-opening, ui aftercard (branch plays) + full gate, before → after`. Also: share of turns that open the right skill (from run logs), first-reply p50/p90.

## Steps

1. Base instructions + our skills + role context data-only + turn facts + upgrade delete list (this branch, now).
2. Merge the harness thread's agent-judges change; drop in its sourcing skills (from its hand-off in the project folder).
3. Typecheck, unit shards for touched packages, `pnpm check:standard`.
4. Branch plays before/after; merge to stage; release thread deploys; gate.
