# Harness repair step C: each agent's own tools and skills, Pi's skill listing

Source: harness audit 2026-11-28, root cause 4 and audit 3 (tools, skills), rows 1-7, 66-81. Maintainer
approved step C on 11-28. Rules: P8, P10, P21, WeKruit design principle 10, Development standard 1 and 7.

## What mature harnesses do (read before building)

- **Claude Code subagents** (code.claude.com/docs/en/sub-agents, read 11-28). `tools:` is an allowlist,
  and an agent that omits it inherits every tool. `disallowedTools:` is applied first. `skills:`
  *preloads* the full body of each listed skill at startup. It does not limit which skills the agent can
  invoke, and project, user and plugin skills stay invocable.
- **Pi agent-core 0.87.1** (installed: `node_modules/@earendil-works/pi-agent-core/dist`).
  `harness/skills.js` has `loadSkills`, `loadSourcedSkills` and `formatSkillInvocation`.
  `harness/system-prompt.js` has `formatSkillsForSystemPrompt`, the agentskills.io
  `<available_skills>` block with name, description and location. `harness/runtime/lane.js:355-363` has
  `harness.skill(name)`, which turns an explicit invocation into a `<skill name location>` user
  message. All three are exported from the package root. Pi's coding-agent package is **not
  installed** here, so there is no other Pi skills loader to adopt. Pi limits a skill description to
  1,024 characters (`MAX_DESCRIPTION_LENGTH`).
- **Pi tools**: the app sets `context.tools`, and `declareToolChanges` (agent-loop.js:210-245) adds or
  removes tools mid-run. Both are step A's runtime.

## Where the per-agent list lives

The Bot model (`packages/db/prisma/schema.prisma`) has one per-bot builtin field, `disabledBuiltinTools`.
That field is CC's `disallowedTools`, edited by the owner, and it stays. Per-bot MCP grants are in
`BotMcpServer.allowedTools`. No field holds a builtin allowlist or a skill list. The recruiting agents
are maintained product defaults, recognised by spawn key, so the allowlist goes on the agent
definition. That definition is our frontmatter: `RECRUITING_DEFAULT_BOTS[].tools` and `.skills` in
`packages/core/src/recruiting-defaults.ts`. The account-wide conversation, which is the same Main bot
running a different instruction file, gets its own `RECRUITING_ACCOUNT_WIDE_AGENT`.
`recruitingAgentScope(bot, groupId)` returns the scope for any agent. Old and new crews get the scope
without a migration. The bootstrap catalog digest includes `RECRUITING_DEFAULT_BOTS`, so the next
sign-in records the new defaults as usual. Bots outside recruiting have no scope and keep every
builtin tool and skill, as CC does when `tools:` is omitted.

## Each agent's tools and skills

Every role agent shares the harness base `RECRUITING_BASE_TOOLS`: files and shell, ask_user,
request_connection, message_user, wait_for_work, stop_work, end_call (voice only), memory, history,
the scratchpad, routines, skill_read and skill_create/update/delete, run_subagent and handoff_to_bot.
The base skills are "Tidy memory" and "Work with data using code". The role-specific part comes from
each agent's instruction file, the skill bodies it is listed, and the tool each skill names. A test
in `builtin-tools.test.ts` asserts that every builtin a listed skill or the instructions name is in
that agent's list. That test caught Sourcer needing `recruiting_role`, because its feedback skill
records requirement changes with `recruiting_role update`.

| Agent | Recruiting tools (beyond the base) | Maintained skills (beyond the base) |
|---|---|---|
| Kruit, account-wide chat | Reads and hand-off only: recruiting_candidates, artifact_read, read_memory, recall_memory, search_history, read_history, scratchpad_list, web_search, web_fetch, skill_read, start_role, delegate_to_role, stop_work, wait_for_work, message_user, attach_file. **No base.** | none. The user's own skills are still listed |
| Main, role lead ("You write and send emails, answer replies and book interviews yourself") | all 12 recruiting_* tools | all 10 recruiting skills |
| Sourcer (scale-out) | recruiting_role, recruiting_candidates, recruiting_research, recruiting_feedback, recruiting_profiles, recruiting_notes | Sourcing map, Find more people, Recruiter feedback on people or requirements |
| Outreach | recruiting_candidates, recruiting_shortlist, recruiting_reply, recruiting_crm_target, recruiting_crm_import, recruiting_reminders, recruiting_notes, recruiting_profiles, recruiting_feedback (opt-outs) | Role documents, Write an email or template, Find contacts, Send to people, Answer candidate replies |
| Scheduling | recruiting_candidates, recruiting_scheduling, recruiting_reminders, recruiting_notes, recruiting_profiles, recruiting_feedback | Role documents, Answer candidate replies, Book or move an interview |
| A recruiting bot with no current key (for example a retired reviewer) | base only | base only |

Specialists get no `recruiting_role` read, because the role context goes into every run of a role
thread (`initialRecruitingContext`). Kruit loses `recruiting_feedback`, which was the
preference-only schema rewrite, and its memory and scratchpad writes. A preference, like every other
ask, goes to a role. Its instruction sentence "Only a preference for every role is saved here" is
removed in the same change (P10). The Interrogate code-review skill is no longer listed to any
recruiting agent.

**Measured** for builtin tool definitions only: name + description + JSON schema characters, with
tokens estimated as chars / 4 (Pi's `estimateTokens`). This is a user turn in a role group or the
account-wide group, with no computer, history retrieval on and semantic memory on. MCP and connector
tools are not counted; they depend on the account's connections.

| Agent | Before: tools / chars / ~tokens | After: tools / chars / ~tokens |
|---|---|---|
| Kruit | 24 / 41,648 / 10,412 | 16 / 27,089 / 6,773 |
| Main | 49 / 122,648 / 30,662 | 49 / 122,648 / 30,662 (unchanged; it does all role work) |
| Sourcer | 49 / 122,648 / 30,662 | 43 / 109,482 / 27,371 |
| Outreach | 49 / 122,648 / 30,662 | 46 / 81,880 / 20,470 |
| Scheduling | 49 / 122,648 / 30,662 | 43 / 81,070 / 20,268 |

The skill listing changes from the old prose catalog of 13 skills (3,036 chars, Kruit 979) to Pi's
block. It is now Main 4,172, Sourcer 1,836, Outreach 2,412, Scheduling 1,777 and Kruit 0 chars. Main's
grows because Pi's XML adds a location per skill. Main's tool cost does not shrink because its
instructions make it do every role task. Shrinking it is a product decision about Main's job, not a
harness change. `recruiting_role` alone is about 30k chars (4.4k description, 25.8k schema) and is
the next target for B or a follow-up.

## How the skill listing moves to Pi

- The listing is Pi's `formatSkillsForSystemPrompt`, produced by
  `packages/adapters/src/agent-skills.ts formatAgentSkillsListing`. Stored skills have no file, so the
  location is `skills/<name>/SKILL.md`, the convention write_file already saves skills under, and
  skill_read loads the skill by name. A skill whose `requires:` is missing keeps the reason in its
  description.
- An explicit `/Name` becomes Pi's `formatSkillInvocation`. It carries the body without frontmatter, in
  the same block `harness.skill()` produces.
- A routine's `@Name` mentions expand only when the routine fires (`expandRoutineSkills`, in the
  executor's wake and the router's test run). A turn's own prompt expands only a forced `/Name`
  (`expandForcedSkill`), so a recruiter's `@Main` is never matched as a skill. A mention matches only a
  known skill name, and the stop-word heuristic is gone (P9).
- Each agent's listing is `skillsForAgent`: the user's own skills plus the maintained skills in its
  `skills` list. This scopes the listing. It does not preload, unlike CC's `skills:`, because
  preloading all 10 bodies into Main would cost about 30k chars every call. skill_read stays unscoped,
  as CC keeps unlisted skills invocable.
- When step A moves the runtime onto Pi's `AgentHarness`, the same `Skill` objects go into
  `resources.skills`. The listing and `/Name` then come from the harness itself, and
  `agent-skills.ts` shrinks to the mapping from stored rows.

## Deleted

- `RECRUITING_UNUSED_BUILTIN_TOOLS` (product-wide denylist) → per-agent allowlists.
- `ACCOUNT_WIDE_TOOLS` and `preferencesOnly` (+ `PREFERENCES_ONLY_LEAD`, `ROLE_FEEDBACK_TARGETS`) in
  `schedule-tools.ts`. These were the groupId-keyed allowlist and the mutated recruiting_feedback.
- `accountWideSkill` (name-based skill filter) → Kruit's empty `skills`.
- `withoutPolls` → no recruiting list includes create_poll.
- In core `agent-skill.ts`: the catalog formatter (`formatSkillsCatalogInstruction`,
  `skillCatalogLine`, `SKILL_CATALOG_DESCRIPTION_MAX`, the 50-entry cap and the 6 prose lines,
  including the false "The Pi runtime already understands this format; we persist and inject them"),
  `formatForcedSkillPrompt` ("Use skill: …"), and the `@Name` heuristic with its stop-word list
  (`ROUTINE_SKILL_STOP`, `ROUTINE_SKILL_MENTION`). The leftover "autumn" examples go too.

## Not changed here, and why

- **Taught skills**, the second skill system (`TaughtSkill` model, teaching sessions, UI, the "Saved
  taught skills" prompt block). This is a user-facing feature with its own UI and API. Retiring it, or
  converting saved playbooks into SKILL.md rows, is the maintainer's decision (P12). Proposal: convert
  each saved taught skill to a user Agent Skill, then delete the second listing.
- **Our SKILL.md parser and YAML subset** stay. Pi does not export its frontmatter parser; it uses
  the `yaml` package internally. Replacing ours with `yaml` would change how stored skills round-trip,
  so it needs its own change with a migration check. Name and description limits (80 / 2000) still
  differ from the spec (64 / 1024).
- **MCP side**: `CORE_TOOLS`, `accountWideRead` and `OPERATIONS_ELSEWHERE` in `mcp-connector.ts`. They
  belong to the connector discovery rewrite (audit rows 14-17, 26): one search/run pair, or Pi
  `toolsAdded`. The per-agent `tools:` list should then also name MCP tools, as CC's
  `mcp__server__tool` does, replacing both. `hideCatalog`/`firstRoundPending` (executor.ts:3548) is
  P9, deriving stage from the DB, and goes with that rewrite.
- **`recruitingBotKey` name fallback** (any bot named "Main"). It is kept for crews created before
  spawn keys. A data migration that sets spawn keys would remove it.
- `RECRUITING_DISABLED_BUILTIN_TOOLS` stays as bot data (the computer tools), the owner's
  `disallowedTools`.

## For step A (guards as Pi hooks; not moved here)

Inline guards in `packages/adapters/src/executor.ts` belong in `beforeToolCall` / `afterToolCall`
hooks in `agent-session/guardrails.ts`. Only `prepareArguments` is used today (pi-runtime.ts:1767).

- Argument fills: `fillRecruitingRoleArgs` (executor.ts:4963 → db/recruiting.ts:3429, substring match
  on recruiter text, P9). `citeRecruiterMessages` (executor.ts:5051 → db/recruiting.ts:3362, citation
  re-pointing, P9). Feedback roleId, revision and candidate keys (around executor.ts:5057).
- Refusals: disabled-tool refusals `disabledToolError` (executor.ts:5067, 13146, 14237).
  calibration_round dedup, reorder and refusal (around executor.ts:5009-5050). The send guards for a
  declined or unchanged card (P17, kept as a guardrail).
- Result patches: `teamWorking` (executor.ts:4223, 9285), `fewerThanAsked` (executor.ts:4304),
  `leftOutAsShownInRounds`/`shownInChat`, and the contact batch done note.
- Turn-level: `AFTER_HANDOFF_QUIET` (executor.ts:1338). The delegate_to_role words override at
  executor.ts:10650 uses `lastRecruiterText` (step D owns that tool).
- Mode inferred from a tool name: `recruitingSearch` (executor.ts:3537, `web_search_advanced_exa`
  suffix). With `recruitingAgentScope` it can read the agent's scope instead.

## For step B (texts that name this layer)

- `skill_create` description: "The Pi runtime already understands this format; we persist and inject
  them". The `skill-tools.ts` hint "mention /Name" (rule 7, P13).
- `save_memory` description says to prefer recruiting_feedback for recruiting preferences. Kruit no
  longer has recruiting_feedback.
- `RECRUITING_ACCOUNT_WIDE_INSTRUCTIONS`: one sentence was removed here, the recruiting_feedback
  preference sentence. Merge around it.

## Verification

- Unit: the scope tests (`recruiting-defaults.test.ts recruitingAgentScope`; `builtin-tools.test.ts`
  checks real names, that every tool a skill names is offered, and the per-agent budget). The Pi
  listing and invocation tests are in `skill-tools.test.ts`, the routine fire-time expansion in
  `executor.test.ts`, and the thread filter in `schedule-tools.test.ts`.
- Eval: not run. Before merge, play the simulated customer on the branch, `pnpm sim:branch --
  --journeys` with the account-wide hand-off journeys (template, booking, change-mind-mid-run) and a
  role journey (first ten → feedback → scale-out). The risk to watch is the model calling read_file
  on the listed `skills/<name>/SKILL.md` location instead of skill_read.
