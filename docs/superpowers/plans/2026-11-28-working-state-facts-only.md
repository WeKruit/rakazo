# Working state from records only: one change for the recurring failures

Decision: the maintainer chose "一次改完四项" on 2026-11-28 after the root-cause report (wrong reply language, found vs shown, main chat relaying stale role lines, one-off email without a Gmail card, hand-off "no draft").

Cause: per-turn context the code writes for the model (working-state.ts, executor language notes, the send skill) contains code guesses and digests, and says "where an earlier reply says otherwise, this is what is true". When a guess is wrong the model repeats it.

Industry practice adopted:
- Delegation returns the worker's own result to the parent; the parent never infers a worker's state from its chat (Claude Code subagents, code.claude.com/docs/en/sub-agents; DeepSeek dsh-superagent router cards, already the model for working-state.ts, which rejects "infer state from free text").
- Context holds facts read from records; the rest is read just in time through tools (Anthropic, "Effective context engineering for AI agents").
- Reply language is the model's judgment from the user's own words; UI text follows the client locale (standard i18n). P9: code never reads words.
- One route per capability, chosen by a structured fact (11-27 01:52 rule), in the skill that owns sending (Agent Skills).

Changes:
1. Language. Delete the word-based detector (textLanguage, recruiterLanguage, recruiterLanguageNow, replyLanguageNote's language sentence, steering and relayed language notes, "The recruiter now writes in X"). Server-written words (round list, turn report, progress labels, menu names, web retry/continue labels) follow the recruiter's UI locale (message block uiLocale; web i18n.locale). The sims send uiLocale like the web client.
2. Main chat reads each role team's result. The card shows the team's newest message of its newest finished run as its result and "working now" while a run is active; the "posted since" digest and stale progress lines go.
3. One count. The card shows people shown (distinct people in the role's recorded rounds), not people saved; the list header drops "/ total"; the "Saved emails: none on record" line goes.
4. Sending. The "Send to people" skill states that the route is the account's fact (outreach mailbox or the recruiter's own Gmail) and gives each route its own steps; create_campaign and ensure_sender descriptions state what the tool does only.

Eval: real-user language samples, fosp, hand-off story, one-off-email, long-search-finishes; before = 96dcd1c9 gate; after = sim:branch on the PR head.
