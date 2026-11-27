# A role team's card shows in the main chat

**Goal:** when a role team stops on a card (question, form or approval) during work the main
chat delegated, the recruiter sees and answers that card in the main chat. The answer reaches
the waiting team run. Kruit is not woken with a "waiting" message.

**Why:** staging logged 194 "delegated team block not reported" warnings in 24 h. The report
ran after the run was paused (`waiting_input`), and the message path accepts only a finished
source run, so every report failed and the recruiter waited in silence. Workloop does it this
way: a child agent waiting on a person posts its card in the user's thread, and the decision
is routed back to that child by its agent id. The parent receives nothing and is not suspended.
See the merged reliability plan, step S1.

**Design (reuses the existing card, answer and expiry paths):**
1. Ask blocks get an optional `answerTarget {threadId, runId, messageId}` that points at the
   source card.
2. When a delegated team run pauses on a card, a copy is written into the delegating
   conversation in the same transaction-safe way as other messages: Kruit's bot, the source
   run id, `answerTarget`, and the `delegated-ask:<source message>` client nonce, so a replay
   writes it once. This replaces the failed "waiting" status message.
3. Answering the copy routes to the source card. The API resolves `answerTarget` within the
   actor's space and user, then uses the existing `answerRunInput`.
4. Any change to the source card (answered, expired) is copied onto each mirror. Mirrors share
   the source run id, so they are found by run id outside the source thread.
5. Shared core counts an open card that carries `answerTarget` as answerable, so web and
   mobile need no per-surface change.

**Tests (red first):** db mirror and sync (copy written once; answering through the mirror
answers the source and closes both; expiry closes both); core answerable check.

**Eval:** a new journey, `team-stuck-tell-me`, owned by the eval thread. The staging metric is
24 h of "team block not reported" warnings dropping from 194 to 0.
