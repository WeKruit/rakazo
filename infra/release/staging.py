#!/usr/bin/env python3
"""Run synthetic release checks in an owned, disposable native PostgreSQL cluster.

No deployment credentials, existing database URL, dotenv file or user home are
accepted. This is ephemeral staging validation, not live product acceptance.
"""

import argparse
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import tempfile


SUITES = (
    "apps/api/src/recruiting-crm-sync.postgres.test.ts",
    "packages/testkit/src/pi-offline.postgres.test.ts",
)


def isolated_env(parent: dict[str, str], directory: Path, sha: str) -> dict[str, str]:
    """Allow only executable discovery; every other setting is synthetic or local."""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Staging requires a full source SHA")
    return {
        "PATH": parent.get("PATH", os.defpath),
        "HOME": str(directory / "home"),
        "TMPDIR": str(directory / "tmp"),
        "LANG": "C.UTF-8",
        "CI": "1",
        "NODE_ENV": "test",
        "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
        "VERIFY_DATABASE": "1",
        "RAKAZO_GIT_SHA": sha,
        "AGENT_RUNTIME": "scripted",
        "SANDBOX_PROVIDER": "fake",
        "CLOUD_AGENT_PROVIDER": "emulator",
        "WAKEUP_DRIVER": "memory",
        "SECRET_STORE": "encrypted",
        "MCP_STDIO_ENABLED": "false",
        "SIGNUPS_ENABLED": "true",
        "SIGNUP_ALLOWLIST": "",
        "BETTER_AUTH_SECRET": "staging-synthetic-auth-secret-at-least-32-characters",
        "ENCRYPTION_KEY": "staging-synthetic-encryption-key-at-least-32-characters",
        "SCREEN_PROXY_SECRET": "staging-synthetic-screen-secret-at-least-32-characters",
        "BETTER_AUTH_URL": "http://127.0.0.1:5173",
        "WEB_ORIGIN": "http://127.0.0.1:5173",
        "DATA_DIR": str(directory / "data"),
        "PGUSER": "staging",
        "PGHOST": "127.0.0.1",
        "PGDATABASE": "postgres",
        "PGSSLMODE": "disable",
    }


def reject_dotenv(root: Path) -> None:
    # Prisma also loads dotenv independently of the application's NODE_ENV guard.
    for directory, folders, files in os.walk(root):
        folders[:] = [name for name in folders if name not in {".git", "node_modules"}]
        if any(name.startswith(".env") and not name.endswith(".example") for name in files):
            raise ValueError("Staging requires a checkout without dotenv files")
    if any((ancestor / ".env").exists() for ancestor in root.parents):
        raise ValueError("Staging requires checkout ancestors without dotenv files")


def run(command: list[str], root: Path, env: dict[str, str], **options):
    return subprocess.run(command, cwd=root, env=env, check=True, timeout=600, **options)


def validate_checkout(root: Path, env: dict[str, str], sha: str) -> None:
    head = run(["git", "rev-parse", "HEAD"], root, env, capture_output=True, text=True)
    if head.stdout.strip() != sha:
        raise ValueError("Staging source SHA does not match the checkout")
    status = run(
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        root, env, capture_output=True, text=True,
    )
    if status.stdout.strip():
        raise ValueError("Staging requires a clean checkout")
    reject_dotenv(root)


def postgres_bin(configured: str | None, root: Path, env: dict[str, str]) -> Path:
    if configured:
        directory = Path(configured).resolve()
    else:
        if not shutil.which("pg_config", path=env["PATH"]):
            raise ValueError("Native PostgreSQL tools are required; pass --pg-bin")
        result = run(["pg_config", "--bindir"], root, env, capture_output=True, text=True)
        directory = Path(result.stdout.strip())
    if not all(os.access(directory / tool, os.X_OK) for tool in ("initdb", "pg_ctl", "createdb")):
        raise ValueError("Native PostgreSQL initdb, pg_ctl and createdb are required")
    return directory


def free_port() -> int:
    with socket.socket() as bound:
        bound.bind(("127.0.0.1", 0))
        return bound.getsockname()[1]


def stage(root: Path, sha: str, configured_pg_bin: str | None = None) -> None:
    directory = Path(tempfile.mkdtemp(prefix="rakazo-staging-"))
    remove_directory = True
    try:
        env = isolated_env(dict(os.environ), directory, sha)
        for child in ("home", "tmp", "data"):
            (directory / child).mkdir(mode=0o700)
        validate_checkout(root, env, sha)
        binaries = postgres_bin(configured_pg_bin, root, env)
        cluster = directory / "postgres"
        port = free_port()
        env["PGPORT"] = str(port)
        run(
            [str(binaries / "initdb"), "-D", str(cluster), "--username=staging",
             "--auth=trust", "--no-locale", "--encoding=UTF8"],
            root, env,
        )
        try:
            # An occupied/raced port makes pg_ctl fail before any database command.
            run(
                [str(binaries / "pg_ctl"), "-D", str(cluster), "-l", str(directory / "postgres.log"),
                 "-o", f"-h 127.0.0.1 -p {port} -k {shlex.quote(str(directory))}",
                 "-w", "-t", "30", "start"],
                root, env,
            )
            for index, suite in enumerate(SUITES):
                database = f"staging_{index}"
                run(
                    [str(binaries / "createdb"), "--maintenance-db=postgres",
                     "--template=template0", database], root, env,
                )
                database_url = f"postgresql://staging@127.0.0.1:{port}/{database}?sslmode=disable"
                suite_env = {**env, "DATABASE_URL": database_url, "REALTIME_DATABASE_URL": database_url}
                if index == 0:
                    run(["pnpm", "--filter", "@rakazo/db", "generate"], root, suite_env)
                run(["pnpm", "--filter", "@rakazo/db", "migrate"], root, suite_env)
                run(["pnpm", "exec", "vitest", "run", suite], root, suite_env)
        finally:
            # Also attempt cleanup if startup failed after creating the owned PID file.
            if (cluster / "postmaster.pid").exists():
                try:
                    run(
                        [str(binaries / "pg_ctl"), "-D", str(cluster), "-m", "fast",
                         "-w", "-t", "30", "stop"], root, env,
                    )
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    # Never unlink the data directory of a possibly running server.
                    remove_directory = False
                    raise RuntimeError(
                        "Owned staging cluster did not stop; its temporary directory was retained"
                    ) from None
    finally:
        if remove_directory:
            shutil.rmtree(directory)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--pg-bin")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    stage(root, args.sha, args.pg_bin)
    print("Synthetic staging passed; no live product acceptance or deployment performed.")


if __name__ == "__main__":
    main()
