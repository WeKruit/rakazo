---
name: Interview materials
description: Prepare existing recruiting documents and an audience-specific interview brief, then hand verified materials to the assigned scheduling or sending specialist.
---

# Interview materials

Use for screening materials, an approved client submission or an interview brief. Reuse Review recruiting draft for message approval and Coordinate interview for scheduling. This skill grants no sending, sharing, CRM or calendar permission.

## Resolve the existing case

Read the current role, approved JD/materials and selected candidate's sources through native recruiting context, `recruiting_candidates` and `artifact_read`. Resolve ambiguity; never join people by name. Keep original references in tool calls and use readable titles/links in human replies.

Check the relevant conversation, hold/pass/withdrawal/suppression and approval receipts. Recover saved materials before asking for uploads; ask only for material unknowns. Do not change requirements, assess fit, rerank or restart research.

## Prepare the right material for the audience

- Reuse the named JD, deck if supplied, original resume and approved prescreen answers with their versions and provenance. Mark resume availability as available, missing, inaccessible or not checked. Missing a resume alone never rejects or downgrades a candidate.
- Read actual artifacts before claiming readability; metadata or PDF text extraction does not prove an image-only/protected document was read. Preserve originals. A link or summary is not automatically a requested attachment. To copy exact saved bytes use `write_file` with the real artifact reference; `attach_file` shares only to the authorized conversation.
- Before client submission or external resume sharing, verify candidate consent for the named company and recruiter approval for that audience. Sourcing or interview approval does not authorize another disclosure. Missing consent/materials blocks that action, not unrelated authorized preparation.
- Client-facing material excludes internal grades, costs and vendor names. Keep private compensation, sponsorship and HM-only feedback out of candidate-visible introductions, shared handoffs, calendar descriptions, shared memory and group attachments. Use a separate recipient-specific draft and verify its audience.
- A private filename or bot-private note is not HM-only access control. If the authorized private destination is unavailable, keep private material unsent and report the dependency; never widen access.

## Handoff and brief

Hand the assigned specialist the original case references, approved audience, versions, previously delivered/missing items, consent/approval receipts and holds. Use `handoff_to_bot` for the distinct next stage in a Crew, excluding HM-only content from shared chat. Mail/calendar/ATS/CRM actions need an assigned authorized operation; a listed connection or unsaved permission draft is insufficient.

For every interview prepare a private brief for the recruiter/authorized executive assistant: role, candidate/profile, resume or availability gap, prescreen, approved compensation context, sourced risks/questions, interviewer, actual meeting link and time in PT plus event time zone. Without a calendar receipt mark time/link proposed or unknown. Refresh it after a real event change; never create another invitation.

Reply concisely in chat unless a document was requested. State ready/missing items and next owner. Scheduled, submitted and delivered require actual receipts. Update the original tracker/CRM only through an authorized method after that receipt and verify readback. Source import is not an interview-stage writer; report unsupported updates pending.

An explicitly requested private handover uses `read_memory` and revision-checked `remember`, preserving unrelated facts; it is case context, not a reusable preference. Reminders/resume chases need authorized timing and owner; inferred playbook timings enable no routine.
