import asyncio
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
import modal
from modal_proto import api_pb2
from infra.modal.slot_services import define_slot_apps
from infra.modal.slot_platform import perform


class SlotPlatformTests(unittest.TestCase):
    def setup_case(self, action="stop"):
        args=SimpleNamespace(action=action,app_id="ap-synthetic-a",app_name="synthetic-a",slot="worker-a",environment="synthetic",container_id="ta-synthetic-a",entry="synthetic.py::worker_a_app",generation="a"*40,expected_instance="instance-a",timeout=5)
        stub=SimpleNamespace(AppGetByDeploymentName=AsyncMock(return_value=api_pb2.AppGetByDeploymentNameResponse(app_id=args.app_id)),
            TaskGetInfo=AsyncMock(return_value=api_pb2.TaskGetInfoResponse(app_id=args.app_id,info=api_pb2.TaskInfo(id=args.container_id))),
            ContainerStop=AsyncMock(),TaskList=AsyncMock(return_value=api_pb2.TaskListResponse()))
        return args,SimpleNamespace(_stub=stub)

    def invoke(self,args,client,**patches):
        with patch("infra.modal.slot_platform._Client.from_env",AsyncMock(return_value=client)), patch("infra.modal.slot_platform.health",return_value=patches.get("health",{"ok":True,"state":"drained","identity":{"service":"worker-a","instanceId":"instance-a","generation":"a"*40}})):
            return asyncio.run(perform(args))

    def test_pinned_proto_has_required_identity_and_completion_fields(self):
        self.assertEqual(modal.__version__,"1.6.1")
        self.assertIn("app_id",api_pb2.TaskGetInfoResponse.DESCRIPTOR.fields_by_name)
        self.assertTrue({"id","finished_at"} <= set(api_pb2.TaskInfo.DESCRIPTOR.fields_by_name))
        self.assertTrue({"app_id","environment_name","name"} - {"app_id"} <= set(api_pb2.AppGetByDeploymentNameRequest.DESCRIPTOR.fields_by_name))

    def test_wrong_app_id_container_or_generation_never_stops(self):
        for failure in ("name","container","instance","generation","undrained"):
            with self.subTest(failure=failure):
                args,client=self.setup_case()
                health={"ok":True,"state":"drained","identity":{"service":"worker-a","instanceId":"instance-a","generation":"a"*40}}
                if failure=="name": client._stub.AppGetByDeploymentName.return_value.app_id="other"
                if failure=="container": client._stub.TaskGetInfo.return_value.app_id="other"
                if failure=="instance": health["identity"]["instanceId"]="other"
                if failure=="generation": health["identity"]["generation"]="b"*40
                if failure=="undrained": health["state"]="draining"
                with self.assertRaises(ValueError): self.invoke(args,client,health=health)
                client._stub.ContainerStop.assert_not_awaited()

    def test_finished_requires_matching_original_container_identity(self):
        args,client=self.setup_case("finished")
        client._stub.TaskGetInfo.return_value.info.finished_at=123
        self.assertEqual(self.invoke(args,client),{"finished":True})
        client._stub.TaskGetInfo.return_value.info.id="other"
        with self.assertRaises(ValueError): self.invoke(args,client)

    def test_only_bound_drained_instance_can_be_stopped(self):
        args,client=self.setup_case()
        self.invoke(args,client)
        request=client._stub.ContainerStop.await_args.args[0]
        self.assertEqual(request.task_id,args.container_id)
        self.assertFalse(request.graceful)

    def test_entry_must_be_same_guarded_slot_app_and_generation(self):
        apps=define_slot_apps(names={"api":"synthetic-api","worker-a":"synthetic-a","worker-b":"synthetic-b"},image=modal.Image.debian_slim(),secrets=[],generation="a"*40,public_url="https://synthetic.example.test",root=Path("/synthetic"))
        args,client=self.setup_case("validate")
        with patch("infra.modal.slot_platform.import_app",return_value=apps["worker-a"].app):
            self.invoke(args,client)
        for wrong in (apps["worker-b"].app,modal.App("synthetic-a")):
            with patch("infra.modal.slot_platform.import_app",return_value=wrong):
                with self.assertRaises(ValueError): self.invoke(args,client)
        args.generation="b"*40
        with patch("infra.modal.slot_platform.import_app",return_value=apps["worker-a"].app):
            with self.assertRaises(ValueError): self.invoke(args,client)
