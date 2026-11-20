"""A branch's own backend for the simulated customer, so a change is played before it merges.

A Modal Sandbox runs the testkit harness in --serve mode on this checkout: a fresh database, the
emulated email and connectors, the real model. It receives only the model setting from the test
environment's Secret, can reach only the model host, and stops itself after --minutes.

  pnpm sim:branch [--minutes 60] [--search] [--web] [--env RAKAZO_NAME=value ...] [-- <simulated-customer args>]

--search also passes staging's people-search key and lets the backend reach only that service, for
the paid plays (feedback rounds, long searches). --web builds and serves this branch's web pages
through a second tunnel, for --ui and page plays. A second fresh account stands in for staging's
copied "batch" account, so its plays start empty here.

--env RAKAZO_SIM_SANDBOX=desktop runs the agent's shell commands inside this Sandbox (default: fake).

Without simulated-customer args it plays the free journeys that need no mailbox, copied account or
paid search. Results land where the simulated customer writes them (--out, else simulated-<time>/).
Needs MODAL_TOKEN_ID/MODAL_TOKEN_SECRET and the simulated customer's own model access.
"""

import os
import secrets
import subprocess
import sys
import time
import urllib.request
import json
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENVIRONMENT = "test"
CONFIG_SECRET = "wekruit-recruiting-test-config"
# The only settings taken from the Secret: everything else in it (email, lookup, search, OAuth
# keys) stays out of the process, and the network allowlist below backs that up.
MODEL_ENV = ("OPENAI_API_KEY", "PI_DEFAULT_PROVIDER", "PI_DEFAULT_MODEL")
MODEL_HOSTS = ["api.openai.com"]
# --search: staging's people-search key and its host, plus the public profile pages the Reviewer
# reads (contact lookups and email stay out). Without the pages every grade fell back to snippets.
SEARCH_ENV = ("EXA_API_KEY",)
SEARCH_HOSTS = ["mcp.exa.ai", "www.linkedin.com"]
WEB_PORT = 5180
WEB_ORIGIN_FILE = "/tmp/web-origin"
PORT = 3110
DATABASE_URL = "postgresql://rakazo:rakazo@127.0.0.1:5432/rakazo"
ORIGIN = "http://127.0.0.1:5180"  # the harness's web origin, which sign-in checks
PLAYS = ",".join([
    "change-mind-mid-run", "did-you-really-send", "progress-and-where", "one-off-email",
    "korean-recruiter-template", "template-sign-with-my-name", "two-asks-one-message",
    "no-made-up-details", "cannot-do-that-honestly", "switch-language-midway",
    "template-then-send", "verify-musthave-evidence-list",
])


def inside():
    """In the sandbox: start the harness with the model setting and the caller's RAKAZO_* only."""
    search = os.environ.get("BRANCH_SEARCH") == "1"
    keep = {"PATH", "HOME", "LANG", "NODE_VERSION", "SIGNUP_ALLOWLIST", *MODEL_ENV,
            *(SEARCH_ENV if search else ())}
    env = {k: v for k, v in os.environ.items() if k in keep or k.startswith("RAKAZO_")}
    env.update(INTEGRATION_DATABASE_URL=DATABASE_URL, API_PORT=str(PORT), HARNESS_HOST="0.0.0.0",
               WEB_PORT=str(WEB_PORT))
    if search:
        env["HARNESS_LIVE_HOSTS"] = ",".join(SEARCH_HOSTS)
    os.chdir("/app")
    if os.environ.get("BRANCH_WEB") == "1":
        # The caller writes the web tunnel's URL once the Sandbox is up; sign-in checks that origin.
        for _ in range(120):
            if os.path.exists(WEB_ORIGIN_FILE):
                break
            time.sleep(1)
        env["HARNESS_WEB_ORIGIN"] = Path(WEB_ORIGIN_FILE).read_text().strip()
    # --sandbox desktop: the agent's shell commands run in this Sandbox instead of the fake one.
    sandbox = os.environ.get("RAKAZO_SIM_SANDBOX", "fake")
    os.execvpe("pnpm", ["pnpm", "exec", "tsx", "packages/testkit/src/cli/harness.ts", "--serve",
                        "--runtime=pi", f"--sandbox={sandbox}"], env)


def image(web):
    import modal
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    return (
        modal.Image.from_registry("node:24.22.0-bookworm-slim", add_python="3.11")
        .apt_install("ca-certificates", "git", "openssl", "curl", "gnupg")
        # Postgres 16 like the harness's own container: the role saves use 16's IS JSON.
        .run_commands(
            "curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg",
            "echo 'deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt"
            " bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list",
            "apt-get update && apt-get install -y --no-install-recommends postgresql-16",
            "corepack enable", "corepack prepare pnpm@9.15.0 --activate",
            "service postgresql start && su postgres -c \"psql -c \\\"CREATE ROLE rakazo LOGIN SUPERUSER"
            " PASSWORD 'rakazo'\\\"\" && su postgres -c 'createdb -O rakazo rakazo' && service postgresql stop",
        )
        .workdir("/app")
        .add_local_file(ROOT / "package.json", "/app/package.json", copy=True)
        .add_local_file(ROOT / "pnpm-lock.yaml", "/app/pnpm-lock.yaml", copy=True)
        .add_local_file(ROOT / "pnpm-workspace.yaml", "/app/pnpm-workspace.yaml", copy=True)
        .add_local_file(ROOT / ".npmrc", "/app/.npmrc", copy=True)
        .add_local_dir(ROOT / "patches", "/app/patches", copy=True)
        .run_commands("pnpm fetch --frozen-lockfile")
        .add_local_dir(ROOT, "/app", copy=True,
                       ignore=modal.FilePatternMatcher(*ignore, "**/__pycache__", "**/__pycache__/**"))
        .run_commands("pnpm install --offline --frozen-lockfile", "pnpm --filter @rakazo/db generate",
                      *(["pnpm --filter @rakazo/web build"] if web else []))
    )


def sign_up(url, origin, email, password, name):
    """Creates a verified account: sign up, then follow the link the emulated mailbox received."""
    request = urllib.request.Request(
        f"{url}/api/auth/sign-up/email", method="POST",
        data=json.dumps({"email": email, "password": password, "name": name}).encode(),
        headers={"content-type": "application/json", "origin": origin})
    urllib.request.urlopen(request, timeout=60).read()
    mails = json.load(urllib.request.urlopen(f"{url}/__e2e/emails", timeout=60))
    link = next((word for mail in reversed(mails) if email in json.dumps(mail.get("to", ""))
                 for word in mail.get("text", "").split() if "verify" in word and word.startswith("http")), None)
    if not link:
        print(f"no verification link for {email} among {len(mails)} email(s)", flush=True)
        return
    path = link.split("/", 3)[3]
    try:  # it then redirects to the web origin
        urllib.request.urlopen(urllib.request.Request(f"{url}/{path}", headers={"origin": origin}), timeout=60)
    except OSError:
        pass


def main(argv):
    import modal
    split = argv.index("--") if "--" in argv else len(argv)
    own, plays = argv[:split], argv[split + 1:] or ["--journeys", PLAYS]
    minutes = int(own[own.index("--minutes") + 1]) if "--minutes" in own else 60
    extra = dict(own[i + 1].split("=", 1) for i, a in enumerate(own) if a == "--env")
    if any(not name.startswith("RAKAZO_") for name in extra):
        sys.exit("--env takes RAKAZO_* settings only")
    search, web = "--search" in own, "--web" in own
    owner, password = "branch-owner@example.com", f"Branch-{secrets.token_urlsafe(18)}"
    batch, batch_password = "branch-batch@example.com", f"Branch-{secrets.token_urlsafe(18)}"

    app = modal.App.lookup("rakazo-branch-plays", create_if_missing=True, environment_name=ENVIRONMENT)
    print("building the branch image (cached after the first run)", flush=True)
    sandbox = modal.Sandbox.create(
        "bash", "-c", "service postgresql start >/dev/null && exec python3 /app/infra/modal/branch_backend.py --inside",
        app=app, image=image(web),
        secrets=[modal.Secret.from_name(CONFIG_SECRET, environment_name=ENVIRONMENT),
                 modal.Secret.from_dict({**extra, "SIGNUP_ALLOWLIST": "@example.com",
                                         "BRANCH_SEARCH": "1" if search else "0", "BRANCH_WEB": "1" if web else "0"})],
        outbound_domain_allowlist=MODEL_HOSTS + (SEARCH_HOSTS if search else []),
        encrypted_ports=[PORT, *([WEB_PORT] if web else [])],
        timeout=minutes * 60, cpu=2.0, memory=4096,
    )
    try:
        origin = ORIGIN
        if web:
            origin = sandbox.tunnels()[WEB_PORT].url
            sandbox.exec("bash", "-c", f"echo {origin} > {WEB_ORIGIN_FILE}").wait()
        log_path = Path(tempfile.gettempdir()) / "rakazo-branch-backend.log"
        log = open(log_path, "w")
        for line in sandbox.stdout:
            log.write(line)
            if "SERVING" in line:
                break
        else:
            sys.exit(f"the branch backend stopped before serving; see {log_path}\n{sandbox.stderr.read()[-2000:]}")
        # Keep the backend's own log for the rest of the run, to see why a play failed.
        def keep_log():
            try:
                for line in sandbox.stdout:
                    log.write(line)
                    log.flush()
            except Exception:  # the stream closes when the Sandbox stops
                pass
        threading.Thread(target=keep_log, daemon=True).start()
        url = sandbox.tunnels()[PORT].url
        sign_up(url, origin, owner, password, "Branch Owner")
        sign_up(url, origin, batch, batch_password, "Batch Recruiter")
        print(f"branch backend up at {url}{f' (web {origin})' if web else ''}; playing {' '.join(plays)}", flush=True)
        # Mailbox, copied-account and recipient settings point at staging accounts, not this backend.
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("RAKAZO_MAILBOX_", "RAKAZO_BATCH_", "RAKAZO_SIM_RECIPIENTS"))}
        env.update(RAKAZO_URL=url, RAKAZO_ORIGIN=origin, RAKAZO_EMAIL=owner, RAKAZO_PASSWORD=password,
                   RAKAZO_BATCH_EMAIL=batch, RAKAZO_BATCH_PASSWORD=batch_password)
        started = time.time()
        code = subprocess.call(["node", str(ROOT / "infra/acceptance/simulated-customer.mjs"), *plays], env=env, cwd=ROOT)
        print(f"plays finished in {round((time.time() - started) / 60)} min, exit {code}; backend log {log_path}",
              flush=True)
        return code
    finally:
        sandbox.terminate()


if __name__ == "__main__":
    if sys.argv[1:] == ["--inside"]:
        inside()
    sys.exit(main(sys.argv[1:]))
