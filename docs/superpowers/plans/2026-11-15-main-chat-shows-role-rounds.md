# Main chat shows the role team's rounds directly

**Goal:** When Kruit's conversation hands feedback or a request to a role team, the round that team records appears in Kruit's conversation exactly as posted. Kruit no longer retells counts, status or the list.

**Why:** On 11-15 the feedback-round journey scored 3–4/10 across eight fixes. Nearly every remaining veto came from Kruit retelling the role chat: wrong counts, "not ready" after the round was posted, internal framing, and pool pages mistaken for the round. The recruiter waited minutes for a round that already existed one chat away.

**Prior art:** A delegating agent forwards the sub-agent's artefact verbatim instead of paraphrasing it. This is the "return the artifact, not a summary" pattern in LangGraph supervisor handoffs (`output_mode="full_history"`) and in the OpenAI Agents SDK handoff, where the specialist's message reaches the user directly. We reuse our existing delegation record (`openDelegation`) and the message boundary. No new channel.

## Steps

1. `bot-messages.ts`: add `showRoundInDelegatingChat(deps, run, { text, key })`.
   - If the role thread has an open delegation, publish the round list as a bot message from the delegating bot into the delegating conversation.
   - Head it with the role's name and make it idempotent on `delegated-round:<effect id>`.
   - Red test first.
2. `executor.ts`: after `calibration_round` posts the recorded round, call it in the background. A failure only logs.
3. `returnDelegatedTeamOutcome`: when a round was already shown there since the request, do not append the round text again. Tell Kruit the list is in its conversation and not to relist or retell it. `teamProgress` says the same for a recorded round. Red test first.
4. Verify: unit tests, then the paid `us-recruiter-feedback-round` journey on staging.

Out of scope for this PR: mirroring question and next-step cards. Card answers are bound to the role run, so that is a separate step after this one is measured.
