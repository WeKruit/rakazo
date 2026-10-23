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
import tempfile
import time
import urllib.error
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


def api(path, token=None):
    options = {"env": {**os.environ, "GH_TOKEN": token}} if token else {}
    return json.loads(run("gh", "api", f"repos/{REPO}/{path}", **options))


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
    required = {"ci": CI_JOBS, "release-validation": {"Synthetic validation"},
                "staging": {"Hosted staging"}}[workflow]
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
        "format": 2, "repository": REPO, "sha": revision,
        "archive_sha256": hashlib.sha256(archive).hexdigest(),
        "ci": {"id": int(ci_run_id), "attempt": ci["run_attempt"]},
        "validation": {"id": int(os.environ["GITHUB_RUN_ID"]),
                    "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
                    "workflow_sha": sha(os.environ["GITHUB_SHA"])},
        "headhunter": json.loads((ROOT / "infra/release/headhunter.json").read_text()),
        "migrations": migrations(ROOT),
    }
    (output / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")


def verify_archive(directory, expected_sha):
    manifest = json.loads((directory / "release.json").read_text())
    require(manifest["format"] == 2 and manifest["repository"] == REPO
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


def download_artifact(output, run_id, name):
    listing = api(f"actions/runs/{run_id}/artifacts?per_page=100")
    require(listing["total_count"] <= 100, "Unexpected artifact count")
    artifacts = [a for a in listing["artifacts"] if a["name"] == name and not a["expired"]]
    require(len(artifacts) == 1, "Unique unexpired release artifact required")
    output.mkdir(parents=True, exist_ok=False)
    run("gh", "run", "download", str(run_id), "--repo", REPO,
        "--name", name, "--dir", str(output))


def fetch_validation(output, validation_run_id, expected_sha):
    validation = checked_run(validation_run_id, "release-validation", "workflow_run")
    download_artifact(output, validation_run_id, f"release-{validation_run_id}-{validation['run_attempt']}")
    manifest = verify_archive(output, expected_sha)
    require(manifest["validation"] == {"id": int(validation_run_id), "attempt": validation["run_attempt"],
                                      "workflow_sha": validation["head_sha"]}, "Validation provenance mismatch")
    ci = checked_run(manifest["ci"]["id"], "ci", "push", manifest["sha"])
    require(ci["run_attempt"] == manifest["ci"]["attempt"], "CI attempt changed; restage")
    # The artifact SHA is checked against the original Git object, not only its own manifest.
    original = run("git", "archive", "--format=tar", manifest["sha"], cwd=ROOT)
    require(hashlib.sha256(original).hexdigest() == manifest["archive_sha256"],
            "Artifact differs from tested Git source")
    return manifest


def verify_validation_source(directory, manifest):
    validation = checked_run(manifest["validation"]["id"], "release-validation", "workflow_run",
                             manifest["validation"]["workflow_sha"])
    ci = checked_run(manifest["ci"]["id"], "ci", "push", manifest["sha"])
    require(validation["run_attempt"] == manifest["validation"]["attempt"]
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


def protected_environment(name, required_secrets, reviewers=False):
    """Verify real GitHub controls; environment labels/repo variables confer no approval."""
    require(name in ("staging", "production"), "Unknown release environment")
    config = api(f"environments/{name}")
    require(config.get("deployment_branch_policy") == {
        "protected_branches": False, "custom_branch_policies": True,
    }, "Explicit main-only environment policy required")
    policies = api(f"environments/{name}/deployment-branch-policies?per_page=100")
    require(policies.get("total_count") == 1 and len(policies.get("branch_policies", [])) == 1
            and policies["branch_policies"][0].get("name") == "main"
            and policies["branch_policies"][0].get("type") == "branch",
            "Environment must allow only the main branch (no tags)")
    if reviewers:
        rules = [r for r in config.get("protection_rules", []) if r.get("type") == "required_reviewers"]
        require(len(rules) == 1 and bool(rules[0].get("reviewers"))
                and rules[0].get("prevent_self_review") is True,
                "Required independent environment reviewers must be enabled")
    # GitHub's environment GET schema does not expose the administrator-bypass setting.
    # Owners must verify that setting before installing any scoped deployment credentials.
    token = os.environ.get("ENVIRONMENT_AUDIT_TOKEN")
    require(bool(token), "Environment metadata read credential required")
    secrets = api(f"environments/{name}/secrets?per_page=100", token=token)
    require(secrets.get("total_count", 101) <= 100
            and (set(required_secrets) | {"ENVIRONMENT_AUDIT_TOKEN"}) <= {item["name"] for item in secrets.get("secrets", [])},
            "Release credentials and approval must be environment-scoped secrets")


def fresh_approval(value, now=None):
    expiry = dt.datetime.fromisoformat(value["expires_at"].replace("Z", "+00:00"))
    now = now or dt.datetime.now(dt.timezone.utc)
    require(expiry.tzinfo is not None and 0 < (expiry - now).total_seconds() <= 1800,
            "Approval must expire within 30 minutes")


def approval(manifest, environ, now=None):
    require(environ.get("MODAL_PROMOTION_ENABLED") == "true", "Modal promotion is disabled")
    require(environ.get("PRODUCTION_DEPLOYMENT_HOLD") == "clear", "Deployment hold is not clear")
    value = json.loads(environ.get("PRODUCTION_RELEASE_APPROVAL", "{}"))
    require(value.get("sha") == manifest["sha"]
            and str(value.get("staging_run_id")) == environ.get("STAGING_RUN_ID")
            and value.get("source_sha") == manifest["headhunter"]["sha"], "Approval revision mismatch")
    sha(value.get("previous_sha"))
    require(type(value.get("active_runs")) is int and value["active_runs"] == 0,
            "Active-run verification required")
    for key in ("autumn_paused", "source_migrations_verified", "product_migrations_approved",
                "rollback_compatible"):
        require(value.get(key) is True, f"Release prerequisite missing: {key}")
    fresh_approval(value, now)
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


def smoke(origin, revision, staging=False):
    origin = validate_origin(origin)
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(origin.rstrip("/") + "/ready", timeout=10) as response:
        body = json.loads(response.read(4096))
        require(response.status == 200 and response.headers.get("x-rakazo-revision") == sha(revision)
                and isinstance(body, dict) and body.get("ok") is True and body.get("degraded") is False,
                "Readiness or deployed revision mismatch")
        if staging:
            require(response.headers.get("x-rakazo-profile") == "staging", "Hosted staging profile required")
    with opener.open(origin.rstrip("/") + "/", timeout=10) as response:
        require(response.status == 200 and response.headers.get("content-type", "").split(";")[0].strip() == "text/html"
                and b'id="root"' in response.read(65536), "Web shell smoke failed")
    if staging:
        # Nonexistent synthetic route: even a misconfigured origin cannot perform a business action.
        request = urllib.request.Request(origin + "/api/__release_smoke_denied__", data=b"{}",
                                         headers={"Content-Type": "application/json"}, method="POST")
        try:
            response = opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            require(response.status == 403 and response.headers.get("x-rakazo-profile") == "staging",
                    "Hosted staging mutation fence failed")


def staging_target(environ):
    target = {"environment": "staging", "origin": validate_origin(environ.get("STAGING_ORIGIN", ""))}
    for key in ("app_name", "secret_name", "volume_name"):
        value = environ.get("STAGING_MODAL_" + key.upper(), "")
        require(re.fullmatch(r"rakazo-staging(?:-[a-z0-9-]+)?", value), "Staging resource names must use rakazo-staging prefix")
        target[key] = value
    return target


def staging_approval(manifest, environ):
    require(environ.get("STAGING_DEPLOY_ENABLED") == "true"
            and environ.get("STAGING_DEPLOYMENT_HOLD") == "clear", "Hosted staging deployment is held")
    value = json.loads(environ.get("STAGING_RELEASE_APPROVAL", "{}"))
    require(value.get("sha") == manifest["sha"]
            and value.get("validation_run_id") == manifest["validation"]["id"]
            and value.get("isolated_resources_verified") is True
            and value.get("synthetic_data_only") is True, "Isolated staging prerequisites required")
    fresh_approval(value)


def hosted_receipt(run_id, expected_sha):
    record = checked_run(run_id, "staging", "workflow_dispatch")
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp) / "receipt"
        download_artifact(directory, run_id, f"hosted-staging-{run_id}-{record['run_attempt']}")
        receipt = json.loads((directory / "staging.json").read_text())
    require(receipt.get("format") == 1 and receipt.get("repository") == REPO
            and receipt.get("sha") == sha(expected_sha)
            and receipt.get("run") == {"id": int(run_id), "attempt": record["run_attempt"],
                                      "workflow_sha": record["head_sha"]}
            and isinstance(receipt.get("checks"), dict)
            and set(receipt["checks"]) == {"readiness", "revision", "web_shell", "mutations_denied"}
            and all(value is True for value in receipt["checks"].values())
            and type(receipt.get("modal_version")) is int and receipt["modal_version"] > 0,
            "Actual hosted staging acceptance receipt required")
    require(receipt["target"] == staging_target(os.environ), "Staging target changed; restage")
    return receipt


def fetch(output, staging_run_id, expected_sha):
    receipt = hosted_receipt(staging_run_id, expected_sha)
    manifest = fetch_validation(output, receipt["validation"]["id"], expected_sha)
    require(receipt["validation"] == manifest["validation"]
            and receipt["archive_sha256"] == manifest["archive_sha256"], "Hosted staging source mismatch")
    smoke(receipt["target"]["origin"], expected_sha, staging=True)
    (output / "staging.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return manifest


def verify_promotion_source(directory, manifest):
    # Authenticate again from GitHub; standalone promotion cannot trust caller-edited manifests.
    local_receipt = json.loads((directory / "staging.json").read_text())
    require(str(local_receipt["run"]["id"]) == os.environ.get("STAGING_RUN_ID"), "Staging run changed")
    with tempfile.TemporaryDirectory() as temp:
        fresh = Path(temp) / "candidate"
        trusted = fetch(fresh, local_receipt["run"]["id"], manifest["sha"])
        require(trusted == manifest and json.loads((fresh / "staging.json").read_text()) == local_receipt,
                "Authenticated release evidence changed")
    verify_validation_source(directory, manifest)


def stage(directory, expected_sha):
    require(not (directory / "staging.json").exists(), "Staging receipt must not already exist")
    run_id, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
    require(run_id.isdigit() and int(run_id) > 0 and attempt.isdigit() and int(attempt) > 0,
            "Current staging run provenance required")
    run_identity = {"id": int(run_id), "attempt": int(attempt), "workflow_sha": sha(os.environ.get("GITHUB_SHA"))}
    manifest = json.loads((directory / "release.json").read_text())
    require(manifest["sha"] == sha(expected_sha), "Staging SHA mismatch")
    staging_approval(manifest, os.environ)
    require(os.environ.get("MODAL_ENVIRONMENT") == "staging"
            and os.environ.get("RAKAZO_RELEASE_PROFILE") == "staging", "Explicit staging profile/environment required")
    target = staging_target(os.environ)
    protected_environment("staging", {"STAGING_MODAL_TOKEN_ID", "STAGING_MODAL_TOKEN_SECRET", "STAGING_RELEASE_APPROVAL"})
    # Re-fetch authenticated metadata, not only the caller's local manifest.
    with tempfile.TemporaryDirectory() as temp:
        trusted = fetch_validation(Path(temp) / "candidate", manifest["validation"]["id"], expected_sha)
        require(trusted == manifest, "Authenticated candidate changed")
    verify_validation_source(directory, manifest)
    deploy_env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG") if key in os.environ}
    for key in ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"):
        require(bool(os.environ.get(key)), f"Missing {key}")
        deploy_env[key] = os.environ[key]
    deploy_env.update({"MODAL_ENVIRONMENT": "staging", "RAKAZO_RELEASE_PROFILE": "staging",
                       **{"MODAL_" + key.upper(): target[key] for key in ("app_name", "secret_name", "volume_name")}})
    def app_info():
        info = json.loads(run("modal", "app", "info", target["app_name"], "--env", "staging", "--json", env=deploy_env))
        require(info["description"] == target["app_name"] and info["lifecycle"]["state"] == "deployed",
                "Existing deployed staging Modal app required")
        return info
    app_info()
    staging_approval(manifest, os.environ)
    run("modal", "deploy", "--env", "staging", "--strategy", "recreate", "--tag", manifest["sha"],
        "infra/modal/app.py", cwd=directory / "source", env=deploy_env, timeout=1200)
    for attempt in range(12):
        try:
            smoke(target["origin"], manifest["sha"], staging=True)
            break
        except Exception:
            if attempt == 11:
                raise ValueError("Hosted staging smoke failed; no acceptance receipt recorded") from None
            time.sleep(5)
    version = app_info()["lifecycle"]["version"]
    require(type(version) is int and version > 0, "Modal deployment version required")
    receipt = {"format": 1, "repository": REPO, "sha": manifest["sha"],
               "archive_sha256": manifest["archive_sha256"], "validation": manifest["validation"],
               "run": run_identity,
               "target": target, "modal_version": version,
               "checks": {"readiness": True, "revision": True, "web_shell": True, "mutations_denied": True}}
    (directory / "staging.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"Hosted staging {manifest['sha']}: readiness, revision, web shell and mutation fence passed")


def promote(directory, expected_sha):
    manifest = json.loads((directory / "release.json").read_text())
    require(manifest["sha"] == sha(expected_sha), "Promotion SHA mismatch")
    approval(manifest, os.environ)
    for key in ("MODAL_APP_NAME", "MODAL_SECRET_NAME", "MODAL_VOLUME_NAME", "MODAL_ENVIRONMENT"):
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", os.environ.get(key, "")),
                f"Explicit existing target required: {key}")
    validate_origin(os.environ["PRODUCTION_ORIGIN"])
    protected_environment("production", {"PRODUCTION_MODAL_TOKEN_ID", "PRODUCTION_MODAL_TOKEN_SECRET",
                                          "PRODUCTION_RELEASE_APPROVAL"}, reviewers=True)
    verify_promotion_source(directory, manifest)
    # A snapshot of active_runs=0 is NOT a lock: Modal builds before recreate while old
    # workers/ingress can still accept work. No existing deployment-wide drain exists.
    # Never enable cutover through a variable/assertion. A reviewed enforced drain must
    # hold new runs and Autumn through build, cutover and verification before this changes.
    raise ValueError("Production cutover blocked: no enforced maintenance/drain mechanism is configured")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("package", "fetch-validation", "stage", "fetch", "promote"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--run-id")
    parser.add_argument("--sha")
    args = parser.parse_args()
    if args.command == "package":
        package(args.directory, args.run_id)
    elif args.command == "fetch-validation":
        fetch_validation(args.directory, args.run_id, args.sha)
    elif args.command == "stage":
        stage(args.directory, args.sha)
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
