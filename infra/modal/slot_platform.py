"""Pinned SDK control adapter. No authentication/network/cloud actions occur on import."""
import argparse
import asyncio
import json
import subprocess
import sys
import modal
from modal.client import _Client
from modal.cli.import_refs import import_app
from modal_proto import api_pb2
from infra.modal.slot_services import checked_slot_definition


def run(argv):
    result = subprocess.run([sys.executable, "-m", "modal", *argv], check=True, capture_output=True, text=True)
    return result.stdout


async def bind_app(client, args):
    response = await client._stub.AppGetByDeploymentName(api_pb2.AppGetByDeploymentNameRequest(
        name=args.app_name, environment_name=args.environment))
    if response.app_id != args.app_id:
        raise ValueError("App name, environment and ID do not identify the same deployment")


async def bind_container(client, args):
    if not args.container_id: raise ValueError("explicit container ID required")
    response = await client._stub.TaskGetInfo(api_pb2.TaskGetInfoRequest(task_id=args.container_id))
    if response.app_id != args.app_id or response.info.id != args.container_id:
        raise ValueError("container does not belong to the selected App")
    return response.info


def health(args):
    script="import json,urllib.request;print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:3101/drain',timeout=3))))"
    value=json.loads(run(["container","exec",args.container_id,"python","-c",script]))
    identity=value.get("identity",{})
    if identity.get("service") != args.slot or not identity.get("instanceId") or not identity.get("generation"):
        raise ValueError("worker health is not bound to the selected slot")
    return value


def deployment(args):
    if not args.entry or "::" not in args.entry: raise ValueError("explicit single-slot App reference required")
    app=import_app(args.entry)
    definition=checked_slot_definition(app)
    if definition.slot != args.slot or definition.generation != args.generation or app.name != args.app_name:
        raise ValueError("deployment entry does not match selected slot/name/generation")
    return app


async def perform(args):
    if args.slot not in ("worker-a","worker-b") or not args.environment or args.timeout<=0:
        raise ValueError("invalid worker slot/environment/deadline")
    if modal.__version__ != "1.6.1": raise RuntimeError("Slot control requires reviewed Modal SDK 1.6.1")
    client=await _Client.from_env()
    await bind_app(client,args)
    if args.action in ("validate","deploy"):
        app=deployment(args)
        if args.action == "deploy":
            # Same verified in-memory App, not a re-imported or independently named CLI target.
            await bind_app(client,args)
            await app.deploy.aio(name=args.app_name,environment_name=args.environment,strategy="recreate",client=client)
        return None
    if args.action == "list":
        response=await client._stub.TaskList(api_pb2.TaskListRequest(app_id=args.app_id,environment_name=args.environment))
        if any(task.app_id != args.app_id for task in response.tasks): raise ValueError("mixed App container inventory")
        return [task.task_id for task in response.tasks]
    info=await bind_container(client,args)
    if args.action == "finished": return {"finished":bool(info.finished_at)}
    if info.finished_at: raise ValueError("container already finished")
    observed=health(args)
    if args.action == "health": return observed
    identity=observed["identity"]
    if identity["instanceId"] != args.expected_instance or identity["generation"] != args.generation:
        raise ValueError("container instance/generation changed before mutation")
    await bind_app(client,args)
    info=await bind_container(client,args)
    if info.finished_at: raise ValueError("container finished before mutation")
    if args.action == "drain":
        run(["container","exec",args.container_id,"python","-m","infra.modal.drain_worker","--port","3101","--timeout",str(args.timeout)])
    else:
        if observed.get("state") != "drained" or observed.get("ok") is not True:
            raise ValueError("refusing to stop an undrained worker")
        await client._stub.ContainerStop(api_pb2.ContainerStopRequest(task_id=args.container_id,graceful=False))
    return None


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=["validate","list","finished","health","drain","stop","deploy"])
    for name in ("app-id","app-name","slot","environment"): parser.add_argument("--"+name,required=True)
    parser.add_argument("--container-id")
    parser.add_argument("--entry")
    parser.add_argument("--generation")
    parser.add_argument("--expected-instance")
    parser.add_argument("--timeout",type=int,default=300)
    args=parser.parse_args()
    if args.slot not in ("worker-a","worker-b") or not args.environment or args.timeout<=0: parser.error("invalid worker slot/environment/deadline")
    print("RAKAZO_SLOT_RESULT " + json.dumps(asyncio.run(perform(args))))


if __name__ == "__main__": main()
