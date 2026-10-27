"""Offline-constructible split service definitions, never automatically registered/deployed.

Callers supply an image, secret references and a real preflight implementation.
No resource lookup, migration, activation assertion or cloud operation happens here.
"""
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Any
from urllib.parse import urlsplit

import modal

from infra.modal.service_runtime import ServiceRuntime
from infra.modal.topology import split_database_budget, session_budget


@dataclass(frozen=True)
class SplitServices:
    app: Any
    api: Any
    worker: Any
    api_lifecycle: type
    worker_lifecycle: type


def create_split_services(*, name: str, image: Any, secrets: list[Any],
                          public_url: str, root: Path, release_profile: str,
                          preflight: Callable[[str], None],
                          runtime_factory: Callable[[], ServiceRuntime] = ServiceRuntime) -> SplitServices:
    """Define two callable services without resolving any supplied remote reference.

    preflight(service) must query real activation state and verify the deployment
    writer fence before returning. It must raise on incomplete migration/activation
    or unavailable fencing. There is no default or boolean activation bypass.
    The caller owns one-shot migrations and serialized replacement independently.
    """
    if not callable(preflight):
        raise TypeError("a real preflight callable is required")
    origin = urlsplit(public_url)
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password:
        raise ValueError("public_url must be the explicit HTTPS API origin")
    session_budget(api=2, workers=2)
    app = modal.App(name)

    def lifecycle(service: str):
        class Lifecycle:
            def start_service(self):
                if preflight(service) is not None:
                    raise TypeError("preflight must raise on failure, not return an activation flag")
                runtime = runtime_factory()
                runtime.root = root
                runtime.release_profile = release_profile
                runtime.service_budget = split_database_budget
                self.runtime = runtime
                runtime.start(
                    public_url, services=(service,), migrate=False,
                    extra_env={"DATA_DIR": "/tmp/rakazo-data", "WORKER_HEALTH_PORT": "3101"},
                )

            def stop_service(self):
                runtime = getattr(self, "runtime", None)
                if runtime is not None:
                    runtime.stop()

        # Keep the exact callable lifecycle available for offline execution tests;
        # the decorated subclass is what Modal registers.
        class Service(Lifecycle):
            @modal.enter()
            def enter(self):
                self.start_service()

            @modal.exit()
            def exit(self):
                self.stop_service()

        Service.__name__ = "ApiService" if service == "api" else "WorkerService"
        Service.__qualname__ = Service.__name__
        return Lifecycle, Service

    api_lifecycle, api_class = lifecycle("api")
    worker_lifecycle, worker_class = lifecycle("worker")
    common = dict(image=image, secrets=secrets, compute_region="us-west",
                  nonpreemptible=True, cpu=(0.125, 4.0), memory=(2048, 4096),
                  startup_timeout=180, exit_grace_period=10)
    api = app.server(port=8000, min_containers=1, max_containers=2,
                     max_concurrency=128, unauthenticated=True, **common)(api_class)
    worker = app.server(port=3101, min_containers=2, max_containers=2,
                        max_concurrency=1, unauthenticated=False, **common)(worker_class)
    return SplitServices(app, api, worker, api_lifecycle, worker_lifecycle)
