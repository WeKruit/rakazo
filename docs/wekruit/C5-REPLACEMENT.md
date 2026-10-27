# Serialized worker replacement policy

`infra/modal/replacement.py` implements the replacement sequence against an injected driver. It imports no cloud SDK and has no deployment entrypoint. It is a local policy implementation, not evidence of a production rollout or data cutover.

The controller holds one driver fleet lease across the complete selected sequence. For each worker it requires another ready worker, requests drain, and polls authoritative observations. Drain deadline means postponed: the old worker is not stopped. After drain it stops the old worker and waits for both stopped-process confirmation and zero old-worker sessions. Disappearance alone is not confirmation. Only then can it admit a replacement with five reserved sessions; API sessions are limited to one and the complete observed global count, including unrelated sessions, to fifteen. Readiness must be confirmed before the next worker is touched. Lost peers, inconsistent accounting, errors or readiness deadlines halt the sequence.

Driver requirements are substantive: the fleet lease must serialize different controller instances, observations must include all session consumers and explicit stopped-worker records, and `start` must atomically reserve capacity against independent API/other admissions before creating a worker. A local snapshot check alone cannot prevent an external concurrent admission. No cloud implementation of these requirements is supplied or claimed tested. API rollout can remain independent if it honors the same global admission accounting. Data/source migration is separate.

A failed or postponed result reports previously completed replacements and the selected worker. There is no automatic killing of a timed-out draining worker, speculative restart, or continuation after a failed replacement. Recovery decisions require fresh authoritative observations.

Validation (synthetic fake driver only):

```sh
python3 -m unittest discover -s infra/modal -p test_replacement.py -v
python3 -m py_compile infra/modal/replacement.py infra/modal/test_replacement.py
git diff --check
```

**11 tests passed**. Scenarios cover serialized order, drain deadlines, independent process/session confirmation, readiness failure, peer preservation, global capacity including unrelated sessions, failed admission, lease contention, driver errors, disappearing workers, duplicate selections and per-worker/API limits. No actual Modal actions, resources, secrets, deployment, live database connections or real jobs/candidates were involved. Production driver, real session release latency and live replacement remain untested.
