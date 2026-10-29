"""In-place edit of two keys in wekruit-recruiting-config. Never prints values.

  python3 secret_split.py apply     # REALTIME_DATABASE_URL = current session URL (5432), DATABASE_URL -> 6543
  python3 secret_split.py rollback  # DATABASE_URL = REALTIME_DATABASE_URL (5432 again); service_budget falls back
"""
import json
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit

import modal

APP, SECRET = "wekruit-recruiting", "wekruit-recruiting-config"


def live_env(*names):
    containers = json.loads(subprocess.run(["modal", "container", "list", "--json"], capture_output=True, text=True, check=True).stdout)
    cid = next(c["container_id"] for c in containers if c["app_name"] == APP)
    script = "import json,os,sys; print(json.dumps({k: os.environ.get(k) for k in sys.argv[1:]}))"
    out = subprocess.run(["modal", "container", "exec", cid, "--", "python3", "-c", script, *names], capture_output=True, text=True, check=True).stdout
    return json.loads(out.strip().splitlines()[-1])


def with_port(url, port):
    u = urlsplit(url)
    host = u.netloc.rsplit("@", 1)
    assert len(host) == 2 and ":" in host[1], "unexpected DATABASE_URL shape"
    return urlunsplit(u._replace(netloc=f"{host[0]}@{host[1].rsplit(':', 1)[0]}:{port}"))


def where(url):
    u = urlsplit(url)
    return f"{u.hostname}:{u.port}{u.path}"


secret = modal.Secret.from_name(SECRET)
mode = sys.argv[1]
if mode == "apply":
    env = live_env("DATABASE_URL")
    session = env["DATABASE_URL"]
    assert urlsplit(session).port == 5432 and urlsplit(session).hostname.endswith(".pooler.supabase.com"), f"live DATABASE_URL is {where(session)}, expected session pooler :5432"
    secret.update({"REALTIME_DATABASE_URL": session, "DATABASE_URL": with_port(session, 6543)})
    print(f"updated: REALTIME_DATABASE_URL -> {where(session)}, DATABASE_URL -> {where(with_port(session, 6543))}")
elif mode == "rollback":
    env = live_env("REALTIME_DATABASE_URL", "DATABASE_URL")
    session = env["REALTIME_DATABASE_URL"]
    assert session and urlsplit(session).port == 5432, "no 5432 REALTIME_DATABASE_URL in the live container"
    secret.update({"DATABASE_URL": session})
    print(f"rolled back: DATABASE_URL -> {where(session)} (REALTIME_DATABASE_URL equal, so the split is off)")
else:
    sys.exit(__doc__)
