"""Copy the production database into the test environment's database.

Run through docs/deploy/sync-test-data.sh, which stops the test app first and redeploys it after.
Production is only read (read-only transaction). The test copy is made safe to run: scheduled
routines are paused, unfinished runs cancelled, queued jobs dropped, sign-in sessions and push
tokens removed, and personal model credentials dropped so runs use the platform key. Connections
stay encrypted with the production key, which the test environment does not have, so they cannot
send anything. Nothing is printed except counts.
"""

import modal

app = modal.App("wekruit-recruiting-test-sync")
image = modal.Image.from_registry("postgres:17-bookworm", add_python="3.11").pip_install("psycopg2-binary")
dumps = modal.Volume.from_name("wekruit-recruiting-test-restore", environment_name="test", create_if_missing=True)
DUMP = "/dumps/prod.dump"

# Statements run on the test copy after the restore; each reports how many rows it changed.
SANITIZE = [
    ("routines_paused", "update routines set active = false where active"),
    ("runs_cancelled", "update runs set status = 'cancelled' where status not in "
                       "('completed','cancelled','canceled','failed','waiting_input','interrupted')"),
    ("sessions_removed", 'delete from "session"'),
    ("push_tokens_removed", "delete from push_tokens"),
    # Sealed with the production key, so they cannot be opened here; runs then use the platform key.
    ("model_credentials_removed", "delete from user_model_credentials"),
    ("voice_credentials_removed", "delete from user_voice_credentials"),
]


def host_of(url):
    from urllib.parse import urlsplit
    return urlsplit(url).hostname or ""


def user_of(url):
    from urllib.parse import urlsplit, unquote
    return unquote(urlsplit(url).username or "")


@app.function(image=image, volumes={"/dumps": dumps}, timeout=3600, cpu=2, memory=4096,
              secrets=[modal.Secret.from_name("wekruit-recruiting-config", environment_name="main")])
def dump_production():
    import os, subprocess
    url = os.environ.get("REALTIME_DATABASE_URL") or os.environ["DATABASE_URL"]
    # Job queue rows stay behind: the test worker starts with an empty queue.
    result = subprocess.run(
        ["pg_dump", "--format=custom", "--no-owner", "--no-acl", "--schema=public", f"--file={DUMP}", f"--dbname={url}"],
        capture_output=True, text=True, env={**os.environ, "PGOPTIONS": "-c default_transaction_read_only=on"})
    if result.returncode:
        raise RuntimeError("production dump failed")
    dumps.commit()
    return {"user": user_of(url), "bytes": os.path.getsize(DUMP)}


@app.function(image=image, volumes={"/dumps": dumps}, timeout=3600, cpu=2, memory=4096,
              secrets=[modal.Secret.from_name("wekruit-recruiting-test-db", environment_name="test")])
def restore_into_test(production_user):
    import os, subprocess, psycopg2
    url = os.environ["DATABASE_URL"]
    # Supabase pooler user names carry the project ref, so equal names mean the same database.
    if user_of(url) == production_user:
        raise RuntimeError("test database is the production database; refusing to restore")
    dumps.reload()
    connection = psycopg2.connect(url)
    connection.autocommit = True
    cursor = connection.cursor()
    cursor.execute("set default_transaction_read_only = off; "
                   "drop schema if exists graphile_worker cascade; drop schema if exists public cascade")
    result = subprocess.run(["pg_restore", "--no-owner", "--no-acl", "--jobs=2", f"--dbname={url}", DUMP],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"restore failed with {sum('error' in line.lower() for line in result.stderr.splitlines())} errors")
    counts = {}
    for name, statement in SANITIZE:
        cursor.execute(statement)
        counts[name] = cursor.rowcount
    cursor.execute('select (select count(*) from "user"), (select count(*) from runs), '
                   "(select count(*) from routines where active)")
    counts["users"], counts["runs"], counts["active_routines"] = cursor.fetchone()
    connection.close()
    return counts


@app.local_entrypoint()
def main():
    dumped = dump_production.remote()
    print(f"production read: {dumped['bytes'] // 1_000_000} MB")
    print("test copy:", restore_into_test.remote(dumped["user"]))
