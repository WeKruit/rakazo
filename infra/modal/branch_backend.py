"""A branch's own backend for the simulated customer, so a change is played before it merges.

A Modal Sandbox runs the testkit harness in --serve mode on this checkout: a fresh database, the
emulated email and connectors, the real model. It receives only the model setting from the test
environment's Secret, can reach only the model host, and stops itself after --minutes.

  pnpm sim:branch [--minutes 60] [--env RAKAZO_NAME=value ...] [-- <simulated-customer args>]

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
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENVIRONMENT = "test"
CONFIG_SECRET = "wekruit-recruiting-test-config"
# The only settings taken from the Secret: everything else in it (email, lookup, search, OAuth
# keys) stays out of the process, and the network allowlist below backs that up.
MODEL_ENV = ("OPENAI_API_KEY", "PI_DEFAULT_PROVIDER", "PI_DEFAULT_MODEL")
MODEL_HOSTS = ["api.openai.com"]
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
    keep = {"PATH", "HOME", "LANG", "NODE_VERSION", "SIGNUP_ALLOWLIST", *MODEL_ENV}
    env = {k: v for k, v in os.environ.items() if k in keep or k.startswith("RAKAZO_")}
    env.update(INTEGRATION_DATABASE_URL=DATABASE_URL, API_PORT=str(PORT), HARNESS_HOST="0.0.0.0")
    os.chdir("/app")
    os.execvpe("pnpm", ["pnpm", "exec", "tsx", "packages/testkit/src/cli/harness.ts", "--serve", "--runtime=pi"], env)


def image():
    import modal
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    return (
        modal.Image.from_registry("node:24.22.0-bookworm-slim", add_python="3.11")
        .apt_install("ca-certificates", "git", "openssl", "postgresql")
        .run_commands(
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
        .run_commands("pnpm install --offline --frozen-lockfile", "pnpm --filter @rakazo/db generate")
    )


def main(argv):
    import modal
    split = argv.index("--") if "--" in argv else len(argv)
    own, plays = argv[:split], argv[split + 1:] or ["--journeys", PLAYS]
    minutes = int(own[own.index("--minutes") + 1]) if "--minutes" in own else 60
    extra = dict(own[i + 1].split("=", 1) for i, a in enumerate(own) if a == "--env")
    if any(not name.startswith("RAKAZO_") for name in extra):
        sys.exit("--env takes RAKAZO_* settings only")
    owner, password = "branch-owner@example.com", f"Branch-{secrets.token_urlsafe(18)}"

    app = modal.App.lookup("rakazo-branch-plays", create_if_missing=True, environment_name=ENVIRONMENT)
    print("building the branch image (cached after the first run)", flush=True)
    sandbox = modal.Sandbox.create(
        "bash", "-c", "service postgresql start >/dev/null && exec python3 /app/infra/modal/branch_backend.py --inside",
        app=app, image=image(),
        secrets=[modal.Secret.from_name(CONFIG_SECRET, environment_name=ENVIRONMENT),
                 modal.Secret.from_dict({**extra, "SIGNUP_ALLOWLIST": "@example.com"})],
        outbound_domain_allowlist=MODEL_HOSTS, encrypted_ports=[PORT],
        timeout=minutes * 60, cpu=2.0, memory=4096,
    )
    try:
        log_path = Path(tempfile.gettempdir()) / "rakazo-branch-backend.log"
        log = open(log_path, "w")
        for line in sandbox.stdout:
            log.write(line)
            if "SERVING" in line:
                break
        else:
            sys.exit(f"the branch backend stopped before serving; see {log_path}\n{sandbox.stderr.read()[-2000:]}")
        url = sandbox.tunnels()[PORT].url
        request = urllib.request.Request(
            f"{url}/api/auth/sign-up/email", method="POST",
            data=json.dumps({"email": owner, "password": password, "name": "Branch Owner"}).encode(),
            headers={"content-type": "application/json", "origin": ORIGIN})
        urllib.request.urlopen(request, timeout=60).read()
        # Sign-in needs a verified address: follow the link the emulated mailbox received.
        mails = json.load(urllib.request.urlopen(f"{url}/__e2e/emails", timeout=60))
        link = next((word for mail in reversed(mails) for word in mail.get("text", "").split()
                     if "verify" in word and word.startswith("http")), None)
        if link:
            path = link.split("/", 3)[3]
            try:  # it then redirects to the web origin, which this backend does not serve
                urllib.request.urlopen(urllib.request.Request(f"{url}/{path}", headers={"origin": ORIGIN}), timeout=60)
            except OSError:
                pass
        else:
            print(f"no verification link among {len(mails)} email(s)", flush=True)
        print(f"branch backend up at {url}; playing {' '.join(plays)}", flush=True)
        # Mailbox, copied-account and recipient settings point at staging accounts, not this backend.
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("RAKAZO_MAILBOX_", "RAKAZO_BATCH_", "RAKAZO_SIM_RECIPIENTS"))}
        env.update(RAKAZO_URL=url, RAKAZO_ORIGIN=ORIGIN, RAKAZO_EMAIL=owner, RAKAZO_PASSWORD=password)
        started = time.time()
        code = subprocess.call(["node", str(ROOT / "infra/acceptance/simulated-customer.mjs"), *plays], env=env, cwd=ROOT)
        print(f"plays finished in {round((time.time() - started) / 60)} min, exit {code}", flush=True)
        return code
    finally:
        sandbox.terminate()


if __name__ == "__main__":
    if sys.argv[1:] == ["--inside"]:
        inside()
    sys.exit(main(sys.argv[1:]))
