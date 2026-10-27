"""Offline topology and database connection budget validation."""
from urllib.parse import urlsplit


def split_database_budget(environ):
    query = urlsplit(environ.get("DATABASE_URL", ""))
    session = urlsplit(environ.get("REALTIME_DATABASE_URL", ""))
    if query.scheme not in ("postgres", "postgresql") or query.port != 6543:
        raise ValueError("Split services require DATABASE_URL transaction pooler port 6543")
    if session.scheme not in ("postgres", "postgresql") or session.port != 5432:
        raise ValueError("Split services require REALTIME_DATABASE_URL session port 5432")
    return {"api": {"DB_POOL_MAX": "20"},
            "worker": {"DB_POOL_MAX": "20", "GRAPHILE_WORKER_CONCURRENCY": "50"}}


def session_budget(api, workers, *, replacement_api=0, replacement_workers=0, migrations=0):
    values = (api, workers, replacement_api, replacement_workers, migrations)
    if any(type(value) is not int or value < 0 for value in values):
        raise ValueError("Container counts must be non-negative integers")
    total = api + replacement_api + 5 * (workers + replacement_workers) + migrations
    if total > 15:
        raise ValueError(f"Session budget exceeded: {total} > 15")
    return total
