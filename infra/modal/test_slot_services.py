import unittest
import tempfile
import json
import hashlib
from pathlib import Path
from unittest.mock import Mock, patch
import modal
from infra.modal.slot_services import define_slot_apps


class SlotServiceTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name)
        for process in ("api","worker"):
            directory=self.root / "apps" / process / "dist"
            directory.mkdir(parents=True)
            (directory / "index.mjs").write_text("// synthetic offline bundle")
            (directory / "build-manifest.json").write_text(json.dumps({"sessionAdmissionProtocol":1,"sourceRevision":"a"*40,"sha256":hashlib.sha256((directory/"index.mjs").read_bytes()).hexdigest()}))
    def definitions(self, **changes):
        runtime=Mock()
        config=dict(names={"api":"synthetic-api","worker-a":"synthetic-worker-a","worker-b":"synthetic-worker-b"},
                    image=modal.Image.debian_slim(),secrets=[],generation="a"*40,
                    public_url="https://synthetic.example.test",root=self.root,runtime_factory=lambda:runtime)
        config.update(changes)
        return define_slot_apps(**config),runtime

    def test_three_independent_unhydrated_apps_with_local_runtime_boundaries(self):
        apps,runtime=self.definitions()
        self.assertEqual(len({id(value.app) for value in apps.values()}),3)
        for slot,value in apps.items():
            self.assertIsNone(value.app.app_id)
            instance=value.server._get_user_cls()()
            value.server._get_user_cls().__dict__["enter"]._get_raw_f()(instance)
            call=runtime.start.call_args
            self.assertEqual(call.kwargs["services"],("api" if slot=="api" else "worker",))
            self.assertFalse(call.kwargs["migrate"])
            self.assertEqual(call.kwargs["extra_env"]["RAKAZO_SESSION_SLOT"],slot)
            self.assertEqual(call.kwargs["extra_env"]["DATA_DIR"],"/tmp/rakazo-data")
            value.server._get_user_cls().__dict__["exit"]._get_raw_f()(instance)
        self.assertEqual(runtime.start.call_count,3)
        self.assertEqual(runtime.stop.call_count,3)

    def test_rejects_shared_app_or_unknown_generation(self):
        with self.assertRaises(ValueError): self.definitions(names={"api":"same","worker-a":"same","worker-b":"same"})
        with self.assertRaises(ValueError): self.definitions(generation="unknown")
        with self.assertRaises(ValueError): self.definitions(public_url="http://synthetic.example.test")

    def test_sdk_registration_limits_and_no_resource_resolution(self):
        self.assertEqual(modal.__version__,"1.6.1")
        options=[]
        original=modal.App.server
        def record(app,**kwargs):
            options.append(kwargs)
            return original(app,**kwargs)
        with patch.object(modal.App,"server",record), patch.object(modal.Secret,"from_name",side_effect=AssertionError("cloud lookup")), patch.object(modal.Volume,"from_name",side_effect=AssertionError("cloud lookup")), patch.object(modal.App,"deploy",side_effect=AssertionError("deployment")):
            apps,_=self.definitions()
        self.assertEqual([x["max_containers"] for x in options],[2,1,1])
        self.assertEqual([x["min_containers"] for x in options],[1,1,1])
        self.assertEqual([x["unauthenticated"] for x in options],[True,False,False])
        self.assertTrue(all("volumes" not in x for x in options))
        self.assertTrue(all(x.app.app_id is None for x in apps.values()))

    def test_old_image_missing_or_wrong_manifest_never_constructs_runtime(self):
        directory=self.root / "apps" / "worker" / "dist"
        original=(directory/"build-manifest.json").read_text()
        for failure in ("missing","source","hash","protocol"):
            with self.subTest(failure=failure):
                manifest=json.loads(original)
                if failure=="missing": (directory/"build-manifest.json").unlink(missing_ok=True)
                else:
                    manifest[{"source":"sourceRevision","hash":"sha256","protocol":"sessionAdmissionProtocol"}[failure]]="wrong"
                    (directory/"build-manifest.json").write_text(json.dumps(manifest))
                apps,runtime=self.definitions()
                instance=apps["worker-a"].server._get_user_cls()()
                with self.assertRaises((ValueError,FileNotFoundError)):
                    apps["worker-a"].server._get_user_cls().__dict__["enter"]._get_raw_f()(instance)
                runtime.start.assert_not_called()
                (directory/"build-manifest.json").write_text(original)
