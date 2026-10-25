"""Pure configuration validation; importing this module makes no Modal/network calls."""

import re
import os
import subprocess
from urllib.parse import parse_qs, unquote, urlsplit


def release_profile(environ):
    profile = environ.get("RAKAZO_RELEASE_PROFILE", "production")
    if profile not in ("production", "staging"):
        raise ValueError("Unknown release profile")
    names = [environ.get(key, "") for key in ("MODAL_APP_NAME", "MODAL_SECRET_NAME", "MODAL_VOLUME_NAME")]
    if profile == "staging":
        if environ.get("MODAL_ENVIRONMENT") != "staging" or not all(
            re.fullmatch(r"rakazo-staging(?:-[a-z0-9-]+)?", name) for name in names
        ):
            raise ValueError("Staging requires explicit isolated environment/App/Secret/Volume")
    elif any(name.startswith("rakazo-staging") for name in names):
        raise ValueError("Staging resources require the restricted staging profile")
    return profile


def public_origin(environ, modal_origin):
    """The browser-facing origin and the extra hosts the Web server must accept.

    RAKAZO_PUBLIC_ORIGIN names a custom domain whose proxy forwards to the Modal URL with the
    Modal Host header. Auth, callbacks and links use the public origin; the Modal host stays
    accepted because every proxied request arrives with it.
    """
    configured = environ.get("RAKAZO_PUBLIC_ORIGIN", "").strip().rstrip("/")
    if not configured:
        return modal_origin, ""
    url = urlsplit(configured)
    if (url.scheme != "https" or not url.hostname or url.username or url.password or url.port
            or url.path or url.query or url.fragment):
        raise ValueError("RAKAZO_PUBLIC_ORIGIN must be a bare https:// origin")
    return f"https://{url.hostname}", urlsplit(modal_origin).hostname or ""


def staging_environment(environ, origin, revision):
    """No production credentials, persisted provider configuration or dotenv inheritance."""
    if release_profile(environ) != "staging":
        raise ValueError("Staging profile required")
    for key in ("DATABASE_URL", "REALTIME_DATABASE_URL", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY", "SMTP_URL"):
        if environ.get(key):
            raise ValueError("Staging Secret must contain only staging-prefixed application credentials")
    database = environ.get("STAGING_DATABASE_URL", "")
    parsed = urlsplit(database)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if (parsed.scheme not in ("postgres", "postgresql") or not parsed.hostname or not parsed.password
            or unquote(parsed.username or "") != "rakazo_staging" or parsed.path != "/rakazo_staging"
            or parsed.fragment or query.get("sslmode") not in (["require"], ["verify-full"])
            or set(query) - {"sslmode", "sslrootcert"}):
        raise ValueError("Dedicated rakazo_staging database/role and TLS are required")
    auth = environ.get("STAGING_BETTER_AUTH_SECRET", "")
    encryption = environ.get("STAGING_ENCRYPTION_KEY", "")
    if len(auth) < 32 or len(encryption) < 32:
        raise ValueError("Independent staging auth/encryption credentials required")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Staging requires the exact source revision")
    url = urlsplit(origin)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.path or url.query or url.fragment:
        raise ValueError("Staging requires an HTTPS origin")
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp/rakazo-staging-home", "LANG": "C.UTF-8",
        "NODE_EXTRA_CA_CERTS": "/usr/local/share/ca-certificates/supabase.crt",
        "NODE_ENV": "production", "RAKAZO_RELEASE_PROFILE": "staging", "RAKAZO_GIT_SHA": revision,
        "DATABASE_URL": database, "REALTIME_DATABASE_URL": database,
        "BETTER_AUTH_SECRET": auth, "ENCRYPTION_KEY": encryption,
        "DATA_DIR": "/data", "BETTER_AUTH_URL": origin, "WEB_ORIGIN": origin, "API_URL": origin,
        "RAKAZO_HOST": url.hostname, "API_HOST": "127.0.0.1", "API_PORT": "3100", "WEB_PORT": "8000",
        "API_PROXY_TARGET": "http://127.0.0.1:3100", "AGENT_RUNTIME": "scripted", "SANDBOX_PROVIDER": "fake",
        "WEB_PROVIDER": "fake", "CLOUD_AGENT_PROVIDER": "none", "WAKEUP_DRIVER": "memory",
        "SECRET_STORE": "encrypted", "MCP_STDIO_ENABLED": "false", "SIGNUPS_ENABLED": "false",
    }


def reject_staging_dotenv(root):
    for directory, folders, files in os.walk(root):
        folders[:] = [name for name in folders if name not in {"node_modules", ".git"}]
        if any(name.startswith(".env") and not name.endswith(".example") for name in files):
            raise ValueError("Hosted staging cannot load dotenv files")
    if any((parent / ".env").exists() for parent in root.parents):
        raise ValueError("Hosted staging cannot load ancestor dotenv files")


def check_staging_database(env, root):
    """Read only the dedicated staging connection identity before allowing migrations."""
    code = """
import pg from 'pg';
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000});
try {
  const {rows} = await pool.query('SELECT current_database() AS db, current_user AS role');
  if (rows.length !== 1 || rows[0].db !== 'rakazo_staging' || rows[0].role !== 'rakazo_staging') process.exitCode = 1;
} catch { process.exitCode = 1; } finally { await pool.end(); }
"""
    result = subprocess.run(["node", "--input-type=module", "-e", code], cwd=root / "packages/db",
                            env=env, capture_output=True, timeout=15)
    if result.returncode:
        raise ValueError("Dedicated staging database identity verification failed")
