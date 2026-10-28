"""Shared local process lifecycle; no Modal calls or resources are created here."""
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
from infra.modal.release_config import public_origin, staging_environment, reject_staging_dotenv, check_staging_database

class ServiceRuntime:
    def start(self, public_url, services=("api", "worker"), migrate=True, commit_volume=None, extra_env=None):
        boot = time.monotonic()

        def phase(name, **fields):
            extra = "".join(f" {k}={v}" for k, v in fields.items())
            stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")
            print(f"{stamp} boot.phase {name} elapsed_ms={int((time.monotonic() - boot) * 1000)}{extra}", flush=True)

        phase("boot.start")
        self.stopping = threading.Event()
        self.processes = []
        origin, modal_host = public_origin(os.environ, public_url.rstrip("/"))
        env = {
            **os.environ,
            "NODE_ENV": "production",
            "DATA_DIR": "/data",
            "BETTER_AUTH_URL": origin,
            "WEB_ORIGIN": origin,
            "API_URL": origin,
            "RAKAZO_HOST": urlsplit(origin).hostname,
            "RAKAZO_ALLOWED_HOSTS": modal_host,
            "API_HOST": "127.0.0.1",
            "API_PORT": "3100",
            "WEB_PORT": "8000",
            "API_PROXY_TARGET": "http://127.0.0.1:3100",
        }
        if self.release_profile == "staging":
            env = staging_environment(os.environ, origin, os.environ.get("RAKAZO_GIT_SHA", ""))
            Path(env["HOME"]).mkdir(parents=True, exist_ok=True)
            # Prisma loads dotenv independently. Verify isolation before any migration.
            reject_staging_dotenv(self.root)
            check_staging_database(env, self.root)
        env["WEB_STATIC_DIR"] = "/app/apps/web/dist"
        env.update(extra_env or {})
        self.commit_volume = commit_volume
        # Same migration-before-API order as the upstream Compose entrypoint.
        if migrate:
            phase("migrate.start")
            migrate = time.monotonic()
            # Runs even with nothing pending; migrate.done shows what that costs.
            # Prisma migrate holds a session advisory lock, so it needs the session connection.
            migrate_env = {**env, "DATABASE_URL": env.get("REALTIME_DATABASE_URL") or env["DATABASE_URL"]}
            result = subprocess.run(
                ["node_modules/.bin/prisma", "migrate", "deploy"],
                cwd="/app/packages/db", env=migrate_env, timeout=120,
            )
            phase("migrate.done", migrate_ms=int((time.monotonic() - migrate) * 1000), exit_code=result.returncode)
            result.check_returncode()
        services = [(package, ["node", "--enable-source-maps", "dist/index.mjs"]) for package in services]
        for package, command in services:
            phase(f"{package}.spawn")
            # The session-mode pooler admits 15 clients in total, and a recreate can briefly run
            # two containers. With everything on it: API 6 + worker 5 + one realtime LISTEN each
            # = 13, so an overlapping container or a stale client fills it. With queries on the
            # transaction-mode pooler, each container holds only 6 session clients (two LISTEN,
            # graphile's runner pool of 4 with its LISTEN and the reconciler's lock), 12 for two.
            # Each job slot holds a whole run, mostly waiting on the model, so slots, not
            # connections, set how many recruiters run at once.
            service_env = {**env, **self.service_budget(env).get(package, {})}
            self.processes.append(subprocess.Popen(
                command, cwd=f"/app/apps/{package}", env=service_env, start_new_session=True,
            ))
            if package == "worker":
                Path("/tmp/rakazo-worker.pid").write_text(str(self.processes[-1].pid))

        def supervise():
            while not self.stopping.wait(2):
                if any(process.poll() is not None for process in self.processes):
                    # A live Web with a dead worker is not a healthy chat service.
                    os.kill(os.getpid(), signal.SIGTERM)
                    return

        threading.Thread(target=supervise, daemon=True).start()
        deadline = time.monotonic() + 150
        for port in ((3100, 8000) if any(package == "api" for package, _ in services) else (int(env["WORKER_HEALTH_PORT"]),)):
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
        if self.commit_volume:
            self.commit_volume()
