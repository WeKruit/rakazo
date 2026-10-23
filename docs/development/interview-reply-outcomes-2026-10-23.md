# Interview reply outcomes

Interview now displays a separate “Reply outcomes” section when the current role has retained failed or uncertain native Instantly replies. A completed external-effect status containing a provider error is shown as “Reply failed”; an uncertain effect is shown as “Reply outcome unknown”. Calendar event status is unchanged.

The stored receipts do not prove which booking a reply confirms. This section therefore says “These replies are not linked to a specific calendar event.” It does not infer a relationship from subject, recipient, timing or message body, and is hidden in a candidate detail view. It does not claim delivery, retry permission, or successful scheduling. No new execution workflow, table or migration is introduced.

The optional correspondence `operations` field contains the retained effect reference, original provider message reference, source name/reference, observation time and failure/uncertainty classification. Message bodies, mailbox addresses and raw provider errors are omitted. API reads require the exact actor, Space, thread, current role revision relationship and authorized source revision; current role access and native Instantly tool grants are rechecked after reading. The query retains at most 100 operations and marks the shared response partial when more records exist.

Supported here: actual `native_instantly_reply_to_email` receipts on the assigned official source with `get_email` and `list_emails` access. Other provider shapes are not guessed. Gmail reply support still depends on the assigned tool's actual schema; this development change does not assert its availability or grant access.

Validation is deterministic and offline: API tests cover completed errors versus uncertainty, privacy, wrong role/thread/owner/Space/source/revision/tool/grant, access changes during reads and bounded overflow. The Interview component test displays failed and uncertain replies separately while preserving the existing confirmed calendar event and hiding unassociated operations in candidate detail. Live delivery, provider ingestion and business acceptance remain unperformed.

Checks: `vitest run apps/api/src/recruiting-reply-outcomes.test.ts apps/web/src/pages/recruiting/InterviewTab.integration.test.tsx apps/api/src/recruiting.test.ts` passed 351 tests. API and web TypeScript checks passed, as did Biome on the changed implementation/tests/contracts. Validation used the existing calendar type corrections from development commit `90d1a1e3`; this change does not modify the calendar executor or helper.
