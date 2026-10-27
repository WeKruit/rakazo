"""Deploy the native Rakazo Web/API/worker with external Postgres and sandbox.

Requires Modal >=1.6. Secrets and files belong to this App only; no local Docker.
"""

import contextlib
import datetime
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import modal

ROOT = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/app")
# The container runs this file outside the checkout; its source copy lives in /app.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from infra.modal.release_config import check_staging_database, public_origin, reject_staging_dotenv, release_profile, staging_environment  # noqa: E402
RELEASE_PROFILE = release_profile(os.environ)
APP_NAME = os.environ.get("MODAL_APP_NAME", "rakazo-recruiting")
SECRET_NAME = os.environ.get("MODAL_SECRET_NAME", f"{APP_NAME}-config")
VOLUME_NAME = os.environ.get("MODAL_VOLUME_NAME", f"{APP_NAME}-files")
# Per-service database pool and worker slots; the budget is explained where the services start.
SERVICE_ENV = {
    "api": {"DB_POOL_MAX": "6"},
    "worker": {"DB_POOL_MAX": "5", "GRAPHILE_WORKER_CONCURRENCY": "10"},
}
# With DATABASE_URL on the transaction-mode pooler, queries borrow a database backend only while
# they run, so pools and job slots can grow; only the session clients count against the 15.
SPLIT_SERVICE_ENV = {
    "api": {"DB_POOL_MAX": "20"},
    "worker": {"DB_POOL_MAX": "20", "GRAPHILE_WORKER_CONCURRENCY": "50"},
}


def service_budget(environ):
    """Session URL separate from DATABASE_URL means queries go through a transaction-mode pooler."""
    session = environ.get("REALTIME_DATABASE_URL")
    return SPLIT_SERVICE_ENV if session and session != environ.get("DATABASE_URL") else SERVICE_ENV

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
files = modal.Volume.from_name(VOLUME_NAME, create_if_missing=False)
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
        "RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web build",
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
    env={"MODAL_APP_NAME": APP_NAME, "MODAL_SECRET_NAME": SECRET_NAME, "MODAL_VOLUME_NAME": VOLUME_NAME,
         "MODAL_ENVIRONMENT": os.environ.get("MODAL_ENVIRONMENT", "main"),
         "RAKAZO_RELEASE_PROFILE": RELEASE_PROFILE, "RAKAZO_GIT_SHA": SOURCE_REVISION},
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
        from infra.modal.service_runtime import ServiceRuntime
        self.runtime = ServiceRuntime()
        self.runtime.root = ROOT
        self.runtime.release_profile = RELEASE_PROFILE
        self.runtime.service_budget = service_budget
        self.runtime.start(Recruiting.get_url(), commit_volume=files.commit)

    @modal.exit()
    def stop(self):
        self.runtime.stop()
