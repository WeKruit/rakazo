# Policy Into Instructions (Harness Repair Step B) Plan

**Goal:** code-written text the model reads (tool results, wakes, per-turn notes, injected system-prompt clauses) states facts only; how to act lives in the agents' instruction files and skills (AGENTS.md P8, P9, P10, P21; Development standard 7).

**Mechanism and source:** Claude Code and Agent Skills. Standing behaviour lives in the agent's instruction file (CLAUDE.md, a subagent's own system prompt) and task know-how in SKILL.md files; a tool result returns data and a background notification states what happened ("Job X ended (status)", Workloop deliver.go:87-105). Anthropic's "Writing tools for agents": a tool description explains the tool and when to use it, not how to talk to the user.

**Spec:** /mnt/project-files/kruit/harness-audit-20261128/README.md, every row tagged RULE-7 in its four layer files (53 rows). `ex` = packages/adapters/src/executor.ts, `pi` = packages/adapters/src/pi-runtime.ts, `ev` = packages/db/src/events.ts. Line numbers are at cd16e70d1.

**Homes used:**
- `RECRUITER_LANGUAGE`, `RECRUITING_RESPONSIBILITIES`, `RECRUITING_ACCOUNT_WIDE_INSTRUCTIONS` and the skills in `RECRUITING_DEFAULT_SKILLS` (packages/core/src/recruiting-defaults.ts).
- For behaviour every bot shares (not only recruiting): that tool's own description in packages/adapters/src/builtin-tools.ts.

Each move is merged into the existing sentence; a rule that already exists means only the code string is deleted.

**Collisions:** step A deletes the runtime pieces, step C the skill loader, step D the delegation tools and their report texts. Rows in those parts are listed, not touched.

## Rows

### Layer 1: loop, turns, queue

| Row | String | Where | Decision |
|---|---|---|---|
| 1-6 | "Continue the original task… Do not stop after a tool call" | pi:189-196, 805-842 | Deleted by step A (silent-tool continuation) |
| 1-7 | `REPORT_BEFORE_END` | turn-report.ts:249, pi:830 | Deleted by step A |
| 1-30 | "Respond to the user's steering context." | ev:2319 | Deleted by step A (continuation runs) |
| 1-31 | `STEERING_ACK` "Address it and continue" | ex:1302 | Deleted by step A |
| 1-34 | `chatReplyToAsk` "Take it as the recruiter's answer and act on it…" | ev:268 | Moved. The note becomes the fact (typed in the chat, not on the card; the card is closed). The rule already exists in RESPONSIBILITIES ("A question the recruiter answered by typing… act on it, never ask it again"); its "if it is about something else, ask again" half is merged into that sentence. |
| 1-35 | Ask gating: "If that reply answers it, use it and continue…" / `ASK_SUPERSEDED_BY_MESSAGE` "act on it, and ask this question again only if…" | pi:1982, pi:3327 | Moved, to the same merged RESPONSIBILITIES sentence as 1-34; the results keep only the facts. The gating code itself (`beforeAsk`, ex:12723) goes with step A's one live turn per agent. |
| 1-42 | Agent-run wake "agent_run with runId X collects it" | recruiting-agent-run-wait.ts:61 | Deleted. "Find more people" already says to collect a left-running search with agent_run. The run id and the other facts stay. |
| 1-45 | `stoppedPreviousRunNotice` | ex:14695-14717 | Deleted by step A |
| 1-46 | Resume brief | ex:14757-14850 | Deleted by step A |
| 1-72 | `newerRequestElsewhere` "A final reply of exactly NO_RESPONSE posts nothing" | ex:1284 | Deleted by step A (reply dropping) |

### Layer 2: subagents, hand-off, result return

| Row | String | Where | Decision |
|---|---|---|---|
| B3 | "report back to the user instead of messaging another bot" | adapters bot-messages.ts:154, agent-connections.ts:251 | Deleted. The error states the limit and that nothing was sent; the model reports a failed send unprompted. |
| B4 | Result/status wake "Relay it to the user now… not acceptable… Do not stay silent" | core bot-messages.ts:173 | Moved. The wake states the intent. The recruiting rule already exists: the account-wide instructions say "you tell the recruiter what it says… never list them again", and RESPONSIBILITIES says a returned result is already shown. For every other bot, "a returned result or status is told to the user" is merged into the `message_bot` description. |
| B5 | Request wake "This is a request. Complete it… use message_bot only for…" | core bot-messages.ts:178 | Deleted. It keeps only the fact of where the final reply goes; the usage clause repeats the `message_bot` description. |
| B11 | `teamWorking` "never list, name or count people… say in one line that…" | ex:4228 | Moved, into the account-wide instructions' "Showing a role's saved people" sentence. The result keeps the team's progress and that the round comes once, checked. |
| C7 | "(…the mail status above is authoritative)" | adapters bot-messages.ts:751 | Step D (result-return report text) |
| D4 | Hop error "finish the current stage in the shared thread instead" | group-handoff.ts | Step D (handoff_to_bot) |
| D9 | Stage report texts with the NO_RESPONSE hint | group-handoff.ts | Step D (report texts) |
| D22 | Group roster policy lines ("Never decline…", "A handoff transfers ownership…", "hand that stage on…") | core bot-messages.ts:130-140 | Step D. This is handoff policy: D decides the handoff model, and these lines contradict RESPONSIBILITIES ("never back to the teammate who handed it"). |
| D23 | Teammate directory "Use message_bot for useful updates… do not poll…" | core bot-messages.ts:113 | Deleted. It repeats the `message_bot` description word for word. |

### Layer 3: tools, results, skills

| Row | String | Where | Decision |
|---|---|---|---|
| 13 | `OPERATIONS_ELSEWHERE` "…are done in that role's conversation" | mcp-connector.ts:749 | Deleted. It becomes the fact of what this catalog leaves out; the account-wide instructions already send the work to the role. |
| 28 | `recruiting_research` description: "Who to show is your judgment… closing line says how many and why… never list the people again" | builtin-tools.ts:713 | Moved, merged into RESPONSIBILITIES' "apart from choosing who a round shows". The description keeps what the tool does and what `groupOf` means. |
| 29 | `recruiting_feedback` description: "then start the scale-out in the same turn; never ask them to confirm the round again", "never tell the recruiter… unless…" | builtin-tools.ts:782 | Deleted. "Find more people" (accept is recorded at once, never ask again, then search) and RECRUITER_LANGUAGE ("Facts come only from tool results") already hold both rules. |
| 30 | `recruiting_candidates` description: "tell the user which role", "never report them as 0 sent… call activate_campaign with send_now", "speak to the recruiter using candidate names" | builtin-tools.ts:699 | Deleted. These are already covered: the account-wide instructions name each role, RECRUITER_LANGUAGE says "Queued is not sent" and keeps no IDs, and send now is in "Send to people" (row 32). The facts stay. |
| 31 | `find_emails` description: "never asking which", "so never check credits or hold back a lookup" | mcp-connector.ts:475 | Moved. "Next ones on a repeat ask, never asking which" is merged into "Find contacts"; the credits rule already exists there. The facts stay. |
| 32 | Instantly write descriptions: pause "never pause it on your own… offer send_now"; activate "do not refuse or ask for a thread", "Never tell the recruiter a queue cannot be sped up"; reply "never refuse or say there is no approval flow" | instantly-native-writes.ts:322, 328, 340 | Moved. Pause and send now are merged into "Send to people" ("A confirmed card means sent…"). The reply rule already exists in "Answer candidate replies" ("call it rather than pasting the text"). |
| 36 | `teamWorking` result | ex:4228 | Same row as B11 |
| 37 | `fewerThanAsked` "List on now, in this turn: call list again…" | ex:4309 | Moved, into the account-wide instructions' "who is in a role" read. The result keeps the count and the cursor. |
| 39 | Contact batch done "Report the counts… now." | ex:4905 | Deleted. The fact that everyone is looked up stays. |
| 41 | calibration_round refusal "Record only people no round has shown, or say that nobody new fits yet." | ex:5031 | Deleted. The description ("a round of only such people is refused") and "Find more people" ("Later rounds show nobody an earlier round showed") already say it. |
| 42 | message_user truncation "never the final answer. Put your complete answer…" | ex:10542 | Deleted. The `message_user` description already says it; the fact (cut at 500, the user saw only that) stays. |
| 43 | end_call "finish any remaining work as a normal chat reply" | ex:10068-10069 | Deleted. The `end_call` description already says it; the facts stay. |
| 44 | `SHOW_SAVED_STEPS` "In your reply, show the recruiter every saved email…" | instantly-native-writes.ts:1873 | Moved, merged into "Send to people" route 1's ensure_role_campaign step. The `next` field is removed. |
| 45 | `refusedMessage` "Do this work with X instead… Never name this connection…" | mcp-connector.ts:3056-3060 | Deleted. The message keeps the refusal and which other assigned tools do this work; RECRUITER_LANGUAGE already forbids naming a vendor. |
| 47 | skill_create hint "Mention /Name so the user can open it." | skill-tools.ts:181 | Deleted. The rule already exists in the skill catalog text, which is step C's (row 68). |
| 51 | Silent tool continuation | pi:189-196 | Deleted by step A |
| 64 | Disabled computer tools "Use the connected… report the exact connection that is missing" | ex:14230 | Deleted. RESPONSIBILITIES already says to work through assigned connections and request_connection; the fact stays. |
| 68 | Skill catalog prose ("/Name", "@Name", "The Pi runtime already understands this format") | core agent-skill.ts:225-238 | Step C (skill loader moves to Pi's skills) |

### Layer 4: memory, context, injected text

| Row | String | Where | Decision |
|---|---|---|---|
| 2 | `RECRUITING_PRESENTATION_INSTRUCTION` | recruiting-context.ts:39, ex:14598, pi:2424 | Moved. The constant is deleted from the system prompt and from the subagent prompt. RECRUITER_LANGUAGE already holds one assistant, no IDs, one question card and queued-is-not-sent; its missing half ("never ask the recruiter to supply an ID") is merged into RECRUITER_LANGUAGE's IDs sentence. |
| 5 | History-retrieval paragraph | ex:14604 | Moved, into the `search_history` description, which already carries most of it. The rest is merged there: check the visible conversation first, ask which project when several match, snapshots are not facts. |
| 6 | Group roster | core bot-messages.ts:119-142 | Same row as D22, step D |
| 11 | Current-time block "Treat this as the present…", "Never infer…" | current-time.ts:23-25 | Moved. The date and the week ahead stay as facts. "A weekday offered without a date is the next one" is merged into "Book or move an interview" step 2. The rest is deleted, since the model does it unprompted given the date. |
| 14 | Role context preambles (search filters, approvals, outside data, "Relay… through the research agent", "Recover the original human messages…") | recruiting-context.ts:128-131, 168, 176 | Moved. The blocks keep their data labels. Approvals and outside data already exist in RESPONSIBILITIES and are deleted. "A search filter or unconfirmed inference rules no one out" is merged into RESPONSIBILITIES. "Show a draft's recipient" is merged into "Write an email or template". The retired research-agent relay is deleted (P10). |
| 20 | Working-state instructions | working-state.ts | Step A |
| 25 | Resume brief | ex:14738-14840 | Deleted by step A |
| 26 | Stopped-run notice | ex:14696-14722 | Deleted by step A |
| 27 | Routine prior runs "Build on them: skip what is already reported…" | ex:14907 | Moved, into the `schedule_create` description: a recurring job's runs see its last replies and report what changed. |
| 28 | Routine probe "tell the user if it keeps failing" | ex:14949 | Deleted. The exit code and output stay. |
| 29 | Native message source how-to (read_history, artifact_read, "locate the saved originals… before asking for reattachment") | ex:14223 | Moved. The reference keeps its data: the files on this message only, and UTF-16 selections. Finding earlier attachments in history is merged into the `search_history` description, and `read_history` and `artifact_read` already describe the rest. |
| 30 | Attached-file note "that read is your file read; never read it again… only if your next step needs" | ex:11759 | Deleted. The note says the file is read and where the rest starts. |
| 32 | Signing note "sign emails… never ask which name" | recruiter-name.ts:13 | Moved. The note states the account name. "Their account name signs when no saved signature" is merged into "Write an email or template". |
| 40 | `STEERING_ACK` / `EARLIER_STEERING` | ex:1299-1303 | Deleted by step A |
| 41 | Silent-tool continuation | pi:189-196, 806-834 | Deleted by step A |
| 44 | Bot-message wake prompt | core bot-messages.ts:162-189 | Same rows as B4 and B5 |

## Counts

53 rows:
- 18 moved: 1-34, 1-35, B4, B11, 28, 31, 32, 36, 37, 44, 4-2, 4-5, 4-11, 4-14, 4-27, 4-29, 4-32, 4-44.
- 16 deleted because the rule exists or the model does it unprompted: 1-42, B3, B5, D23, 13, 29, 30, 39, 41, 42, 43, 45, 47, 64, 4-28, 4-30.
- 13 deferred to step A: 1-6, 1-7, 1-30, 1-31, 1-45, 1-46, 1-72, 51, 4-20, 4-25, 4-26, 4-40, 4-41.
- 5 deferred to step D: C7, D4, D9, D22, 4-6.
- 1 deferred to step C: 68.

## Tests

Pins on old sentences are deleted, not rewritten (Development standard 3): current-time, recruiting-agent-run-wait, recruiting-context, the core bot-messages wake, skill-tools hint, the executor attached-file pin and the mcp-connector refusal. The changes are checked with typecheck (core, adapters, db), the vitest suites of core, adapters and db, biome, and `node scripts/check-dev-standard.mjs`.

Eval: none run. These are wording moves of existing rules. The behaviour check is the playbook journeys after deploy (`pnpm sim:branch -- --journeys <name>`); this plan does not run them.
