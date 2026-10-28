import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from infra.modal.service_runtime import ServiceRuntime


class ServiceRuntimeTests(unittest.TestCase):
    def runtime(self):
        runtime = ServiceRuntime()
        runtime.root = Path("/synthetic")
        runtime.release_profile = "production"
        runtime.service_budget = lambda env: {"api": {"DB_POOL_MAX": "20"}, "worker": {"DB_POOL_MAX": "20"}}
        return runtime

    def test_api_and_worker_can_start_independently_without_cross_spawning(self):
        for service, ports in (("api", [3100, 8000]), ("worker", [8001])):
            with self.subTest(service=service), patch("infra.modal.service_runtime.subprocess.Popen") as spawn, \
                 patch("infra.modal.service_runtime.threading.Thread"), \
                 patch("infra.modal.service_runtime.socket.create_connection") as connect, \
                 patch("infra.modal.service_runtime.Path.write_text"), \
                 patch("infra.modal.service_runtime.subprocess.run") as migrate:
                spawn.return_value.poll.return_value = None
                self.runtime().start("https://synthetic.example.test", services=(service,), migrate=False,
                                     extra_env={"WORKER_HEALTH_PORT": "8001"})
                self.assertEqual(spawn.call_count, 1)
                self.assertEqual(spawn.call_args.kwargs["cwd"], f"/app/apps/{service}")
                self.assertEqual([call.args[0][1] for call in connect.call_args_list], ports)
                migrate.assert_not_called()

    def test_failed_migration_never_starts_children(self):
        with patch.dict("os.environ", {"DATABASE_URL": "postgres://synthetic@localhost/test"}), \
             patch("infra.modal.service_runtime.subprocess.run") as migrate, \
             patch("infra.modal.service_runtime.subprocess.Popen") as spawn:
            migrate.return_value.returncode = 1
            migrate.return_value.check_returncode.side_effect = RuntimeError("migration failed")
            with self.assertRaisesRegex(RuntimeError, "migration failed"):
                self.runtime().start("https://synthetic.example.test")
            spawn.assert_not_called()

    def test_reaps_all_processes_before_committing_legacy_volume(self):
        events=[]
        process=SimpleNamespace(pid=123, poll=lambda:0, wait=lambda **kwargs:events.append("reaped"))
        runtime=self.runtime();runtime.stopping=Mock();runtime.processes=[process]
        runtime.commit_volume=lambda:events.append("committed")
        runtime.stop()
        self.assertEqual(events[-1], "committed")
        self.assertTrue(all(event == "reaped" for event in events[:-1]))
        self.assertGreaterEqual(len(events), 2)
