"""Deploy guard: the app's database URLs must use the Supabase poolers the way production does.

Queries go through the transaction pooler (6543); the session pooler (5432) only serves LISTEN,
the job queue and locks (see docs/deploy/DB-POOL-ARCHITECTURE-20261027.md). A DATABASE_URL on the
session pooler exhausts its small client limit and hangs every page, so the release stops here.
Reads the same Secrets the app gets and prints only ports, never the URLs.
"""

import os

import modal

APP_NAME = os.environ.get("MODAL_APP_NAME", "wekruit-recruiting")
SECRET_NAME = os.environ.get("MODAL_SECRET_NAME", f"{APP_NAME}-config")
TEST_ENVIRONMENT = os.environ.get("MODAL_ENVIRONMENT", "main") == "test"

app = modal.App(f"{APP_NAME}-db-url-check")
secrets = [modal.Secret.from_name(SECRET_NAME)]
if TEST_ENVIRONMENT:
    secrets.append(modal.Secret.from_name(f"{APP_NAME}-db"))


def problems(env):
    from urllib.parse import urlsplit

    database = urlsplit(env.get("DATABASE_URL", ""))
    if not (database.hostname or "").endswith(".pooler.supabase.com"):
        return []
    found = []
    if database.port != 6543:
        found.append(f"DATABASE_URL uses port {database.port}; queries need the transaction pooler (6543)")
    realtime = urlsplit(env.get("REALTIME_DATABASE_URL", ""))
    if realtime.port != 5432:
        found.append(f"REALTIME_DATABASE_URL uses port {realtime.port}; it needs the session pooler (5432)")
    elif realtime.hostname != database.hostname or realtime.path != database.path:
        found.append("REALTIME_DATABASE_URL points at a different database than DATABASE_URL")
    return found


@app.function(secrets=secrets)
def check():
    return problems(os.environ)


@app.local_entrypoint()
def main():
    found = check.remote()
    for problem in found:
        print(f"DB URL CHECK FAILED: {problem}")
    if found:
        raise SystemExit(1)
    print("database URLs ok")
