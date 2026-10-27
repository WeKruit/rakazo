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

## SDK control audit: offline definitions are not a safe rolling implementation

Read-only inspection of the installed Modal SDK 1.6.1 identified a control gap. No cloud API was called.

- `modal/_server.py:Server.update_autoscaler` accepts min/max/target concurrency, buffer and scaling windows. Its documented minimum keeps containers alive regardless of demand; subsequent App deployments reset overrides to the decorator configuration.
- `Server._experimental_list_containers` returns container id/host/port, not an atomic admission or replacement handle. Server exposes no explicit per-container start/reservation method.
- `modal/cli/container.py:stop` sends `ContainerStop`; its `graceful=True` contract is only supported for Function containers, not Server containers. Application SIGUSR2 drain remains a separate prerequisite.
- `modal/app.py:App.deploy(strategy=...)` supports rolling or recreate. `modal/runner.py:_stop_and_wait_for_containers` stops old containers concurrently (semaphore 32), not this controller's serialized order.

Consequently a worker server with min=max=2 can automatically start a replacement after a stop, outside the fake driver's `start` reservation. Temporarily lowering min/max is not a proof: selection of a running worker for scale-down is not controlled, and deployment resets the override. Merely passing a preflight callback does not solve admission after startup. The candidate factory and its dedicated tests were removed from this PR after this review; no fixed-minimum candidate is presented as a usable two-service rollout.

A real implementation must first choose and prove its control boundary. One candidate is separately replaceable single-worker deployment slots with a persistent ready peer and drained recreate of one slot; that changes deployment topology/resources. Another is database-backed session admission before any session-mode pools open, integrated with actual platform generation retirement; admission alone can deadlock ordinary rolling because new containers wait for capacity while old containers wait for new readiness. Neither capability is claimed by the fake driver. Actual supported generation/container controls and existing deployment configuration must be resolved before selecting the live binding. The existing 15-session budget must not be increased implicitly.


## Required deployment decision

1. **Retain API + one worker service with two replicas.** The platform binding must provide proven targeted drain/stop, prevent independent autoscaler replacement from bypassing admission, and bound old/new generation overlap within 15 sessions. The current SDK source does not supply that combined guarantee. A local adapter and admission protocol can be implemented after the supported control mechanism is established; isolated-environment tests must exercise automatic replacement, crashes and rolling generation handoff before production use.
2. **API + two separately deployed single-worker slots.** Each worker slot has one container. Drain one slot, recreate only that slot after confirmed session release, verify it ready, then touch the other. Local slot definitions, driver bindings and offline tests can be written once this resource/topology change is approved. Isolated-environment validation still must prove recreate ordering, no unrequested extra replica, independent API routing, session release and long-task drain behavior. Creating or deploying those slots is not authorized by the current no-cloud-operations instruction.

Neither choice raises the 15-session limit. Timeout remains postpone/no kill. No choice was silently selected, and neither was executed against cloud resources.
