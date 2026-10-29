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
                 patch("infra.modal.service_runtime.http.client.HTTPConnection") as connect, \
                 patch("infra.modal.service_runtime.Path.write_text"), \
                 patch("infra.modal.service_runtime.subprocess.run") as migrate:
                spawn.return_value.poll.return_value = None
                connect.return_value.getresponse.return_value.status = 200
                connect.return_value.getresponse.return_value.read.return_value = b'{"ok":true}'
                self.runtime().start("https://synthetic.example.test", services=(service,), migrate=False,
                                     extra_env={"WORKER_HEALTH_PORT": "8001"})
                self.assertEqual(spawn.call_count, 1)
                self.assertEqual(spawn.call_args.kwargs["cwd"], f"/app/apps/{service}")
                self.assertEqual([call.args[1] for call in connect.call_args_list], ports)
                connect.return_value.request.assert_called_with(
                    "GET", "/ready", headers={"Host": "synthetic.example.test"})
                migrate.assert_not_called()

    def test_open_port_does_not_admit_an_unready_service(self):
        with patch("infra.modal.service_runtime.subprocess.Popen") as spawn, \
             patch("infra.modal.service_runtime.threading.Thread"), \
             patch("infra.modal.service_runtime.time.sleep"), \
             patch("infra.modal.service_runtime.http.client.HTTPConnection") as connect:
            spawn.return_value.poll.return_value = None
            response = lambda status, body: SimpleNamespace(status=status, read=lambda limit: body)
            connect.return_value.getresponse.side_effect = [
                response(503, b'{"ok":false}'),
                response(200, b'{"ok":false}'),
                response(200, b'[]'),
                response(200, b'not json'),
                response(200, b'{"ok":true}'),
                response(200, b'{"ok":true}'),
            ]
            self.runtime().start("https://synthetic.example.test", services=("api",), migrate=False)
            self.assertEqual([call.args[1] for call in connect.call_args_list], [3100]*5 + [8000])
            self.assertEqual(connect.return_value.close.call_count, 6)

    def test_unready_service_times_out_instead_of_completing_startup(self):
        now = [0]
        with patch("infra.modal.service_runtime.subprocess.Popen") as spawn, \
             patch("infra.modal.service_runtime.threading.Thread"), \
             patch("infra.modal.service_runtime.time.monotonic", side_effect=lambda: now[0]), \
             patch("infra.modal.service_runtime.time.sleep", side_effect=lambda _: now.__setitem__(0, 151)), \
             patch("infra.modal.service_runtime.http.client.HTTPConnection") as connect:
            spawn.return_value.poll.return_value = None
            connect.return_value.getresponse.return_value.status = 503
            connect.return_value.getresponse.return_value.read.return_value = b'{"ok":false}'
            with self.assertRaisesRegex(TimeoutError, "/ready on port 3100"):
                self.runtime().start("https://synthetic.example.test", services=("api",), migrate=False)

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
