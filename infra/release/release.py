"""Source-addressed release evidence and opt-in promotion; standard library + existing gh/Modal."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import time
import urllib.request

REPO = "WeKruit/rakazo"
CI_JOBS = {"Lint", "Typecheck", "Production builds", "Unit tests", "Postgres journeys",
           "Web E2E / Web E2E", "Release safeguards"}
ROOT = Path(__file__).resolve().parents[2]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value), "Full source SHA required")
    return value


def run(*args, **kwargs):
    # Never echo remote CLI output: it can contain private URLs, accounts or credentials.
    result = subprocess.run(args, capture_output=True, **kwargs)
    require(result.returncode == 0, f"{Path(args[0]).name} operation failed; inspect privately")
    return result.stdout


def api(path):
    return json.loads(run("gh", "api", f"repos/{REPO}/{path}"))


def checked_run(run_id, workflow, event, expected_sha=None):
    require(str(run_id).isdigit() and int(run_id) > 0, "Invalid run ID")
    record = api(f"actions/runs/{run_id}")
    require(record["repository"]["full_name"] == REPO
            and record["head_repository"]["full_name"] == REPO
            and record["path"] == f".github/workflows/{workflow}.yml"
            and record["event"] == event and record["head_branch"] == "main"
            and record["status"] == "completed" and record["conclusion"] == "success",
            "Run must be a successful trusted main workflow")
    if expected_sha is not None:
        require(record["head_sha"] == sha(expected_sha), "Run source SHA mismatch")
    jobs = api(f"actions/runs/{run_id}/attempts/{record['run_attempt']}/jobs?per_page=100")
    require(jobs["total_count"] <= 100, "Unexpected job count; review provenance")
    required = CI_JOBS if workflow == "ci" else {"Synthetic staging"}
    for name in required:
        matches = [job for job in jobs["jobs"] if job["name"] == name]
        require(len(matches) == 1 and matches[0]["conclusion"] == "success",
                "Required validation did not pass")
    return record


def migrations(root):
    return [{"name": item.parent.name, "sha256": hashlib.sha256(item.read_bytes()).hexdigest()}
            for item in sorted((root / "packages/db/prisma/migrations").glob("*/migration.sql"))]


def package(output, ci_run_id):
    revision = sha(run("git", "rev-parse", "HEAD", cwd=ROOT).decode().strip())
    require(not run("git", "status", "--porcelain", cwd=ROOT).strip(), "Package requires clean checkout")
    ci = checked_run(ci_run_id, "ci", "push", revision)
    output.mkdir(parents=True, exist_ok=False)
    archive = run("git", "archive", "--format=tar", revision, cwd=ROOT)
    (output / "source.tar").write_bytes(archive)
    manifest = {
        "format": 1, "repository": REPO, "sha": revision,
        "archive_sha256": hashlib.sha256(archive).hexdigest(),
        "ci": {"id": int(ci_run_id), "attempt": ci["run_attempt"]},
        "staging": {"id": int(os.environ["GITHUB_RUN_ID"]),
                    "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
                    "workflow_sha": sha(os.environ["GITHUB_SHA"])},
        "headhunter": json.loads((ROOT / "infra/release/headhunter.json").read_text()),
        "migrations": migrations(ROOT),
    }
    (output / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")


def verify_archive(directory, expected_sha):
    manifest = json.loads((directory / "release.json").read_text())
    require(manifest["format"] == 1 and manifest["repository"] == REPO
            and manifest["sha"] == sha(expected_sha), "Release identity mismatch")
    archive = directory / "source.tar"
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == manifest["archive_sha256"],
            "Source archive checksum mismatch")
    source = directory / "source"
    require(not source.exists(), "Extraction target must be new")
    with tarfile.open(archive) as tar:
        # Current repository has no links. Refuse links/special files before any write.
        require(all((member.isfile() or member.isdir()) and not member.name.startswith("/")
                    and ".." not in Path(member.name).parts for member in tar.getmembers()),
                "Unsafe source archive entry")
        tar.extractall(source, filter="data")
    require(migrations(source) == manifest["migrations"] and len(manifest["migrations"]) > 0,
            "Migration inventory mismatch")
    require(json.loads((source / "infra/release/headhunter.json").read_text()) == manifest["headhunter"],
            "Source dependency mismatch")
    (source / ".wekruit-source-revision").write_text(manifest["sha"] + "\n")
    return manifest


def fetch(output, staging_run_id, expected_sha):
    stage = checked_run(staging_run_id, "staging", "workflow_run")
    name = f"release-{staging_run_id}-{stage['run_attempt']}"
    listing = api(f"actions/runs/{staging_run_id}/artifacts?per_page=100")
    require(listing["total_count"] <= 100, "Unexpected artifact count")
    artifacts = [a for a in listing["artifacts"] if a["name"] == name and not a["expired"]]
    require(len(artifacts) == 1, "Unique unexpired release artifact required")
    output.mkdir(parents=True, exist_ok=False)
    run("gh", "run", "download", str(staging_run_id), "--repo", REPO,
        "--name", name, "--dir", str(output))
    manifest = verify_archive(output, expected_sha)
    require(manifest["staging"] == {"id": int(staging_run_id), "attempt": stage["run_attempt"],
                                    "workflow_sha": stage["head_sha"]}, "Staging provenance mismatch")
    ci = checked_run(manifest["ci"]["id"], "ci", "push", manifest["sha"])
    require(ci["run_attempt"] == manifest["ci"]["attempt"], "CI attempt changed; restage")
    # The artifact SHA is checked against the original Git object, not only its own manifest.
    original = run("git", "archive", "--format=tar", manifest["sha"], cwd=ROOT)
    require(hashlib.sha256(original).hexdigest() == manifest["archive_sha256"],
            "Artifact differs from tested Git source")
    return manifest


def verify_promotion_source(directory, manifest):
    stage = checked_run(manifest["staging"]["id"], "staging", "workflow_run",
                        manifest["staging"]["workflow_sha"])
    ci = checked_run(manifest["ci"]["id"], "ci", "push", manifest["sha"])
    require(stage["run_attempt"] == manifest["staging"]["attempt"]
            and ci["run_attempt"] == manifest["ci"]["attempt"], "Validation attempt changed; restage")
    original = run("git", "archive", "--format=tar", manifest["sha"], cwd=ROOT)
    require(hashlib.sha256(original).hexdigest() == manifest["archive_sha256"]
            and (directory / "source.tar").read_bytes() == original, "Tested archive changed")
    source = directory / "source"
    expected_files = {".wekruit-source-revision"}
    with tarfile.open(directory / "source.tar") as tar:
        for item in tar.getmembers():
            if item.isfile():
                expected_files.add(item.name)
                target = source / item.name
                require(not target.is_symlink() and target.read_bytes() == tar.extractfile(item).read()
                        and target.stat().st_mode & 0o111 == item.mode & 0o111, "Extracted source changed")
    actual_files = {str(p.relative_to(source)) for p in source.rglob("*") if not p.is_dir()}
    require(actual_files == expected_files and not any(p.is_symlink() for p in source.rglob("*")),
            "Unexpected release files")
    require((source / ".wekruit-source-revision").read_text().strip() == manifest["sha"]
            and migrations(source) == manifest["migrations"]
            and json.loads((source / "infra/release/headhunter.json").read_text()) == manifest["headhunter"],
            "Release metadata changed")


def approval(manifest, environ, now=None):
    require(environ.get("MODAL_PROMOTION_ENABLED") == "true", "Modal promotion is disabled")
    require(environ.get("PRODUCTION_DEPLOYMENT_HOLD") == "clear", "Deployment hold is not clear")
    value = json.loads(environ.get("PRODUCTION_RELEASE_APPROVAL", "{}"))
    require(value.get("sha") == manifest["sha"]
            and value.get("staging_run_id") == manifest["staging"]["id"]
            and value.get("source_sha") == manifest["headhunter"]["sha"], "Approval revision mismatch")
    sha(value.get("previous_sha"))
    require(type(value.get("active_runs")) is int and value["active_runs"] == 0,
            "Active-run verification required")
    for key in ("autumn_paused", "source_migrations_verified", "product_migrations_approved",
                "rollback_compatible"):
        require(value.get(key) is True, f"Release prerequisite missing: {key}")
    expiry = dt.datetime.fromisoformat(value["expires_at"].replace("Z", "+00:00"))
    now = now or dt.datetime.now(dt.timezone.utc)
    require(expiry.tzinfo is not None and 0 < (expiry - now).total_seconds() <= 1800,
            "Approval must expire within 30 minutes")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_origin(origin):
    from urllib.parse import urlsplit
    parsed = urlsplit(origin)
    require(parsed.scheme == "https" and parsed.hostname and not parsed.username
            and not parsed.password and parsed.path in ("", "/")
            and not parsed.query and not parsed.fragment, "HTTPS origin required")
    return origin.rstrip("/")


def smoke(origin, revision):
    origin = validate_origin(origin)
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(origin.rstrip("/") + "/ready", timeout=10) as response:
        body = json.loads(response.read(4096))
        require(response.status == 200 and response.headers.get("x-rakazo-revision") == sha(revision)
                and isinstance(body, dict) and body.get("ok") is True and body.get("degraded") is False,
                "Readiness or deployed revision mismatch")
    with opener.open(origin.rstrip("/") + "/", timeout=10) as response:
        require(response.status == 200 and response.headers.get("content-type", "").split(";")[0].strip() == "text/html"
                and b'id="root"' in response.read(65536), "Web shell smoke failed")


def promote(directory, expected_sha):
    manifest = json.loads((directory / "release.json").read_text())
    require(manifest["sha"] == sha(expected_sha), "Promotion SHA mismatch")
    approval(manifest, os.environ)
    for key in ("MODAL_APP_NAME", "MODAL_SECRET_NAME", "MODAL_VOLUME_NAME", "MODAL_ENVIRONMENT"):
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", os.environ.get(key, "")),
                f"Explicit existing target required: {key}")
    for key in ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "PRODUCTION_ORIGIN"):
        require(bool(os.environ.get(key)), f"Missing {key}")
    validate_origin(os.environ["PRODUCTION_ORIGIN"])
    verify_promotion_source(directory, manifest)
    info = json.loads(run("modal", "app", "info", os.environ["MODAL_APP_NAME"],
                          "--env", os.environ["MODAL_ENVIRONMENT"], "--json"))
    require(info["description"] == os.environ["MODAL_APP_NAME"]
            and info["lifecycle"]["state"] == "deployed", "Existing deployed Modal app required")
    approval(manifest, os.environ)  # Refresh expiry immediately before the only mutation.
    run("modal", "deploy", "--env", os.environ["MODAL_ENVIRONMENT"],
        "--strategy", "recreate", "--tag", manifest["sha"], "infra/modal/app.py",
        cwd=directory / "source", timeout=1200)
    for attempt in range(12):
        try:
            smoke(os.environ["PRODUCTION_ORIGIN"], manifest["sha"])
            print(f"Release {manifest['sha']}: readiness, version and web shell passed")
            return
        except Exception:
            if attempt == 11:
                raise ValueError("Post-deploy smoke failed; preserve holds and inspect privately") from None
            time.sleep(5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("package", "fetch", "promote"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--run-id")
    parser.add_argument("--sha")
    args = parser.parse_args()
    if args.command == "package":
        package(args.directory, args.run_id)
    elif args.command == "fetch":
        fetch(args.directory, args.run_id, args.sha)
    else:
        promote(args.directory, args.sha)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # JSON/URL/CLI exceptions can embed secrets or private data. No raw traceback in public CI.
        raise SystemExit("Release check failed; no success recorded. Inspect prerequisites privately.") from None
