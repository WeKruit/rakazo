"""Deploy the native Rakazo Web/API/worker with external Postgres and sandbox.

Requires Modal >=1.6. Secrets and files belong to this App only; no local Docker.
"""

import contextlib
import datetime
import os
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import modal

ROOT = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/app")
APP_NAME = os.environ.get("MODAL_APP_NAME", "rakazo-recruiting")
SECRET_NAME = os.environ.get("MODAL_SECRET_NAME", f"{APP_NAME}-config")
VOLUME_NAME = os.environ.get("MODAL_VOLUME_NAME", f"{APP_NAME}-files")

app = modal.App(APP_NAME)


def source_revision() -> str:
    """The deployed source revision: the archive marker, else the local git HEAD, else unknown."""
    marker = ROOT / ".wekruit-source-revision"
    if marker.exists():
        return marker.read_text().strip()
    try:
        import subprocess
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=5).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


SOURCE_REVISION = source_revision() if modal.is_local() else "unknown"
files = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
config = modal.Secret.from_name(SECRET_NAME)
image = (
    modal.Image.from_registry("node:24.22.0-bookworm-slim", add_python="3.11")
    .apt_install("ca-certificates", "git", "openssl", "poppler-utils")
    .run_commands("corepack enable", "corepack prepare pnpm@9.15.0 --activate")
    .workdir("/app")
    .add_local_file(ROOT / "package.json", "/app/package.json", copy=True)
    .add_local_file(ROOT / "pnpm-lock.yaml", "/app/pnpm-lock.yaml", copy=True)
    .add_local_file(ROOT / "pnpm-workspace.yaml", "/app/pnpm-workspace.yaml", copy=True)
    .add_local_file(ROOT / ".npmrc", "/app/.npmrc", copy=True)
    .add_local_dir(ROOT / "patches", "/app/patches", copy=True)
    .run_commands("pnpm fetch --frozen-lockfile")
    .add_local_dir(
        ROOT,
        "/app",
        copy=True,
        ignore=modal.FilePatternMatcher(
            *(ROOT / ".dockerignore").read_text().splitlines(),
            "**/__pycache__", "**/__pycache__/**",
        ),
    )
    .run_commands(
        "pnpm install --offline --frozen-lockfile",
        "pnpm --filter @rakazo/db generate",
        "pnpm --filter @rakazo/web check",
        "RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build",
        # Precompiled API/worker entrypoints: cold start runs JavaScript, not tsx.
        "node scripts/bundle-server.mjs api worker",
    )
    .run_commands(
        "python -c \"import urllib.request; urllib.request.urlretrieve("
        "'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt',"
        "'/usr/local/share/ca-certificates/supabase.crt')\"",
        "update-ca-certificates",
    )
    .env({"NODE_EXTRA_CA_CERTS": "/usr/local/share/ca-certificates/supabase.crt"})
)


@app.server(
    image=image,
    secrets=[config],
    volumes={"/data": files},
    env={"MODAL_APP_NAME": APP_NAME, "RAKAZO_GIT_SHA": SOURCE_REVISION},
    port=8000,
    compute_region="us-west",
    unauthenticated=True,  # Native Better Auth protects application/API routes.
    min_containers=1,
    max_containers=1,  # ponytail: one native DATA_DIR writer; scale only with a shared store.
    max_concurrency=128,
    nonpreemptible=True,
    # Request is the idle reservation; the limit lets the cold start burst.
    cpu=(0.125, 4.0),
    memory=(2048, 4096),
    startup_timeout=180,
    exit_grace_period=10,
)
class Recruiting:
    @modal.enter()
    def start(self):
        boot = time.monotonic()

        def phase(name, **fields):
            extra = "".join(f" {k}={v}" for k, v in fields.items())
            stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")
            print(f"{stamp} boot.phase {name} elapsed_ms={int((time.monotonic() - boot) * 1000)}{extra}", flush=True)

        phase("boot.start")
        self.stopping = threading.Event()
        self.processes = []
        origin = Recruiting.get_url().rstrip("/")
        env = {
            **os.environ,
            "NODE_ENV": "production",
            "DATA_DIR": "/data",
            "BETTER_AUTH_URL": origin,
            "WEB_ORIGIN": origin,
            "API_URL": origin,
            "RAKAZO_HOST": urlsplit(origin).hostname,
            "API_HOST": "127.0.0.1",
            "API_PORT": "3100",
            "WEB_PORT": "8000",
            "API_PROXY_TARGET": "http://127.0.0.1:3100",
        }
        # Same migration-before-API order as the upstream Compose entrypoint.
        phase("migrate.start")
        migrate = time.monotonic()
        # Runs even with nothing pending; migrate.done shows what that costs.
        result = subprocess.run(
            ["node_modules/.bin/prisma", "migrate", "deploy"],
            cwd="/app/packages/db", env=env, timeout=120,
        )
        phase("migrate.done", migrate_ms=int((time.monotonic() - migrate) * 1000), exit_code=result.returncode)
        result.check_returncode()
        services = [
            ("api", ["node", "--enable-source-maps", "dist/index.mjs"]),
            ("worker", ["node", "--enable-source-maps", "dist/index.mjs"]),
            ("web", ["node", "node_modules/vite/bin/vite.js", "preview"]),
        ]
        for package, command in services:
            phase(f"{package}.spawn")
            self.processes.append(subprocess.Popen(
                command, cwd=f"/app/apps/{package}", env=env, start_new_session=True,
            ))

        def supervise():
            while not self.stopping.wait(2):
                if any(process.poll() is not None for process in self.processes):
                    # A live Web with a dead worker is not a healthy chat service.
                    os.kill(os.getpid(), signal.SIGTERM)
                    return

        threading.Thread(target=supervise, daemon=True).start()
        deadline = time.monotonic() + 150
        for port in (3100, 8000):
            while True:
                if any(process.poll() is not None for process in self.processes):
                    raise RuntimeError("A native Rakazo service exited during startup")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=1):
                        phase("ready.probe.ok", port=port)
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"Native Rakazo port {port} did not become ready")
                    time.sleep(0.5)

    @modal.exit()
    def stop(self):
        self.stopping.set()
        for process in reversed(self.processes):
            if process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGTERM)
        deadline = time.monotonic() + 8
        for process in self.processes:
            try:
                process.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass
        for process in self.processes:
            if process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
        for process in self.processes:
            process.wait()
        files.commit()
