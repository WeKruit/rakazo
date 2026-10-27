import unittest
from infra.modal.topology import session_budget, split_database_budget
from infra.modal.drain_worker import wait_for_drain


class TopologyTests(unittest.TestCase):
    def test_total_budget_includes_all_replicas_and_migration(self):
        self.assertEqual(session_budget(2, 2), 12)
        self.assertEqual(session_budget(2, 1, replacement_api=2, replacement_workers=1, migrations=1), 15)
        self.assertEqual(session_budget(2, 2, replacement_api=2), 14)
        for extra in ({"replacement_workers": 1}, {"replacement_api": 2, "replacement_workers": 2}):
            with self.assertRaises(ValueError):
                session_budget(2, 2, **extra)

    def test_split_urls_are_verified_not_just_different_strings(self):
        good = {"DATABASE_URL": "postgres://test:synthetic@localhost:6543/test",
                "REALTIME_DATABASE_URL": "postgres://test:synthetic@localhost:5432/test"}
        self.assertEqual(split_database_budget(good)["worker"]["DB_POOL_MAX"], "20")
        for bad in ({}, {**good, "DATABASE_URL": good["REALTIME_DATABASE_URL"]},
                    {**good, "REALTIME_DATABASE_URL": good["DATABASE_URL"]}):
            with self.assertRaises(ValueError):
                split_database_budget(bad)

    def test_drain_timeout_never_sends_termination(self):
        now, signals = [0], []
        with self.assertRaises(TimeoutError):
            wait_for_drain(123, 8001, 1, send_signal=lambda *args: signals.append(args),
                           read=lambda: {"state": "draining", "ok": True},
                           clock=lambda: now[0], sleep=lambda delay: now.__setitem__(0, now[0] + delay))
        self.assertEqual(len(signals), 1)
        import signal
        self.assertEqual(signals[0], (123, signal.SIGUSR2))

    def test_success_requires_positive_drained_receipt(self):
        for status in ({"state": "failed"}, {"state": "drained", "ok": False}):
            with self.assertRaises((RuntimeError, TimeoutError)):
                wait_for_drain(123, 8001, 0, send_signal=lambda *args: None, read=lambda: status)
        wait_for_drain(123, 8001, 1, send_signal=lambda *args: None,
                       read=lambda: {"state": "drained", "ok": True})

class RuntimeBudgetTests(unittest.TestCase):
    def test_existing_runtime_uses_strict_split_url_validation(self):
        import ast
        from pathlib import Path
        tree = ast.parse(Path("infra/modal/app.py").read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "service_budget")
        scope = {"split_database_budget": split_database_budget, "SERVICE_ENV": {"legacy": True}}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "service_budget", "exec"), scope)
        budget = scope["service_budget"]
        self.assertEqual(budget({"DATABASE_URL": "postgres://localhost:5432/test"}), {"legacy": True})
        with self.assertRaises(ValueError):
            budget({"DATABASE_URL": "postgres://localhost:5432/test", "REALTIME_DATABASE_URL": "postgres://other:5432/test"})
        self.assertEqual(budget({"DATABASE_URL": "postgres://localhost:6543/test", "REALTIME_DATABASE_URL": "postgres://localhost:5432/test"})["api"]["DB_POOL_MAX"], "20")
