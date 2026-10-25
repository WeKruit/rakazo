# Grokbot recruiting flow vs Rakazo (2026-10-25)

Source: grokbot's own nine-step write-up, its Sourcer chat (Oct 19–25) and Rakazo `main` at 8406abd0.
Grokbot said Rakazo only covers JD → sourcing → calibration. That is wrong for most of steps 3–8;
the table checks the code. "Covered" means the code path exists, not that the step passed a real business run; see `docs/research/grok-autumn-2026-10-25/` for evidence levels.

| # | Grokbot step | Rakazo today | Gap |
|---|---|---|---|
| 1 | JD and role setup, recruiter approves JD, pay range, company name on JD | Main intake + brief confirmation card (`recruiting_request_approval` stage brief), JD/deck documents gate, named/anonymous JD PDF rule in intake skill | Brief now must state titles, core duties, years range, location order, language (this PR). |
| 2 | Sourcing: ~10 calibration profiles, feedback, then full run | Calibration rounds (`calibration_round`, round panel, accept), Sourcer scales on the research provider with every round's feedback | Request quality was the gap: ported grokbot's search brief template and A/B evidence grading (this PR). Calibration still uses the quick people search (#108), which matches title/company; picks now favour core-duty wording. |
| 3 | Enrichment, hold risky emails | Outreach bot + contact backfill (`recruiting-contact-backfill.ts`), personal-email default, "verify contacts before import" | No explicit "hold risky / name mismatch" bucket in code; prompt-level only. |
| 4 | Outreach copy approval | `ensure_role_campaign`, draft campaigns, `activate_campaign` confirmation card, sequence tab | AE-vs-BDR title rule added (this PR). |
| 5 | Per-role prescreen after reply | Reply cards (`reply_to_email`, `recruiting_reply`), stop-on-reply | No per-role prescreen question set stored on the role. Biggest real gap. |
| 6 | Intro candidate to HM, approval each time | Scheduling bot, Gmail intro draft rule, native approval cards | Covered by approval cards; no dedicated "intro to HM" object. |
| 7 | Book interviews, reminders | `recruiting_scheduling` plan → book → confirm with readback, Interview tab/calendar, `recruiting_reminders` | Covered. |
| 8 | HM feedback, pass/advance, write back to CRM | `recruiting_feedback` hold/pass/resume, CRM import/sync (`recruiting-crm-sync.ts`), Notes | Pass/advance is role-local; CRM stage write-back exists for imports, not every HM outcome. |
| 9 | Advance in the ATS (paused since 9/22) | Nothing | Not built; paused upstream too. |

Pain points grokbot listed, mapped:
- Unstable sourcing quality → this PR (template, evidence-only grading, title-only rejected).
- Long tasks restarting / progress spam → provider task continuation + "one progress line" rule already in the playbook.
- Sending-service errors, verification credits, bounce pauses → no credit or bounce monitor in Rakazo yet.
- Tracker / DB / campaign drift → Rakazo has one DB plus CRM sync; campaign counts are read live.
- Approvals scattered across chats → Inbox tab and native approval cards exist per role; no cross-role approval inbox.

Suggested next: per-role prescreen questions on the role record (step 5), then a cross-role approvals view.
