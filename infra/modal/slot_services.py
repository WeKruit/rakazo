"""Definitions only: callers supply built images and existing secrets; no remote lookup."""
from dataclasses import dataclass
from pathlib import Path
import re
import json
import hashlib
from weakref import WeakKeyDictionary
from typing import Any
from urllib.parse import urlsplit
import modal
from infra.modal.service_runtime import ServiceRuntime
from infra.modal.topology import split_database_budget, session_budget


@dataclass(frozen=True)
class SlotApp:
    app: Any
    server: Any
    slot: str
    generation: str


_definitions = WeakKeyDictionary()

def checked_slot_definition(app):
    definition = _definitions.get(app)
    if definition is None:
        raise ValueError("deployment entry was not produced by the guarded slot definition")
    return definition


def verify_build_manifest(root, process, generation):
    directory=root / "apps" / process / "dist"
    manifest=json.loads((directory / "build-manifest.json").read_text())
    if manifest.get("sessionAdmissionProtocol") != 1 or manifest.get("sourceRevision") != generation:
        raise ValueError("image source manifest does not match generation/protocol")
    if manifest.get("sha256") != hashlib.sha256((directory / "index.mjs").read_bytes()).hexdigest():
        raise ValueError("image bundle hash does not match manifest")


def define_slot_apps(*, names: dict[str, str], image: Any, secrets: list[Any],
                     generation: str, public_url: str, root: Path,
                     runtime_factory=ServiceRuntime) -> dict[str, SlotApp]:
    """Construct three independent App objects offline, without hydration or deployment.

    generation must identify the injected image's built source, never a mutable Secret.
    Node startup requires verified storage cutover, an explicitly configured external
    session budget, and matching desired worker generation in the database. No local
    boolean or callback can bypass those checks. There are no shared writable volumes.
    """
    slots = ("api", "worker-a", "worker-b")
    if set(names) != set(slots) or len(set(names.values())) != 3 or not all(names.values()):
        raise ValueError("three distinct explicit App names are required")
    if not re.fullmatch(r"[0-9a-f]{40}", generation):
        raise ValueError("generation must be the built image source commit")
    origin = urlsplit(public_url)
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password:
        raise ValueError("explicit HTTPS API origin required")
    session_budget(api=2, workers=2, migrations=1)
    result = {}
    for slot in slots:
        app = modal.App(names[slot])
        process = "api" if slot == "api" else "worker"
        def lifecycle_for(slot=slot, process=process):
            class Lifecycle:
                def start_service(self):
                    # New serialized lifecycle checks even an old image/bundle lacking Node guards.
                    verify_build_manifest(root, process, generation)
                    runtime = runtime_factory()
                    runtime.root, runtime.release_profile = root, "production"
                    runtime.service_budget = split_database_budget
                    self.runtime = runtime
                    runtime.start(public_url, services=(process,), migrate=False,
                                  extra_env={"DATA_DIR": "/tmp/rakazo-data", "WORKER_HEALTH_PORT": "3101",
                                             "RAKAZO_SESSION_SLOT": slot, "RAKAZO_GIT_SHA": generation})
                def stop_service(self):
                    if getattr(self, "runtime", None) is not None:
                        self.runtime.stop()
            class Service(Lifecycle):
                @modal.enter()
                def enter(self):
                    self.start_service()
                @modal.exit()
                def exit(self):
                    self.stop_service()
            Service.__name__ = Service.__qualname__ = "Api" if process == "api" else "Worker"
            return Lifecycle, Service
        lifecycle, service_class = lifecycle_for()
        server = app.server(image=image, secrets=secrets,
                            port=8000 if process == "api" else 3101,
                            min_containers=1, max_containers=2 if process == "api" else 1,
                            max_concurrency=128 if process == "api" else 1,
                            unauthenticated=process == "api", nonpreemptible=True,
                            compute_region="us-west", startup_timeout=180, exit_grace_period=10)(service_class)
        result[slot] = SlotApp(app, server, slot, generation)
        _definitions[app] = result[slot]
    return result
