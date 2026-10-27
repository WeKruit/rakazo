"""Real Modal 1.6.1 definition tests; never hydrate or contact Modal."""
import unittest
from pathlib import Path
from unittest.mock import patch

import modal
from infra.modal.split_services import create_split_services


class Runtime:
    def __init__(self, events): self.events = events
    def start(self, *args, **kwargs): self.events.append(('start', args, kwargs))
    def stop(self): self.events.append(('stop',))


class SplitServiceTests(unittest.TestCase):
    def make(self, preflight=None):
        self.events = []
        self.instances = []
        def create_runtime():
            instance = Runtime(self.events)
            self.instances.append(instance)
            return instance
        return create_split_services(
            name='offline-split-test', image=modal.Image.debian_slim(), secrets=[],
            public_url='https://api.example.test', root=Path('/app'), release_profile='staging',
            preflight=preflight or (lambda service: self.events.append(('preflight', service))),
            runtime_factory=create_runtime,
        )

    def test_real_sdk_accepts_two_independent_server_definitions_without_resolution(self):
        self.assertEqual(modal.__version__, '1.6.1')
        options = []
        original = modal.App.server
        def record(app, **kwargs):
            options.append(kwargs)
            return original(app, **kwargs)
        # These are forbidden even if future factory changes attempt named-resource lookup.
        with patch.object(modal.App, 'server', record), \
             patch.object(modal.Volume, 'from_name', side_effect=AssertionError('remote lookup')), \
             patch.object(modal.Secret, 'from_name', side_effect=AssertionError('remote lookup')):
            services = self.make()
        self.assertIsNot(services.api, services.worker)
        self.assertEqual([o['port'] for o in options], [8000, 3101])
        self.assertEqual([o['min_containers'] for o in options], [1, 2])
        self.assertEqual([o['max_containers'] for o in options], [2, 2])
        self.assertEqual([o['unauthenticated'] for o in options], [True, False])
        self.assertTrue(all('volumes' not in o for o in options))
        self.assertEqual(self.events, [])  # Definitions never run startup/preflight.

    def test_registered_lifecycles_run_real_service_specific_calls(self):
        services = self.make()
        for server, service in ((services.api, 'api'), (services.worker, 'worker')):
            instance = server._get_user_cls()()
            server._get_user_cls().__dict__["enter"]._get_raw_f()(instance)
            self.assertEqual(self.events[-2], ('preflight', service))
            _, args, kwargs = self.events[-1]
            self.assertEqual(args, ('https://api.example.test',))
            self.assertEqual(kwargs['services'], (service,))
            self.assertFalse(kwargs['migrate'])
            self.assertEqual(kwargs['extra_env']['DATA_DIR'], '/tmp/rakazo-data')
            self.assertNotIn('commit_volume', kwargs)
            self.assertEqual(self.instances[-1].root, Path('/app'))
            server._get_user_cls().__dict__["exit"]._get_raw_f()(instance)
            self.assertEqual(self.events[-1], ('stop',))
        self.assertIsNot(self.instances[0], self.instances[1])

    def test_preflight_failure_prevents_runtime_creation_and_start(self):
        def deny(service): raise RuntimeError('activation or writer fence unavailable')
        services = self.make(deny)
        for server in (services.api, services.worker):
            instance = server._get_user_cls()()
            with self.assertRaisesRegex(RuntimeError, 'writer fence'):
                instance.start_service()
            instance.stop_service()  # Exit after failed enter is safe.
        self.assertEqual(self.instances, [])
        self.assertEqual(self.events, [])

    def test_boolean_preflight_results_cannot_authorize_start(self):
        for flag in (True, False):
            services = self.make(lambda service: flag)
            with self.assertRaises(TypeError):
                services.api._get_user_cls()().start_service()
            self.assertEqual(self.instances, [])

    def test_no_boolean_or_missing_preflight_bypass(self):
        with self.assertRaises(TypeError):
            create_split_services(name='offline', image=None, secrets=[], public_url='https://api.example.test',
                                  root=Path('/app'), release_profile='staging', preflight=True)


if __name__ == '__main__': unittest.main()
