import copy
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request

import release


SHA = "a" * 40
SOURCE_SHA = "b" * 40
NOW = dt.datetime.now(dt.timezone.utc)
MIGRATIONS = (
    "20261023172000_recruiting_calibration_rounds",
    "20261023172000_recruiting_crm_sync_progress",
)
DEPENDENCY = {
    "repository": "WeKruit/headhunter-agent", "sha": SOURCE_SHA,
    "migrations": ["20261023180000_crm_candidate_presence"], "presence_protocol": 2,
}


def run_record(workflow="ci", event="push"):
    return {
        "repository": {"full_name": release.REPO},
        "head_repository": {"full_name": release.REPO},
        "path": f".github/workflows/{workflow}.yml", "event": event,
        "head_branch": "main", "head_sha": SHA, "status": "completed",
        "conclusion": "success", "run_attempt": 2,
    }


def jobs(names=None):
    values = sorted(release.CI_JOBS if names is None else names)
    return {"total_count": len(values), "jobs": [
        {"name": name, "status": "completed", "conclusion": "success",
         "head_sha": SHA, "run_attempt": 2} for name in values
    ]}


def archive_bytes(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        for name, content in entries.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
    return stream.getvalue()


def bundle(directory):
    entries = {f"packages/db/prisma/migrations/{name}/migration.sql":
               f"SELECT {index};\n".encode() for index, name in enumerate(MIGRATIONS)}
    entries["infra/release/headhunter.json"] = json.dumps(DEPENDENCY).encode()
    archive = archive_bytes(entries)
    manifest = {
        "format": 2, "repository": release.REPO, "sha": SHA,
        "archive_sha256": hashlib.sha256(archive).hexdigest(),
        "ci": {"id": 17, "attempt": 2},
        "validation": {"id": 41, "attempt": 2, "workflow_sha": SHA},
        "headhunter": copy.deepcopy(DEPENDENCY),
        "migrations": [{"name": name, "sha256": hashlib.sha256(
            entries[f"packages/db/prisma/migrations/{name}/migration.sql"]).hexdigest()}
            for name in MIGRATIONS],
    }
    (directory / "source.tar").write_bytes(archive)
    (directory / "release.json").write_text(json.dumps(manifest))
    return manifest, archive


def approval_env(now=NOW):
    value = {
        "sha": SHA, "staging_run_id": 71, "source_sha": SOURCE_SHA,
        "previous_sha": "c" * 40, "active_runs": 0, "autumn_paused": True,
        "source_migrations_verified": True, "product_migrations_approved": True,
        "rollback_compatible": True, "expires_at": (now + dt.timedelta(minutes=10)).isoformat(),
    }
    return {
        "MODAL_PROMOTION_ENABLED": "true", "PRODUCTION_DEPLOYMENT_HOLD": "clear",
        "PRODUCTION_RELEASE_APPROVAL": json.dumps(value), "STAGING_RUN_ID": "71",
        "MODAL_APP_NAME": "synthetic-app", "MODAL_SECRET_NAME": "synthetic-secret",
        "MODAL_VOLUME_NAME": "synthetic-volume", "MODAL_ENVIRONMENT": "production",
        "MODAL_TOKEN_ID": "synthetic-token", "MODAL_TOKEN_SECRET": "synthetic-secret",
        "PRODUCTION_ORIGIN": "https://example.test",
    }


def stage_env(now=NOW):
    return {
        "STAGING_DEPLOY_ENABLED": "true", "STAGING_DEPLOYMENT_HOLD": "clear",
        "STAGING_RELEASE_APPROVAL": json.dumps({
            "sha": SHA, "validation_run_id": 41, "isolated_resources_verified": True,
            "synthetic_data_only": True, "expires_at": (now + dt.timedelta(minutes=10)).isoformat(),
        }),
        "STAGING_MODAL_APP_NAME": "rakazo-staging-app",
        "STAGING_MODAL_SECRET_NAME": "rakazo-staging-config",
        "STAGING_MODAL_VOLUME_NAME": "rakazo-staging-files",
        "STAGING_ORIGIN": "https://staging.example.test", "MODAL_ENVIRONMENT": "staging",
        "RAKAZO_RELEASE_PROFILE": "staging", "MODAL_TOKEN_ID": "synthetic-stage-token",
        "MODAL_TOKEN_SECRET": "synthetic-stage-secret", "GITHUB_RUN_ID": "71",
        "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": SHA,
    }


def receipt(manifest):
    return {
        "format": 1, "repository": release.REPO, "sha": SHA,
        "archive_sha256": manifest["archive_sha256"], "validation": manifest["validation"],
        "run": {"id": 71, "attempt": 2, "workflow_sha": SHA},
        "target": release.staging_target(stage_env()), "modal_version": 10,
        "checks": {"readiness": True, "revision": True, "web_shell": True, "mutations_denied": True},
    }


class OfflineTest(unittest.TestCase):
    def setUp(self):
        process = patch.object(release.subprocess, "run", side_effect=AssertionError("Unexpected process"))
        network = patch.object(release.urllib.request, "build_opener", side_effect=AssertionError("Unexpected network"))
        self.process = process.start()
        self.network = network.start()
        self.addCleanup(process.stop)
        self.addCleanup(network.stop)


class ProvenanceTests(OfflineTest):
    def test_failed_remote_command_does_not_expose_captured_output(self):
        self.process.side_effect = None
        self.process.return_value = subprocess.CompletedProcess(
            [], 1, stdout=b"private remote output", stderr=b"private credential details",
        )
        with self.assertRaises(ValueError) as error:
            release.run("gh", "api", "synthetic")
        self.assertNotIn("private", str(error.exception).replace("privately", ""))
        self.assertTrue(self.process.call_args.kwargs["capture_output"])

    def test_current_attempt_and_every_required_job_are_verified(self):
        with patch.object(release, "api", side_effect=[run_record(), jobs()]) as api:
            self.assertEqual(release.checked_run(17, "ci", "push", SHA)["run_attempt"], 2)
        self.assertEqual(api.call_args_list[1].args, ("actions/runs/17/attempts/2/jobs?per_page=100",))

    def test_wrong_repository_fork_workflow_event_ref_sha_or_state_fails(self):
        changes = [
            {"repository": {"full_name": "other/repository"}},
            {"head_repository": {"full_name": "other/repository"}},
            {"path": ".github/workflows/untrusted.yml"}, {"event": "pull_request"},
            {"head_branch": "feature"}, {"head_sha": "d" * 40},
            {"status": "in_progress"}, {"conclusion": "skipped"},
        ]
        for change in changes:
            with self.subTest(change=change), patch.object(release, "api", side_effect=[
                {**run_record(), **change}, jobs(),
            ]), self.assertRaises(ValueError):
                release.checked_run(17, "ci", "push", SHA)

    def test_every_required_job_must_pass_once(self):
        for name in sorted(release.CI_JOBS):
            for conclusion in ("skipped", "failure", "cancelled", None):
                listing = jobs()
                next(job for job in listing["jobs"] if job["name"] == name)["conclusion"] = conclusion
                with self.subTest(name=name, conclusion=conclusion), patch.object(
                    release, "api", side_effect=[run_record(), listing]
                ), self.assertRaises(ValueError):
                    release.checked_run(17, "ci", "push", SHA)
        for listing in (jobs(set(release.CI_JOBS) - {"Lint"}), jobs()):
            if len(listing["jobs"]) == len(release.CI_JOBS):
                listing["jobs"].append(copy.deepcopy(listing["jobs"][0]))
                listing["total_count"] += 1
            with patch.object(release, "api", side_effect=[run_record(), listing]), self.assertRaises(ValueError):
                release.checked_run(17, "ci", "push", SHA)

    def test_invalid_run_ids_and_sha_do_not_reach_remote_api(self):
        for value in ("", 0, -1, "17/attempts/1", "$(command)"):
            with patch.object(release, "api") as api, self.assertRaises(ValueError):
                release.checked_run(value, "ci", "push", SHA)
            api.assert_not_called()
        for value in (None, "main", "abc123", SHA + "\n", "A" * 40):
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.sha(value)

    def test_validation_and_hosted_staging_require_their_own_job(self):
        for workflow, event, required in (("release-validation", "workflow_run", "Synthetic validation"),
                                           ("staging", "workflow_dispatch", "Hosted staging")):
            for listing in (jobs(set()), jobs({"Unrelated task"}), jobs({required})):
                with self.subTest(workflow=workflow, listing=listing), patch.object(
                    release, "api", side_effect=[run_record(workflow, event), listing]
                ):
                    if required in {job["name"] for job in listing["jobs"]}:
                        release.checked_run(41, workflow, event)
                    else:
                        with self.assertRaises(ValueError):
                            release.checked_run(41, workflow, event)

    def test_dirty_checkout_cannot_be_packaged(self):
        with tempfile.TemporaryDirectory() as name, patch.object(release, "run", side_effect=[
            SHA.encode(), b" M uncommitted.ts\n",
        ]), patch.object(release, "checked_run") as check, self.assertRaises(ValueError):
            release.package(Path(name) / "release", 17)
        check.assert_not_called()


class ArchiveTests(OfflineTest):
    def test_full_migration_names_survive_same_timestamp_and_source_marker_is_pinned(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            expected, _ = bundle(directory)
            self.assertEqual(release.verify_archive(directory, SHA), expected)
            self.assertEqual([item["name"] for item in release.migrations(directory / "source")], list(MIGRATIONS))
            self.assertEqual((directory / "source/.wekruit-source-revision").read_text(), SHA + "\n")

    def test_modified_archive_is_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            bundle(directory)
            with (directory / "source.tar").open("ab") as archive:
                archive.write(b"tampered")
            with self.assertRaisesRegex(ValueError, "checksum"):
                release.verify_archive(directory, SHA)
            self.assertFalse((directory / "source").exists())

    def test_mismatched_identity_migration_or_source_dependency_is_rejected(self):
        changes = [
            {"repository": "other/repo"}, {"sha": "d" * 40}, {"format": 1},
            {"migrations": []}, {"migrations": [{"name": MIGRATIONS[0], "sha256": "0" * 64}]},
            {"headhunter": {**DEPENDENCY, "sha": "d" * 40}},
        ]
        for change in changes:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                manifest, _ = bundle(directory)
                (directory / "release.json").write_text(json.dumps({**manifest, **change}))
                with self.assertRaises(ValueError):
                    release.verify_archive(directory, SHA)

    def test_traversal_absolute_links_and_special_entries_are_rejected_before_any_write(self):
        for path, kind in (("../escaped", tarfile.REGTYPE), ("/escaped", tarfile.REGTYPE),
                           ("symlink", tarfile.SYMTYPE), ("hardlink", tarfile.LNKTYPE),
                           ("device", tarfile.CHRTYPE)):
            with self.subTest(path=path, kind=kind), tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                manifest, _ = bundle(directory)
                stream = io.BytesIO()
                with tarfile.open(fileobj=stream, mode="w") as archive:
                    entry = tarfile.TarInfo(path)
                    entry.type = kind
                    entry.linkname = "../escaped" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
                    archive.addfile(entry)
                data = stream.getvalue()
                (directory / "source.tar").write_bytes(data)
                manifest["archive_sha256"] = hashlib.sha256(data).hexdigest()
                (directory / "release.json").write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, "Unsafe source"):
                    release.verify_archive(directory, SHA)
                self.assertFalse((directory / "source").exists())

    def test_existing_extraction_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            bundle(directory)
            (directory / "source").mkdir()
            marker = directory / "source/preserve.txt"
            marker.write_text("existing work")
            with self.assertRaises(ValueError):
                release.verify_archive(directory, SHA)
            self.assertEqual(marker.read_text(), "existing work")

    def fetch_fixture(self, directory, manifest_change=None, ci_attempt=2, original=None):
        def fake_run(*args, **_kwargs):
            if args[:3] == ("gh", "run", "download"):
                manifest, _ = bundle(directory)
                if manifest_change:
                    manifest_change(manifest)
                    (directory / "release.json").write_text(json.dumps(manifest))
                return b""
            if args[:3] == ("git", "archive", "--format=tar"):
                return original if original is not None else (directory / "source.tar").read_bytes()
            raise AssertionError("Unexpected release command")
        return (
            patch.object(release, "run", side_effect=fake_run),
            patch.object(release, "checked_run", side_effect=[
                run_record("release-validation", "workflow_run"), {**run_record(), "run_attempt": ci_attempt},
            ]),
            patch.object(release, "api", return_value={"total_count": 1, "artifacts": [
                {"name": "release-41-2", "expired": False},
            ]}),
        )

    def test_fetch_requires_unchanged_ci_attempt_staging_provenance_and_original_git_bytes(self):
        cases = [
            {"ci_attempt": 3}, {"original": b"different original source"},
            {"manifest_change": lambda manifest: manifest["validation"].update(attempt=1)},
            {"manifest_change": lambda manifest: manifest["validation"].update(id=42)},
            {"manifest_change": lambda manifest: manifest["validation"].update(workflow_sha="d" * 40)},
        ]
        for options in cases:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as name:
                directory = Path(name) / "release"
                command, check, api = self.fetch_fixture(directory, **options)
                with command, check, api, self.assertRaises(ValueError):
                    release.fetch_validation(directory, 41, SHA)

    def test_fetch_accepts_matching_provenance_and_original_git_bytes(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name) / "release"
            command, check, api = self.fetch_fixture(directory)
            with command as run, check, api:
                manifest = release.fetch_validation(directory, 41, SHA)
            self.assertEqual(manifest["sha"], SHA)
            self.assertEqual((directory / "source/.wekruit-source-revision").read_text(), SHA + "\n")
            self.assertEqual(run.call_args.args, ("git", "archive", "--format=tar", SHA))

    def test_fetch_accepts_only_the_unique_current_unexpired_artifact(self):
        for artifacts in ([], [{"name": "release-41-1", "expired": False}],
                          [{"name": "release-41-2", "expired": True}],
                          [{"name": "release-41-2", "expired": False}] * 2):
            with tempfile.TemporaryDirectory() as name, patch.object(release, "checked_run", return_value=run_record("release-validation", "workflow_run")), patch.object(release, "api", return_value={
                "total_count": len(artifacts), "artifacts": artifacts,
            }), patch.object(release, "run") as run, self.assertRaises(ValueError):
                release.fetch_validation(Path(name) / "release", 41, SHA)
            run.assert_not_called()


class ApprovalTests(OfflineTest):
    def test_complete_current_prerequisites_are_accepted(self):
        with tempfile.TemporaryDirectory() as name:
            manifest, _ = bundle(Path(name))
            self.assertEqual(release.approval(manifest, approval_env(), NOW)["sha"], SHA)

    def test_disabled_hold_missing_expired_wrong_source_or_live_runs_never_invoke_modal(self):
        base = approval_env()
        approval_changes = [
            {"sha": "d" * 40}, {"staging_run_id": 42}, {"source_sha": "d" * 40},
            {"previous_sha": "main"}, {"active_runs": 1}, {"active_runs": False},
            {"expires_at": (NOW - dt.timedelta(seconds=1)).isoformat()},
            {"expires_at": (NOW + dt.timedelta(minutes=31)).isoformat()},
            {"expires_at": NOW.replace(tzinfo=None).isoformat()},
        ] + [{key: False} for key in ("autumn_paused", "source_migrations_verified",
                                     "product_migrations_approved", "rollback_compatible")]
        environments = [{}, {**base, "MODAL_PROMOTION_ENABLED": "false"},
                        {**base, "PRODUCTION_DEPLOYMENT_HOLD": "held"},
                        {**base, "PRODUCTION_RELEASE_APPROVAL": "{}"}]
        for change in approval_changes:
            value = {**json.loads(base["PRODUCTION_RELEASE_APPROVAL"]), **change}
            environments.append({**base, "PRODUCTION_RELEASE_APPROVAL": json.dumps(value)})
        for environ in environments:
            with self.subTest(environ=environ), tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                bundle(directory)
                with patch.dict(os.environ, environ, clear=True), patch.object(release, "run") as run:
                    with self.assertRaises((ValueError, KeyError)):
                        release.promote(directory, SHA)
                    run.assert_not_called()

    def test_invalid_origin_is_rejected_before_any_modal_call_or_source_access(self):
        for origin in ("http://example.test", "https://user:pass@example.test",
                       "https://example.test/path", "https://example.test?token=private"):
            with self.subTest(origin=origin), tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                bundle(directory)
                with patch.dict(os.environ, {**approval_env(), "PRODUCTION_ORIGIN": origin}, clear=True), patch.object(
                    release, "run"
                ) as run, patch.object(release, "verify_promotion_source") as verify:
                    with self.assertRaises(ValueError):
                        release.promote(directory, SHA)
                    run.assert_not_called()
                    verify.assert_not_called()


class PromotionSourceTests(OfflineTest):
    def test_exact_extracted_source_is_reverified_against_current_validation(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            manifest, archive = bundle(directory)
            release.verify_archive(directory, SHA)
            with patch.object(release, "checked_run", side_effect=[run_record("release-validation", "workflow_run"), run_record()]) as check, patch.object(release, "run", return_value=archive):
                release.verify_validation_source(directory, manifest)
            self.assertEqual(check.call_args_list[0].args, (41, "release-validation", "workflow_run", SHA))
            self.assertEqual(check.call_args_list[1].args, (17, "ci", "push", SHA))

    def test_changes_after_fetch_cannot_reach_deployment(self):
        def change_file(directory, _manifest):
            (directory / "source/infra/release/headhunter.json").write_text("changed source")

        def add_file(directory, _manifest):
            (directory / "source/unexpected.py").write_text("unexpected source")

        def change_mode(directory, _manifest):
            (directory / "source/infra/release/headhunter.json").chmod(0o755)

        def add_link(directory, _manifest):
            (directory / "source/link").symlink_to("infra/release/headhunter.json")

        def change_archive(directory, _manifest):
            with (directory / "source.tar").open("ab") as archive:
                archive.write(b"changed archive")

        mutations = [change_file, add_file, change_mode, add_link, change_archive,
                     lambda directory, _manifest: (directory / "source/.wekruit-source-revision").write_text("d" * 40),
                     lambda _directory, manifest: manifest["migrations"][0].update(sha256="0" * 64),
                     lambda _directory, manifest: manifest["headhunter"].update(presence_protocol=1)]
        for mutate in mutations:
            with self.subTest(mutation=mutate.__name__), tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                manifest, archive = bundle(directory)
                release.verify_archive(directory, SHA)
                mutate(directory, manifest)
                (directory / "release.json").write_text(json.dumps(manifest))

                def fake_run(*args, **_kwargs):
                    if args[:3] == ("git", "archive", "--format=tar"):
                        return archive
                    raise AssertionError("Invalid source reached an external command")

                with patch.dict(os.environ, approval_env(), clear=True), patch.object(release, "checked_run", side_effect=[
                    run_record("release-validation", "workflow_run"), run_record(),
                ]), patch.object(release, "run", side_effect=fake_run), self.assertRaises(ValueError):
                    release.verify_validation_source(directory, manifest)

    def test_rerunning_either_validation_requires_restage(self):
        for changed in (0, 1):
            with tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                manifest, _archive = bundle(directory)
                release.verify_archive(directory, SHA)
                records = [run_record("release-validation", "workflow_run"), run_record()]
                records[changed]["run_attempt"] += 1
                with patch.object(release, "checked_run", side_effect=records), patch.object(release, "run") as run, self.assertRaises(ValueError):
                    release.verify_validation_source(directory, manifest)
                run.assert_not_called()




class EnvironmentTests(OfflineTest):
    def policy(self):
        return [
            {"deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True},
             "protection_rules": [{"type": "required_reviewers",
                 "prevent_self_review": True, "reviewers": [{"type": "Team", "reviewer": {"id": 1}}]}]},
            {"total_count": 1, "branch_policies": [{"name": "main", "type": "branch"}]},
            {"total_count": 4, "secrets": [{"name": name} for name in (
                "PRODUCTION_MODAL_TOKEN_ID", "PRODUCTION_MODAL_TOKEN_SECRET", "PRODUCTION_RELEASE_APPROVAL", "ENVIRONMENT_AUDIT_TOKEN")]},
        ]

    def check_policy(self):
        release.protected_environment("production", {
            "PRODUCTION_MODAL_TOKEN_ID", "PRODUCTION_MODAL_TOKEN_SECRET", "PRODUCTION_RELEASE_APPROVAL",
        }, reviewers=True)

    def test_real_main_only_policy_independent_reviewers_and_scoped_secrets_are_required(self):
        with patch.dict(os.environ, {"ENVIRONMENT_AUDIT_TOKEN": "synthetic-audit-token"}, clear=True), patch.object(release, "api", side_effect=self.policy()) as api:
            self.check_policy()
        self.assertEqual([call.args[0] for call in api.call_args_list], [
            "environments/production", "environments/production/deployment-branch-policies?per_page=100",
            "environments/production/secrets?per_page=100",
        ])
        self.assertEqual(api.call_args.kwargs, {"token": "synthetic-audit-token"})
        self.assertTrue(all(not call.kwargs for call in api.call_args_list[:2]))

    def test_missing_weaker_or_inaccessible_controls_fail_closed(self):
        mutations = [
            lambda values: values[0].pop("deployment_branch_policy"),
            lambda values: values[0].update(deployment_branch_policy={"protected_branches": True, "custom_branch_policies": False}),
            lambda values: values[1]["branch_policies"][0].update(name="*"),
            lambda values: values[1]["branch_policies"][0].update(type="tag"),
            lambda values: values[1].update(total_count=2),
            lambda values: values[0].update(protection_rules=[]),
            lambda values: values[0]["protection_rules"][0].update(prevent_self_review=False),
            lambda values: values[0]["protection_rules"][0].update(reviewers=[]),
            lambda values: values[2]["secrets"].pop(),
            lambda values: values[2].update(total_count=101),
        ]
        for mutate in mutations:
            values = self.policy()
            mutate(values)
            with self.subTest(mutation=mutate), patch.dict(os.environ, {"ENVIRONMENT_AUDIT_TOKEN": "synthetic-audit-token"}, clear=True), patch.object(release, "api", side_effect=values), self.assertRaises(ValueError):
                self.check_policy()
        with patch.object(release, "api", side_effect=ValueError("read denied")), self.assertRaises(ValueError):
            self.check_policy()
        self.process.assert_not_called()

    def test_missing_scoped_metadata_credential_cannot_assume_repository_secrets_are_safe(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(release, "api", side_effect=self.policy()) as api, self.assertRaisesRegex(
            ValueError, "metadata read credential"
        ):
            self.check_policy()
        self.assertEqual(api.call_count, 2)


class HostedReceiptTests(OfflineTest):
    def remote_receipt(self, data):
        def download(directory, run_id, artifact):
            self.assertEqual((run_id, artifact), (71, "hosted-staging-71-2"))
            directory.mkdir(parents=True)
            (directory / "staging.json").write_text(json.dumps(data))
        return patch.object(release, "download_artifact", side_effect=download)

    def test_receipt_binds_actual_staging_run_exact_target_and_all_smokes(self):
        with tempfile.TemporaryDirectory() as name:
            manifest, _ = bundle(Path(name))
            expected = receipt(manifest)
            with patch.dict(os.environ, stage_env(), clear=True), patch.object(
                release, "checked_run", return_value=run_record("staging", "workflow_dispatch")
            ) as check, self.remote_receipt(expected):
                self.assertEqual(release.hosted_receipt(71, SHA), expected)
            check.assert_called_once_with(71, "staging", "workflow_dispatch")

    def test_synthetic_only_stale_wrong_target_or_incomplete_receipt_is_not_hosted_acceptance(self):
        changes = [
            {"format": 2}, {"repository": "other/repo"}, {"sha": "d" * 40},
            {"run": {"id": 71, "attempt": 1, "workflow_sha": SHA}},
            {"run": {"id": 72, "attempt": 2, "workflow_sha": SHA}},
            {"run": {"id": 71, "attempt": 2, "workflow_sha": "d" * 40}},
            {"modal_version": None}, {"modal_version": True}, {"modal_version": 0},
            {"checks": {"readiness": True, "revision": True, "web_shell": True}},
            {"checks": {"readiness": 1, "revision": True, "web_shell": True, "mutations_denied": True}},
            {"target": {**release.staging_target(stage_env()), "origin": "https://other.example.test"}},
        ]
        for change in changes:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as name:
                manifest, _ = bundle(Path(name))
                with patch.dict(os.environ, stage_env(), clear=True), patch.object(
                    release, "checked_run", return_value=run_record("staging", "workflow_dispatch")
                ), self.remote_receipt({**receipt(manifest), **change}), self.assertRaises(ValueError):
                    release.hosted_receipt(71, SHA)

    def test_fetch_matches_validation_inventory_and_resmokes_before_recording_receipt(self):
        for mismatch in (None, "archive_sha256", "validation", "smoke"):
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory() as name:
                root = Path(name)
                manifest, _ = bundle(root)
                expected = receipt(manifest)
                if mismatch == "archive_sha256":
                    expected["archive_sha256"] = "0" * 64
                if mismatch == "validation":
                    expected["validation"] = {**expected["validation"], "attempt": 1}
                directory = root / "candidate"
                directory.mkdir()
                with patch.object(release, "hosted_receipt", return_value=expected), patch.object(
                    release, "fetch_validation", return_value=manifest
                ) as fetch, patch.object(release, "smoke", side_effect=ValueError("stale") if mismatch == "smoke" else None) as smoke:
                    if mismatch:
                        with self.assertRaises(ValueError):
                            release.fetch(directory, 71, SHA)
                        self.assertFalse((directory / "staging.json").exists())
                    else:
                        self.assertEqual(release.fetch(directory, 71, SHA), manifest)
                        self.assertEqual(json.loads((directory / "staging.json").read_text()), expected)
                    fetch.assert_called_once_with(directory, 41, SHA)
                    if mismatch in (None, "smoke"):
                        smoke.assert_called_once_with("https://staging.example.test", SHA, staging=True)
                    else:
                        smoke.assert_not_called()

    def test_promotion_reauthenticates_local_evidence_before_source_check(self):
        for altered in (None, "manifest", "receipt"):
            with self.subTest(altered=altered), tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                manifest, _ = bundle(directory)
                original = receipt(manifest)
                (directory / "staging.json").write_text(json.dumps(original))
                def fetch(fresh, run_id, revision):
                    self.assertEqual((run_id, revision), (71, SHA))
                    fresh.mkdir()
                    data = {**original, "modal_version": 11} if altered == "receipt" else original
                    (fresh / "staging.json").write_text(json.dumps(data))
                    return {**manifest, "sha": "d" * 40} if altered == "manifest" else manifest
                with patch.dict(os.environ, {"STAGING_RUN_ID": "71"}, clear=True), patch.object(
                    release, "fetch", side_effect=fetch
                ) as retrieve, patch.object(release, "verify_validation_source") as verify:
                    if altered:
                        with self.assertRaises(ValueError):
                            release.verify_promotion_source(directory, manifest)
                        verify.assert_not_called()
                    else:
                        release.verify_promotion_source(directory, manifest)
                        verify.assert_called_once_with(directory, manifest)
                    self.assertEqual(retrieve.call_count, 1)


class HostedExecutionTests(OfflineTest):
    def info(self, version=10):
        return json.dumps({"description": "rakazo-staging-app",
                           "lifecycle": {"state": "deployed", "version": version}}).encode()

    def test_deploys_exact_source_with_isolated_env_and_records_actual_post_smoke_receipt(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            manifest, _ = bundle(directory)
            poisoned = {**stage_env(), "DATABASE_URL": "private database", "SMTP_URL": "private mail",
                        "OPENAI_API_KEY": "private key", "GH_TOKEN": "private github",
                        "PATH": "/synthetic/bin", "HOME": "/synthetic/home", "LANG": "C.UTF-8"}
            with patch.dict(os.environ, poisoned, clear=True), patch.object(release, "protected_environment") as policy, patch.object(
                release, "fetch_validation", return_value=manifest
            ), patch.object(release, "verify_validation_source") as verify, patch.object(
                release, "run", side_effect=[self.info(9), b"", self.info(10)]
            ) as run, patch.object(release, "smoke") as smoke, patch("builtins.print"):
                release.stage(directory, SHA)
            verify.assert_called_once_with(directory, manifest)
            policy.assert_called_once_with("staging", {"STAGING_MODAL_TOKEN_ID", "STAGING_MODAL_TOKEN_SECRET", "STAGING_RELEASE_APPROVAL"})
            self.assertEqual([call.args[:3] for call in run.call_args_list], [
                ("modal", "app", "info"), ("modal", "deploy", "--env"), ("modal", "app", "info"),
            ])
            deployment = run.call_args_list[1]
            self.assertEqual(deployment.args, ("modal", "deploy", "--env", "staging", "--strategy", "recreate",
                                               "--tag", SHA, "infra/modal/app.py"))
            self.assertEqual(deployment.kwargs["cwd"], directory / "source")
            self.assertEqual(set(deployment.kwargs["env"]), {"PATH", "HOME", "LANG", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET",
                "MODAL_ENVIRONMENT", "RAKAZO_RELEASE_PROFILE", "MODAL_APP_NAME", "MODAL_SECRET_NAME", "MODAL_VOLUME_NAME"})
            smoke.assert_called_once_with("https://staging.example.test", SHA, staging=True)
            self.assertEqual(json.loads((directory / "staging.json").read_text()), receipt(manifest))

    def test_invalid_staging_authority_isolation_or_target_cannot_reach_modal(self):
        base = stage_env()
        changes = [
            {"STAGING_DEPLOY_ENABLED": "false"}, {"STAGING_DEPLOYMENT_HOLD": "held"},
            {"MODAL_ENVIRONMENT": "production"}, {"RAKAZO_RELEASE_PROFILE": "production"},
            {"STAGING_MODAL_APP_NAME": "production-app"}, {"STAGING_ORIGIN": "http://staging.example.test"},
        ]
        for approval_change in ({"sha": "d" * 40}, {"validation_run_id": 42},
                                {"isolated_resources_verified": False}, {"synthetic_data_only": False},
                                {"expires_at": (NOW - dt.timedelta(seconds=1)).isoformat()}):
            changes.append({"STAGING_RELEASE_APPROVAL": json.dumps({
                **json.loads(base["STAGING_RELEASE_APPROVAL"]), **approval_change})})
        for change in changes:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                bundle(directory)
                with patch.dict(os.environ, {**base, **change}, clear=True), patch.object(release, "run") as run, self.assertRaises(ValueError):
                    release.stage(directory, SHA)
                run.assert_not_called()

    def test_failed_staging_smoke_records_no_acceptance_and_never_rolls_back_or_syncs(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            manifest, _ = bundle(directory)
            with patch.dict(os.environ, stage_env(), clear=True), patch.object(release, "protected_environment"), patch.object(
                release, "fetch_validation", return_value=manifest
            ), patch.object(release, "verify_validation_source"), patch.object(
                release, "run", side_effect=[self.info(), b""]
            ) as run, patch.object(release, "smoke", side_effect=ValueError("synthetic smoke failure")) as smoke, patch.object(
                release.time, "sleep"
            ) as sleep, self.assertRaisesRegex(ValueError, "Hosted staging smoke failed"):
                release.stage(directory, SHA)
            self.assertEqual(run.call_count, 2)
            self.assertEqual(smoke.call_count, 12)
            self.assertEqual(sleep.call_count, 11)
            self.assertFalse((directory / "staging.json").exists())

    def test_invalid_run_provenance_or_existing_receipt_is_rejected_before_modal(self):
        for change in ({"GITHUB_RUN_ID": "not-a-run"}, {"GITHUB_RUN_ATTEMPT": "0"},
                       {"GITHUB_SHA": "main"}, {"existing_receipt": True}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                manifest, _ = bundle(directory)
                if change.get("existing_receipt"):
                    (directory / "staging.json").write_text(json.dumps(receipt(manifest)))
                env = {**stage_env(), **{key: value for key, value in change.items() if key != "existing_receipt"}}
                with patch.dict(os.environ, env, clear=True), patch.object(release, "protected_environment"), patch.object(
                    release, "fetch_validation", return_value=manifest
                ), patch.object(release, "verify_validation_source"), patch.object(release, "run") as run, self.assertRaises((ValueError, KeyError)):
                    release.stage(directory, SHA)
                run.assert_not_called()

    def test_wrong_existing_app_or_changed_authenticated_source_never_deploys(self):
        for failure in ("app", "source"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                manifest, _ = bundle(directory)
                trusted = {**manifest, "sha": "d" * 40} if failure == "source" else manifest
                info = json.dumps({"description": "wrong-app", "lifecycle": {"state": "stopped"}}).encode()
                with patch.dict(os.environ, stage_env(), clear=True), patch.object(release, "protected_environment"), patch.object(
                    release, "fetch_validation", return_value=trusted
                ), patch.object(release, "verify_validation_source"), patch.object(release, "run", return_value=info) as run, self.assertRaises(ValueError):
                    release.stage(directory, SHA)
                self.assertTrue(all(call.args[:3] == ("modal", "app", "info") for call in run.call_args_list))

    def test_production_remains_blocked_even_when_every_existing_gate_is_green(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            manifest, _ = bundle(directory)
            with patch.dict(os.environ, approval_env(), clear=True), patch.object(release, "protected_environment") as policy, patch.object(
                release, "verify_promotion_source"
            ) as verify, patch.object(release, "run") as run, patch.object(release, "smoke") as smoke, self.assertRaisesRegex(
                ValueError, "Production cutover blocked: no enforced maintenance/drain"
            ):
                release.promote(directory, SHA)
            policy.assert_called_once_with("production", {"PRODUCTION_MODAL_TOKEN_ID", "PRODUCTION_MODAL_TOKEN_SECRET", "PRODUCTION_RELEASE_APPROVAL"}, reviewers=True)
            verify.assert_called_once_with(directory, manifest)
            run.assert_not_called()
            smoke.assert_not_called()


class Response:
    def __init__(self, status=200, headers=None, body=b""):
        self.status, self.headers, self.body = status, headers or {}, body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, limit):
        return self.body[:limit]


def ready_response(**overrides):
    values = {"status": 200, "headers": {"x-rakazo-revision": SHA},
              "body": json.dumps({"ok": True, "degraded": False}).encode()}
    return Response(**{**values, **overrides})


class SmokeTests(OfflineTest):
    def test_exact_version_readiness_and_web_shell_are_both_required(self):
        opener = Mock()
        opener.open.side_effect = [ready_response(), Response(
            headers={"content-type": "text/html; charset=utf-8"}, body=b'<html><div id="root"></div></html>',
        )]
        with patch.object(release.urllib.request, "build_opener", return_value=opener) as build:
            release.smoke("https://example.test", SHA)
        self.assertIsInstance(build.call_args.args[0], release.NoRedirect)
        self.assertEqual([call.args for call in opener.open.call_args_list], [
            ("https://example.test/ready",), ("https://example.test/",),
        ])
        self.assertTrue(all(call.kwargs["timeout"] == 10 for call in opener.open.call_args_list))

    def test_invalid_origins_never_make_a_request(self):
        for origin in ("http://example.test", "https://user:pass@example.test",
                       "https://example.test/path", "https://example.test?token=private",
                       "https://example.test#fragment", "file:///tmp/site"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                release.smoke(origin, SHA)
        self.network.assert_not_called()

    def test_hosted_staging_smoke_requires_profile_and_safe_synthetic_post_denial(self):
        opener = Mock()
        opener.open.side_effect = [
            ready_response(headers={"x-rakazo-revision": SHA, "x-rakazo-profile": "staging"}),
            Response(headers={"content-type": "text/html"}, body=b'<div id="root"></div>'),
            urllib.error.HTTPError("https://example.test/api/__release_smoke_denied__", 403,
                                   "Forbidden", {"x-rakazo-profile": "staging"}, io.BytesIO(b"")),
        ]
        with patch.object(release.urllib.request, "build_opener", return_value=opener):
            release.smoke("https://example.test", SHA, staging=True)
        request = opener.open.call_args_list[2].args[0]
        self.assertIsInstance(request, urllib.request.Request)
        self.assertEqual(request.full_url, "https://example.test/api/__release_smoke_denied__")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.data, b"{}")
        self.assertNotIn("Authorization", request.headers)
        self.assertNotIn("Cookie", request.headers)

    def test_stage_profile_missing_or_mutation_fence_missing_cannot_pass_smoke(self):
        for bad in ("profile", "status", "fence-profile"):
            opener = Mock()
            headers = {"x-rakazo-revision": SHA, "x-rakazo-profile": "staging"}
            if bad == "profile":
                headers.pop("x-rakazo-profile")
            opener.open.side_effect = [
                ready_response(headers=headers),
                Response(headers={"content-type": "text/html"}, body=b'<div id="root"></div>'),
                Response(status=200 if bad == "status" else 403,
                         headers={} if bad == "fence-profile" else {"x-rakazo-profile": "staging"}),
            ]
            with self.subTest(bad=bad), patch.object(release.urllib.request, "build_opener", return_value=opener), self.assertRaises(ValueError):
                release.smoke("https://example.test", SHA, staging=True)
            self.assertEqual(opener.open.call_count, 1 if bad == "profile" else 3)

    def test_wrong_readiness_status_body_or_revision_never_accepts_web_only_success(self):
        responses = [ready_response(status=503), ready_response(status=302),
                     ready_response(headers={}), ready_response(headers={"x-rakazo-revision": "d" * 40}),
                     ready_response(body=b'{"ok":true,"degraded":true}'),
                     ready_response(body=b'{"ok":true}'), ready_response(body=b"not-json"),
                     ready_response(body=b'{"ok":1,"degraded":0}'),
                     ready_response(body=b'{"ok":true,"degraded":0}')]
        for response in responses:
            opener = Mock()
            opener.open.return_value = response
            with self.subTest(response=response), patch.object(release.urllib.request, "build_opener", return_value=opener), self.assertRaises(ValueError):
                release.smoke("https://example.test", SHA)
            self.assertEqual(opener.open.call_count, 1)

    def test_wrong_shell_status_type_or_content_is_rejected(self):
        for response in (Response(status=503), Response(headers={"content-type": "application/json"}, body=b'id="root"'),
                         Response(headers={"content-type": "application/json;foo=text/html"}, body=b'id="root"'),
                         Response(headers={"content-type": "text/html"}, body=b"wrong application")):
            opener = Mock()
            opener.open.side_effect = [ready_response(), response]
            with patch.object(release.urllib.request, "build_opener", return_value=opener), self.assertRaises(ValueError):
                release.smoke("https://example.test", SHA)

    def test_redirect_handler_refuses_cross_origin_and_same_origin_redirects(self):
        handler = release.NoRedirect()
        request = urllib.request.Request("https://example.test/ready")
        for target in ("https://another.example/ready", "https://example.test/login"):
            self.assertIsNone(handler.redirect_request(request, None, 302, "Found", {}, target))
        opener = Mock()
        opener.open.side_effect = urllib.error.HTTPError("https://example.test/ready", 302, "Found", {}, None)
        with patch.object(release.urllib.request, "build_opener", return_value=opener), self.assertRaises(urllib.error.HTTPError):
            release.smoke("https://example.test", SHA)


if __name__ == "__main__":
    unittest.main()
