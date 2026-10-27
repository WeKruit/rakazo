import unittest
from contextlib import contextmanager
from dataclasses import replace
from replacement import Fleet, ReplacementController, Worker


class FakeDriver:
    def __init__(self):
        self.workers = {key: Worker(key, True, False, False, 5) for key in ('a', 'b')}
        self.api = 1
        self.other = 0
        self.events = []
        self.locked = False
        self.drain_ok = self.stop_ok = self.release_ok = self.ready_ok = True
        self.lose_peer = False

    @contextmanager
    def replacement_lease(self):
        if self.locked:
            raise RuntimeError('replacement already leased')
        self.locked = True
        self.events.append('lease')
        try:
            yield
        finally:
            self.locked = False
            self.events.append('unlock')

    def observe(self):
        assert self.locked
        self.events.append('observe')
        return Fleet(tuple(self.workers.values()), self.api, self.other)

    def drain(self, key):
        self.events.append(('drain', key))
        self.workers[key] = replace(self.workers[key], ready=False, drained=self.drain_ok)
        if self.lose_peer:
            self.workers['b'] = replace(self.workers['b'], ready=False)

    def stop(self, key):
        self.events.append(('stop', key))
        self.workers[key] = replace(self.workers[key], stopped=self.stop_ok,
                                    sessions=0 if self.release_ok else 5)

    def start(self, key, session_limit):
        assert self.workers[key].stopped and self.workers[key].sessions == 0
        assert sum(w.sessions for w in self.workers.values()) + self.api + self.other + session_limit <= 15
        self.events.append(('start', key, session_limit))
        new = key + '-new'
        self.workers[new] = Worker(new, self.ready_ok, False, False, session_limit)
        return new


class ReplacementTests(unittest.TestCase):
    def run_controller(self, driver, targets=('a', 'b')):
        now = [0.0]
        def wait(seconds): now[0] += seconds
        result = ReplacementController(driver, timeout=3, interval=1,
                                       clock=lambda: now[0], wait=wait).replace(targets)
        self.assertLessEqual(now[0], 3)
        return result

    def test_serial_order_and_real_session_release_before_start(self):
        d = FakeDriver()
        result = self.run_controller(d)
        self.assertEqual(result.status, 'completed')
        self.assertEqual(result.completed, (('a', 'a-new'), ('b', 'b-new')))
        self.assertEqual([e for e in d.events if isinstance(e, tuple)],
                         [('drain', 'a'), ('stop', 'a'), ('start', 'a', 5),
                          ('drain', 'b'), ('stop', 'b'), ('start', 'b', 5)])
        self.assertEqual(d.events[0], 'lease')
        self.assertEqual(d.events[-1], 'unlock')

    def test_drain_deadline_postpones_without_killing(self):
        d = FakeDriver(); d.drain_ok = False
        self.assertEqual(self.run_controller(d).status, 'postponed')
        self.assertFalse(any(isinstance(e, tuple) and e[0] in ('stop', 'start') for e in d.events))

    def test_stop_and_release_are_both_required(self):
        for flag in ('stop_ok', 'release_ok'):
            with self.subTest(flag=flag):
                d = FakeDriver(); setattr(d, flag, False)
                self.assertEqual(self.run_controller(d).status, 'failed')
                self.assertFalse(any(isinstance(e, tuple) and e[0] == 'start' for e in d.events))

    def test_not_ready_replacement_stops_before_next_worker(self):
        d = FakeDriver(); d.ready_ok = False
        self.assertEqual(self.run_controller(d).status, 'failed')
        self.assertNotIn(('drain', 'b'), d.events)

    def test_keep_one_other_ready_worker(self):
        d = FakeDriver(); del d.workers['b']
        self.assertEqual(self.run_controller(d, ('a',)).status, 'postponed')
        self.assertNotIn(('drain', 'a'), d.events)

    def test_lost_peer_after_drain_does_not_kill(self):
        d = FakeDriver(); d.lose_peer = True
        self.assertEqual(self.run_controller(d).status, 'failed')
        self.assertNotIn(('stop', 'a'), d.events)

    def test_capacity_includes_unrelated_sessions_and_no_start_overlap(self):
        d = FakeDriver(); d.other = 5
        self.assertEqual(self.run_controller(d).status, 'failed')
        self.assertNotIn(('drain', 'a'), d.events)
        d = FakeDriver(); d.other = 4
        self.assertEqual(self.run_controller(d).status, 'completed')

    def test_driver_failure_and_lease_failure_stop_progress(self):
        d = FakeDriver(); d.locked = True
        self.assertEqual(self.run_controller(d).status, 'failed')
        self.assertEqual(d.events, [])
        d = FakeDriver()
        def fail(_): raise RuntimeError('stop failed')
        d.stop = fail
        self.assertEqual(self.run_controller(d).status, 'failed')
        self.assertNotIn(('drain', 'b'), d.events)

    def test_atomic_capacity_admission_failure_stops_progress(self):
        d = FakeDriver()
        def reject(*_): raise RuntimeError("capacity reservation rejected")
        d.start = reject
        self.assertEqual(self.run_controller(d).status, "failed")
        self.assertNotIn(("drain", "b"), d.events)

    def test_disappearing_worker_is_not_confirmation(self):
        d = FakeDriver()
        d.stop = lambda key: d.workers.pop(key)
        self.assertEqual(self.run_controller(d).status, 'failed')
        self.assertNotIn(('start', 'a', 5), d.events)

    def test_duplicate_targets_and_invalid_budgets_fail_closed(self):
        d = FakeDriver()
        self.assertEqual(self.run_controller(d, ('a', 'a')).status, 'failed')
        d = FakeDriver(); d.api = 2
        self.assertEqual(self.run_controller(d).status, 'failed')
        d = FakeDriver(); d.workers['a'] = replace(d.workers['a'], sessions=6)
        self.assertEqual(self.run_controller(d).status, 'failed')


if __name__ == '__main__':
    unittest.main()
