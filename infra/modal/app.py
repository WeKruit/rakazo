"""Deploy the native Rakazo Web/API/worker with external Postgres and sandbox.

Requires Modal >=1.6. Secrets and files belong to this App only; no local Docker.
"""

import contextlib
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
files = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
config = modal.Secret.from_name(SECRET_NAME)
image = (
    modal.Image.from_registry("node:24.22.0-bookworm-slim", add_python="3.11")
    .apt_install("ca-certificates", "git", "openssl")
    .run_commands("corepack enable", "corepack prepare pnpm@9.15.0 --activate")
    .add_local_dir(
        ROOT,
        "/app",
        copy=True,
        ignore=modal.FilePatternMatcher(
            *(ROOT / ".dockerignore").read_text().splitlines(),
            "**/__pycache__", "**/__pycache__/**",
        ),
    )
    .workdir("/app")
    .run_commands(
        "pnpm install --frozen-lockfile",
        "pnpm --filter @rakazo/db generate",
        "pnpm --filter @rakazo/web check",
        "RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build",
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
    env={"MODAL_APP_NAME": APP_NAME},
    port=8000,
    unauthenticated=True,  # Native Better Auth protects application/API routes.
    min_containers=1,
    max_containers=1,  # ponytail: one native DATA_DIR writer; scale only with a shared store.
    max_concurrency=32,
    cpu=(0.125, 0.5),
    memory=(2048, 4096),
    startup_timeout=180,
    exit_grace_period=10,
)
class Recruiting:
    @modal.enter()
    def start(self):
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
        subprocess.run(
            ["pnpm", "--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"],
            cwd="/app", env=env, timeout=120, check=True,
        )
        services = [
            ("api", ["node", "--import", "tsx", "src/index.ts"]),
            ("worker", ["node", "--import", "tsx", "src/index.ts"]),
            ("web", ["node", "node_modules/vite/bin/vite.js", "preview"]),
        ]
        for package, command in services:
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
        for process in self.processes:
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        files.commit()
