"""Run inside ONE selected worker container before replacing it. No Modal/cloud API calls.

A timeout fails the release preflight. It never cancels a task or kills the worker.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import time
import urllib.request


def wait_for_drain(pid, port, timeout, *, send_signal=os.kill, read=None, clock=time.monotonic, sleep=time.sleep):
    def read_status():
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/drain", timeout=2) as response:
            return json.load(response)
    read = read or read_status
    send_signal(pid, signal.SIGUSR2)
    deadline = clock() + timeout
    while True:
        status = read()
        if status.get("state") == "drained" and status.get("ok") is True:
            return
        if status.get("state") == "failed":
            raise RuntimeError("Worker drain failed; replacement prohibited")
        if clock() >= deadline:
            raise TimeoutError("Worker still draining; postpone replacement without canceling jobs")
        sleep(min(0.25, max(0, deadline - clock())))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("timeout must be positive")
    wait_for_drain(int(Path("/tmp/rakazo-worker.pid").read_text()), args.port, args.timeout)
    print("worker drained; no active jobs remain")
