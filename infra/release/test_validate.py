import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch

import validate


SHA = "a" * 40


class SyntheticValidationTests(unittest.TestCase):
    def test_credentials_and_configuration_are_not_inherited(self):
        poisoned = {
            "PATH": "/usr/bin", "HOME": "/private/home", "DATABASE_URL": "private",
            "REALTIME_DATABASE_URL": "private", "PGSERVICE": "private", "PGPASSFILE": "private",
            "PGHOST": "private", "PGPORT": "5432", "SMTP_URL": "private", "OPENAI_API_KEY": "private",
            "OIDC_CLIENT_SECRET": "private", "FIRST_PARTY_MCP_URL": "private",
            "MODAL_TOKEN_SECRET": "private", "NODE_OPTIONS": "private", "VERIFY_PROVIDERS": "1",
            "HTTPS_PROXY": "private", "GH_TOKEN": "private", "AXIOM_TOKEN": "private",
        }
        env = validate.isolated_env(poisoned, Path("/tmp/synthetic-stage"), SHA)
        self.assertEqual(env["PATH"], poisoned["PATH"])
        self.assertFalse(any(value == "private" for value in env.values()))
        self.assertNotIn("DATABASE_URL", env)
        self.assertNotIn("VERIFY_PROVIDERS", env)
        self.assertEqual(env["HOME"], "/tmp/synthetic-stage/home")
        self.assertEqual(env["SANDBOX_PROVIDER"], "fake")
        self.assertEqual(env["NODE_ENV"], "test")
        self.assertEqual(env["RAKAZO_GIT_SHA"], SHA)

    def test_source_sha_must_be_full(self):
        for value in ("main", "abc123", SHA + "\n", "$(exit 1)"):
            with self.assertRaises(ValueError):
                validate.isolated_env({}, Path("/tmp/staging"), value)

    def test_dotenv_blocks_before_startup_but_examples_are_allowed(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / ".env.example").write_text("synthetic example")
            validate.reject_dotenv(root)
            (root / "packages").mkdir()
            (root / "packages" / ".env.local").write_text("do not read")
            with self.assertRaisesRegex(ValueError, "without dotenv"):
                validate.reject_dotenv(root)

    def test_mismatched_and_dirty_sources_are_rejected(self):
        for results in (("b" * 40, ""), (SHA, " M source.ts"), (SHA, "?? untracked.ts")):
            with patch.object(validate, "run", side_effect=[
                subprocess.CompletedProcess([], 0, stdout=value) for value in results
            ]), self.assertRaises(ValueError):
                validate.validate_checkout(Path("/tmp/staging"), {}, SHA)

    def test_missing_native_tools_fail_without_installing_anything(self):
        with patch.object(validate.shutil, "which", return_value=None), patch.object(validate, "run") as run:
            with self.assertRaisesRegex(ValueError, "Native PostgreSQL"):
                validate.postgres_bin(None, Path("/tmp/staging"), {"PATH": "/usr/bin"})
            run.assert_not_called()

    def run_stage(self, failure=None):
        calls = []
        roots = []

        def fake_run(command, root, env, **_options):
            calls.append((command, env.copy()))
            if "initdb" in command[0]:
                cluster = Path(command[command.index("-D") + 1])
                cluster.mkdir()
                roots.append(cluster.parent)
            if command[-1] == "start":
                cluster = Path(command[command.index("-D") + 1])
                (cluster / "postmaster.pid").write_text("synthetic")
            if failure and failure(command):
                raise subprocess.CalledProcessError(1, command)
            return subprocess.CompletedProcess(command, 0)

        with patch.object(validate, "validate_checkout"), patch.object(validate, "postgres_bin", return_value=Path("/fake/pg")), patch.object(validate, "free_port", return_value=43219), patch.object(validate, "run", side_effect=fake_run), patch.dict(os.environ, {"DATABASE_URL": "never-use", "SMTP_URL": "never-use"}):
            try:
                validate.stage(Path("/fake/repo"), SHA)
            except subprocess.CalledProcessError:
                if not failure:
                    raise
        self.assertTrue(roots)
        self.assertTrue(all(not path.exists() for path in roots))
        self.assertEqual(calls[-1][0][-1], "stop")
        return calls

    def test_each_suite_gets_a_fresh_local_database_and_no_credentials(self):
        calls = self.run_stage()
        tests = [(command, env) for command, env in calls if "vitest" in command]
        self.assertEqual([command[-1] for command, _ in tests], list(validate.SUITES))
        self.assertEqual(
            [env["DATABASE_URL"] for _, env in tests],
            [f"postgresql://staging@127.0.0.1:43219/staging_{i}?sslmode=disable" for i in range(len(validate.SUITES))],
        )
        migrations = [(command, env) for command, env in calls if command[-1] == "migrate"]
        self.assertEqual(len(migrations), len(validate.SUITES))
        for command, env in calls:
            self.assertNotIn("never-use", env.values())
            self.assertNotIn("docker", command)
            self.assertEqual(env["PGHOST"], "127.0.0.1")
            self.assertEqual(env["PGPORT"], "43219")

    def test_failure_stops_owned_cluster_and_does_not_run_later_suites(self):
        calls = self.run_stage(lambda command: "vitest" in command)
        self.assertEqual(sum("vitest" in command for command, _ in calls), 1)

    def test_startup_failure_never_migrates_any_database(self):
        calls = self.run_stage(lambda command: command[-1] == "start")
        self.assertFalse(any(command[-1] == "migrate" for command, _ in calls))
        self.assertFalse(any("createdb" in command[0] for command, _ in calls))

    def test_failed_stop_retains_the_owned_directory(self):
        directories = []

        def fake_run(command, _root, _env, **_options):
            if "initdb" in command[0]:
                cluster = Path(command[command.index("-D") + 1])
                cluster.mkdir()
                directories.append(cluster.parent)
            if command[-1] == "start":
                cluster = Path(command[command.index("-D") + 1])
                (cluster / "postmaster.pid").write_text("synthetic")
            if command[-1] == "stop":
                raise subprocess.CalledProcessError(1, command)
            return subprocess.CompletedProcess(command, 0)

        try:
            with patch.object(validate, "validate_checkout"), patch.object(validate, "postgres_bin", return_value=Path("/fake/pg")), patch.object(validate, "free_port", return_value=43219), patch.object(validate, "run", side_effect=fake_run):
                with self.assertRaisesRegex(RuntimeError, "temporary directory was retained"):
                    validate.stage(Path("/fake/repo"), SHA)
            self.assertTrue(directories)
            self.assertTrue(all(path.exists() for path in directories))
        finally:
            # The server is mocked; these are only this test's fixture directories.
            for directory in directories:
                shutil.rmtree(directory)


if __name__ == "__main__":
    unittest.main()
