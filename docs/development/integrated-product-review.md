# Integrated product review checkpoint

Current tested code: `11bc10727a1b1176db1a73ebb26fd6a961bc1b32`. The transfer manifest pins the following documentation-only HEAD separately. This is a local review deliverable, not a published PR or live acceptance. No new production evidence was received during these integrations.

## Preserved increments

| Increment | Integration base | Integration code HEAD | Evidence |
| --- | --- | --- | --- |
| Scheduling confirmation freshness | `eb21618279f9f69e793ec1c2962b588f8487c057` | `861dba93ef8b5d50b46bc247e5d818bbb2241782` | 402 affected checks, 49 native PostgreSQL checks; docs checkpoint `19dfb3c34d9cd3e8bb666a93bec23f4f23de6834` |
| Structured profile history | `19dfb3c34d9cd3e8bb666a93bec23f4f23de6834` | `b4e82c35ca0b8bbff78623d5fd10339b1786d362` | 288 focused checks, two actual routes; six screenshots |
| Chat/feedback presentation | `b4e82c35ca0b8bbff78623d5fd10339b1786d362` | `11bc10727a1b1176db1a73ebb26fd6a961bc1b32` | 475 affected checks, eight actual routes; twelve screenshots |

Every incremental patch has its exact base/HEAD and SHA-256 in the transfer manifest. The original artifacts remain immutable. The full patch uses preserved main `94a706a089710cea083192a126ab77a8f577e91c`; use that full patch OR the ordered deltas, never both. The bundle lists required ancestor commits. No force push or publication occurred.

## Review and limits

Read [the 59-item matrix](unified-workspace-final-status.md), [scheduling correction](scheduling-confirmation-freshness.md), [profile source diagnosis](profile-history-source-review.md), and [chat integration](chat-ui-integration.md). Parent has reviewed the integrated desktop experience and mobile education captures; new chat pixel comparison remains pending. Source/static review and actual test execution are distinguished in each note. Passing counts overlap and must not be added as unique coverage.

Recorded calendar mutation freshness is not a live Cal.com GET or atomicity across calendar/mail providers. Actual candidate raw Autumn rows, supported upstream rich-history export, and real logo availability remain unverified. Plain-only history is preserved rather than parsed into invented jobs/degrees. Automatic outreach-pause policy, unsupported availability/busy semantics, automatic immutable plan revision and unsupported cohorts/deep links remain explicitly bounded in the matrix.

The source role-correspondence patch, ordered migrations, narrow actual-caller grant and local-owner dryRun/readback procedure remain in [the earlier functional delivery](unified-workspace-delivery.md). These two UI/profile increments and the confirmation correction add no migrations, dependencies or grants. No current bot permissions were expanded. Production dry run, actual sync, email/calendar operations and live acceptance remain with the authorized local owner. This cloud task did not connect to production, deploy, send, book, run Docker or create resources. Current instruction forbids push/PR/merge/deploy; this checkpoint respects that instruction.
