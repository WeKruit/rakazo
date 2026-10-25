# Deployment and acceptance takeover — 2026-10-25

Deployment has occurred; complete CRM synchronization and end-to-end acceptance have not been established. This document transfers operational findings, not new application code or permission to mutate a deployment.

## Read first

- [Overall handoff](../2026-10-23/00-OVERALL-HANDOFF.md)
- [Development delivery](../2026-10-23/development-delivery.md)
- [CRM synchronization procedure](../../development/crm-sync-delivery-2026-10-23.md)

Use current human instructions and freshly observed runtime state. Historical handoffs and this document do not establish a current deployment, an approval, or a completed synchronization.

## Changes made by the deployment session

The deployment session did not edit application code. It applied the already-delivered migrations, updated the existing CRM MCP function, deployed the specified application revision, performed scoped acceptance checks, and kept private operational evidence locally. Those production operations cannot be reproduced by merging this documentation PR.

On 2026-10-23, application revision `e740fa441b1db2d1bc64cb546a623f4f99982042` was deployed and independently checked through the runtime revision marker, internal health/readiness endpoints, migration ledger, and matching key-file hashes.

The following existing application migrations were applied, in full-name lexical order:

1. `20261023153000_recruiting_role_playbook_stage`
2. `20261023160000_recruiting_crm_sync`
3. `20261023170000_recruiting_candidate_notes`
4. `20261023171000_recruiting_candidate_shortlisted_at`
5. `20261023172000_recruiting_calibration_rounds`
6. `20261023172000_recruiting_crm_sync_progress`

Both distinct `20261023172000_*` migrations were applied. The earlier applied migrations were checked against their source checksums. Do not deduplicate migration names by timestamp or rename an applied migration.

The source repository revision used for that earlier CRM MCP update was `11ca9c2df226782eee241fc5b36ba15600f4efcb`. Its existing source migrations were applied in order:

1. `20261023180000_crm_candidate_presence`
2. `20261023181000_crm_candidate_presence_secondary_roles`

The existing MCP function was observed active after the update. Presence protocol version 2 was checked directly and through the authenticated product-to-MCP path. No new resource, credential, or subscription was created. Subsequent source changes may exist: this historical revision is not a direction to roll the source back.

## Most recent independently observed state

The following is a point-in-time observation from 2026-10-25, not a claim about the state when this PR is read:

| Item | Observation |
| --- | --- |
| Running application marker | `fc859a8eeb95bbab559787ba3203f48a6be3d62d` |
| Internal health/readiness | Healthy, not degraded |
| Observed repository main | `f87403562e8dce0973e615e066e0c9451fdf14a3` |
| Difference from running revision | Additional calibration-waiting, vendor-copy, and profile-connection changes; not observed deployed |
| Required coordinator permission | The existing Main assignment includes `list_crm_role_correspondence`, with `allowAllTools=false` |
| Other recruiting assignments | The new role-correspondence permission was not present on the other inspected assignments |
| CRM execution | An existing `dryRun=true` execution was actively advancing through sequential requests |
| Actual CRM projections | Empty at observation; no completed real synchronization established |

The active dry run had completed its organization contact scan and role-link scan, had read stored role mail and campaign metadata, and had reached the lead phase with `skipped=[]`. Its cursor was not replaced and no competing pass was started by the observing session. Do not redeploy or begin another pass while an owner is still using that cursor.

Later releases applied additional migrations. Read the current full-name ledger rather than treating the list above as the complete present schema.

## CRM completeness findings

### Compare the same source scope

The raw source candidate-table count differs from the authorized candidate-list total because the list retains organization and archived-role filters, even when `p_not_reviewed=false`. An earlier dry run was stopped to investigate this difference. A read-only call to the exact authorized list established that its total matched the organization scan.

Use the same authorized list and filters as the synchronization. Do not treat the raw table count as an expected projection count or clear/rebuild data to make the counts agree.

Role-link reads may discover contacts absent from the initial organization scan. The link phase persists those contacts before linking them, but its contact upsert counts are not added to the organization contact-scan total. Final readback must account for source identities and role associations, not just one aggregate counter.

### Required mail could previously disappear from the report

The earlier coordinator assignment lacked `list_crm_role_correspondence`. In the earlier revision, the optional-read path mapped an unassigned tool to `supported=false`, and full synchronization advanced without recording a skipped read. Consequently, `skipped=[]` did not prove that mail was read.

The latest observed running code rejects unsupported required role mail, and the required Main permission is now present. The later dry run also had nonzero mail counts. Recheck these conditions on takeover; do not grant all tools or broaden unrelated bot permissions to bypass a failure.

## Acceptance evidence and limits

The earlier deployment session observed:

- The saved internal test reply was visible in Inbox without sending another message.
- A temporary note was saved and read back, then soft-deleted.
- A future-dated temporary reminder was created through the authenticated API, read in Tasks, and marked Done in the UI. Native date-form submission was not validated successfully.
- Navigation, chat, and profile resizing worked through keyboard and drag; widths persisted across refresh and were restored after the checks.
- Anonymous synchronization was rejected, and anonymous database reads of the projection tables were not granted. A real second-user isolation check was not completed.
- No outbound operation was observed in that deployment acceptance window. This is not a statement about all subsequent activity.

The earlier revision failed to restore non-default detail views after refresh and did not backfill historical playbook stages. Those failures were reproduced or confirmed against that earlier code. Their status on later releases must be rechecked, not inferred from the old failure or a merged fix.

A legacy calibration table and pending feedback question survived deployment. This did not prove a fresh calibration run, approval, same-task continuation, or full playbook acceptance. A real shortlist-time interaction was not performed on behalf of the recruiter. Do not infer candidate selection or calibration approval from saved results.

The deployment had a measured interruption; it was not a zero-downtime release. A separate post-readiness page/asset sample succeeded. Building or publishing an image alone did not establish runtime readiness.

## Backup and recovery boundaries

The earlier application database dump and application-file archive were checked for readability. A full database restore was not executed. CRM-wide backup was unavailable to the inspected restricted database role; the source migrations in that operation changed only a previously absent presence function, not candidate rows. Recovery boundaries were recorded privately.

Backups, credentials, raw database results, cursor tokens, private paths, customer records, and screenshots containing personal data are intentionally absent from this public PR. Obtain fresh authorized operational evidence in the destination environment. Do not assume access to another session's local filesystem.

## Next actions for the receiving session

1. Read the current human authorization, local repository instructions, working-tree status, deployment history, runtime revision marker, and full-name migration ledger. Preserve concurrent work.
2. Locate the existing synchronization owner and determine whether its dry run is still advancing, completed, or failed. Do not start a competing pass, reuse a consumed cursor, or deploy over an in-flight synchronization.
3. Review the complete dry-run report against freshly read authorized source scopes, including contacts, role associations, mail, campaigns, and leads supported by the current delivery. Stop for skipped reads, unsupported required capabilities, protocol errors, or unexplained differences. Dry run still writes temporary server-owned cursor metadata.
4. After a complete acceptable dry run, start `dryRun=false` with a new cursor under the existing authorization. Preserve records; do not clear or rebuild projections. If a request fails, inspect persisted results before starting a new pass.
5. Read back ownership scope, source identities, mapped fields, associations, archives, and duplicate behavior. Complete the documented idempotent real pass. Do not call the initial write a completed synchronization before readback.
6. Review any newer main changes and their prerequisites before choosing another release target. Check active work and backups first. Do not automatically deploy a newer main merely because it exists.
7. Recheck Inbox, detail restoration, notes, reminders, shortlist dates, panels, calibration delivery, and historical-stage behavior against the actual runtime. Use supplied real accounts for isolation. Do not send mail, approve a candidate, or answer a pending recruiter decision as a test.
8. Report actual deployed revision, full migration names, complete dry-run and real-run results, scoped readback, failures, and remaining prerequisites. Mark unavailable evidence as unverified.

This PR changes documentation only. Documentation review is not application validation, and the outstanding workflow is not marked complete.
