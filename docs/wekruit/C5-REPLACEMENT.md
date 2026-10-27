# Serialized worker replacement policy

`infra/modal/replacement.py` implements the replacement sequence against an injected driver. It imports no cloud SDK and has no deployment entrypoint. It is a local policy implementation, not evidence of a production rollout or data cutover.

The controller holds one driver fleet lease across the complete selected sequence. For each worker it requires another ready worker, requests drain, and polls authoritative observations. Drain deadline means postponed: the old worker is not stopped. After drain it stops the old worker and waits for both stopped-process confirmation and zero old-worker sessions. Disappearance alone is not confirmation. Only then can it admit a replacement with five reserved sessions; API sessions are limited to two and the complete observed global count, including unrelated sessions, to fifteen. Readiness must be confirmed before the next worker is touched. Lost peers, inconsistent accounting, errors or readiness deadlines halt the sequence.

Driver requirements are substantive: the fleet lease must serialize different controller instances, observations must include all session consumers and explicit stopped-worker records, and `start` must atomically reserve capacity against independent API/other admissions before creating a worker. A local snapshot check alone cannot prevent an external concurrent admission. No cloud implementation of these requirements is supplied or claimed tested. API rollout can remain independent if it honors the same global admission accounting. Data/source migration is separate.

A failed or postponed result reports previously completed replacements and the selected worker. There is no automatic killing of a timed-out draining worker, speculative restart, or continuation after a failed replacement. Recovery decisions require fresh authoritative observations.

Validation (synthetic fake driver only):

```sh
python3 -m unittest discover -s infra/modal -p test_replacement.py -v
python3 -m py_compile infra/modal/replacement.py infra/modal/test_replacement.py
git diff --check
```

**12 tests passed**. Scenarios cover serialized order, drain deadlines, independent process/session confirmation, readiness failure, peer preservation, global capacity including unrelated sessions, failed admission, lease contention, driver errors, disappearing workers, duplicate selections and per-worker/API limits. No actual Modal actions, resources, secrets, deployment, live database connections or real jobs/candidates were involved. Production driver, real session release latency and live replacement remain untested.

## Offline SDK service factory

`split_services.py` defines two real Modal 1.6.1 servers using injected image and secret references, without importing the deployment app or resolving resources. API: port 8000, min 1/max 2; worker: private health port 3101, min/max 2. Each decorated enter/exit calls the shared ServiceRuntime for only its own process, with no startup migrations and disposable `/tmp/rakazo-data`; no shared writable volume is mounted. Stable worst-case sessions are 2 + 2×5 = 12. Whole-generation replacement is not authorized by this factory; use the serialized replacement policy.

Every enter requires an injected preflight callable that must query activation state and verify the deployment writer fence, raising on failure. Boolean return values are rejected. This contract has no production implementation here, so these definitions do not prove cutover readiness. One-shot migrations, real activation checks, writer fencing, storage configuration, concrete image/secret binding and deployment remain external prerequisites.

Installed fixed `modal==1.6.1` in an isolated temporary virtual environment, leaving the system's older SDK unchanged. Tests construct real SDK Server objects and execute their registered decorated lifecycle functions with a fake runtime; no authentication, hydration, named-resource resolution, network/cloud calls or deployment occurs. SDK tests **5 passed**; all `infra/modal/test_*.py` tests **25 passed** under 1.6.1. Python compilation and diff checks passed. These tests validate accepted signatures and local orchestration wiring, not remote serialization or live service behavior.

```sh
python -m unittest discover -s infra/modal -p test_split_services.py -v
python -m unittest discover -s infra/modal -p 'test_*.py' -v
python -m py_compile infra/modal/split_services.py infra/modal/test_split_services.py
```
