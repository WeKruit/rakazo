import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("release_config", Path(__file__).resolve().parents[1] / "modal/release_config.py")
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)
SHA = "a" * 40


def fixture():
    return {"MODAL_ENVIRONMENT": "staging", "RAKAZO_RELEASE_PROFILE": "staging",
            "MODAL_APP_NAME": "rakazo-staging", "MODAL_SECRET_NAME": "rakazo-staging-config",
            "MODAL_VOLUME_NAME": "rakazo-staging-files",
            "STAGING_DATABASE_URL": "postgresql://rakazo_staging:synthetic@db.example.test/rakazo_staging?sslmode=verify-full",
            "STAGING_BETTER_AUTH_SECRET": "a" * 32, "STAGING_ENCRYPTION_KEY": "b" * 32}


class ModalConfigTests(unittest.TestCase):
    def test_staging_never_inherits_provider_or_modal_credentials(self):
        parent = {**fixture(), "MODAL_TOKEN_SECRET": "do-not-inherit", "OPENAI_API_KEY": "do-not-inherit",
                  "NODE_OPTIONS": "do-not-inherit", "AXIOM_TOKEN": "do-not-inherit", "PGSERVICE": "do-not-inherit",
                  "HOME": "do-not-inherit", "FIRST_PARTY_MCP_URL": "do-not-inherit"}
        env = config.staging_environment(parent, "https://stage.example.test", SHA)
        self.assertNotIn("do-not-inherit", env.values())
        self.assertFalse(any(key.startswith(("STAGING_", "MODAL_")) for key in env))
        self.assertEqual(env["DATABASE_URL"], parent["STAGING_DATABASE_URL"])
        self.assertEqual(env["REALTIME_DATABASE_URL"], env["DATABASE_URL"])
        self.assertEqual(env["RAKAZO_RELEASE_PROFILE"], "staging")
        self.assertEqual(env["AGENT_RUNTIME"], "scripted")
        self.assertEqual(env["SANDBOX_PROVIDER"], "fake")

    def test_staging_has_no_default_resources_or_generic_credentials(self):
        for key in ("MODAL_APP_NAME", "MODAL_SECRET_NAME", "MODAL_VOLUME_NAME", "MODAL_ENVIRONMENT"):
            for value in ("", "production"):
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    config.staging_environment({**fixture(), key: value}, "https://stage.example.test", SHA)
        for key in ("DATABASE_URL", "REALTIME_DATABASE_URL", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY", "SMTP_URL"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                config.staging_environment({**fixture(), key: "unexpected"}, "https://stage.example.test", SHA)
        for profile in ("production", "typo", ""):
            with self.assertRaises(ValueError):
                config.release_profile({**fixture(), "RAKAZO_RELEASE_PROFILE": profile})
        self.assertEqual(config.release_profile({}), "production")

    def test_database_role_name_tls_and_independent_keys_are_required(self):
        url = fixture()["STAGING_DATABASE_URL"]
        bad = [url.replace("rakazo_staging:", "postgres:"), url.replace("/rakazo_staging?", "/production?"),
               url.replace("sslmode=verify-full", "sslmode=disable"), url + "&schema=production",
               url + "&host=other.example.test", url.replace(":synthetic@", "@"), url + "#fragment"]
        for database in bad:
            with self.subTest(database=database), self.assertRaises(ValueError):
                config.staging_environment({**fixture(), "STAGING_DATABASE_URL": database}, "https://stage.example.test", SHA)
        for key in ("STAGING_BETTER_AUTH_SECRET", "STAGING_ENCRYPTION_KEY"):
            with self.assertRaises(ValueError):
                config.staging_environment({**fixture(), key: ""}, "https://stage.example.test", SHA)

    def test_dotenv_rejected_before_any_connection(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / "packages").mkdir()
            (root / ".env.example").write_text("example")
            config.reject_staging_dotenv(root)
            (root / "packages/.env.local").write_text("never read")
            with self.assertRaises(ValueError):
                config.reject_staging_dotenv(root)

    def test_database_identity_preflight_is_readonly_bounded_and_redacted(self):
        env = config.staging_environment(fixture(), "https://stage.example.test", SHA)
        for code in (0, 1):
            with patch.object(config.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], code, stdout=b"private", stderr=b"private",
            )) as command:
                if code:
                    with self.assertRaisesRegex(ValueError, "identity verification failed"):
                        config.check_staging_database(env, Path("/synthetic"))
                else:
                    config.check_staging_database(env, Path("/synthetic"))
            self.assertIn("SELECT current_database() AS db, current_user AS role", command.call_args.args[0][-1])
            self.assertTrue(command.call_args.kwargs["capture_output"])
            self.assertEqual(command.call_args.kwargs["timeout"], 15)
            self.assertEqual(command.call_args.kwargs["env"], env)


if __name__ == "__main__":
    unittest.main()
