"""Local orchestration policy; deployment adapters must supply authoritative observations.

No Modal SDK, credentials, or cloud actions are implemented here. The driver's lease
must serialize all fleet replacements, including those from other controller instances.
"""
from contextlib import AbstractContextManager
from dataclasses import dataclass
from time import monotonic, sleep
from typing import Callable, Protocol


@dataclass(frozen=True)
class Worker:
    id: str
    ready: bool
    drained: bool
    stopped: bool
    sessions: int


@dataclass(frozen=True)
class Fleet:
    workers: tuple[Worker, ...]
    api_sessions: int
    other_sessions: int = 0

    @property
    def sessions(self) -> int:
        return self.api_sessions + self.other_sessions + sum(w.sessions for w in self.workers)


class Driver(Protocol):
    def replacement_lease(self) -> AbstractContextManager[None]: ...
    def observe(self) -> Fleet: ...
    def drain(self, worker_id: str) -> None: ...
    def stop(self, worker_id: str) -> None: ...
    def start(self, replaced_worker_id: str, session_limit: int) -> str:
        """Atomically reserve session_limit within global 15 before creating a worker.

        The reservation must coordinate independent API/other session admission.
        Raise without creating anything when capacity cannot be reserved.
        """
        ...


@dataclass(frozen=True)
class Result:
    status: str  # completed, postponed, failed
    completed: tuple[tuple[str, str], ...]
    worker_id: str | None
    reason: str


class ReplacementController:
    WORKER_SESSIONS = 5
    GLOBAL_SESSIONS = 15

    def __init__(self, driver: Driver, *, timeout: float = 60,
                 interval: float = 1, clock: Callable[[], float] = monotonic,
                 wait: Callable[[float], None] = sleep):
        if timeout <= 0 or interval <= 0:
            raise ValueError("timeout and interval must be positive")
        self.driver, self.timeout, self.interval = driver, timeout, interval
        self.clock, self.wait = clock, wait

    def _observe(self) -> Fleet:
        fleet = self.driver.observe()
        ids = [w.id for w in fleet.workers]
        if len(ids) != len(set(ids)):
            raise ValueError("ambiguous worker identities")
        if not 0 <= fleet.api_sessions <= 1 or fleet.other_sessions < 0:
            raise ValueError("invalid API/other session accounting")
        if any(not 0 <= w.sessions <= self.WORKER_SESSIONS for w in fleet.workers):
            raise ValueError("worker exceeds session budget")
        if fleet.sessions > self.GLOBAL_SESSIONS:
            raise ValueError("global session budget exceeded")
        if any(w.ready and (w.stopped or w.drained) for w in fleet.workers):
            raise ValueError("inconsistent readiness observation")
        return fleet

    @staticmethod
    def _worker(fleet: Fleet, worker_id: str) -> Worker:
        # Disappearance is not proof of process termination or session release.
        return next(w for w in fleet.workers if w.id == worker_id)

    @staticmethod
    def _other_ready(fleet: Fleet, worker_id: str) -> bool:
        return any(w.id != worker_id and w.ready and not w.stopped for w in fleet.workers)

    def _poll(self, predicate: Callable[[Fleet], bool], peer_of: str) -> Fleet | None:
        deadline = self.clock() + self.timeout
        while True:
            fleet = self._observe()
            if not self._other_ready(fleet, peer_of):
                raise RuntimeError("ready peer lost while waiting")
            if predicate(fleet):
                return fleet
            remaining = deadline - self.clock()
            if remaining <= 0:
                return None
            self.wait(min(self.interval, remaining))

    def replace(self, worker_ids: tuple[str, ...]) -> Result:
        completed: list[tuple[str, str]] = []
        selected: str | None = None
        try:
            if len(worker_ids) != len(set(worker_ids)):
                raise ValueError("duplicate replacement targets")
            with self.driver.replacement_lease():
                for selected in worker_ids:
                    fleet = self._observe()
                    old = self._worker(fleet, selected)
                    if old.stopped or not self._other_ready(fleet, selected):
                        return Result("postponed", tuple(completed), selected, "no safe drain target/ready peer")
                    self.driver.drain(selected)
                    fleet = self._poll(lambda f: self._worker(f, selected).drained, selected)
                    if fleet is None:
                        return Result("postponed", tuple(completed), selected, "drain deadline; old worker not stopped")
                    if not self._other_ready(fleet, selected):
                        return Result("postponed", tuple(completed), selected, "ready peer lost before stop")
                    self.driver.stop(selected)
                    fleet = self._poll(lambda f: self._worker(f, selected).stopped
                                       and self._worker(f, selected).sessions == 0, selected)
                    if fleet is None:
                        return Result("failed", tuple(completed), selected, "stop/session release unconfirmed")
                    if not self._other_ready(fleet, selected):
                        return Result("failed", tuple(completed), selected, "ready peer lost before start")
                    if fleet.sessions + self.WORKER_SESSIONS > self.GLOBAL_SESSIONS:
                        return Result("postponed", tuple(completed), selected, "replacement session capacity unavailable")
                    existing = {w.id for w in fleet.workers}
                    replacement = self.driver.start(selected, self.WORKER_SESSIONS)
                    if replacement in existing:
                        raise ValueError("replacement must have a new identity")
                    fleet = self._poll(lambda f: self._worker(f, replacement).ready, replacement)
                    if fleet is None:
                        return Result("failed", tuple(completed), selected, "replacement readiness deadline")
                    completed.append((selected, replacement))
        except Exception as error:
            return Result("failed", tuple(completed), selected, f"{type(error).__name__}: {error}")
        return Result("completed", tuple(completed), None, "all selected workers replaced")
