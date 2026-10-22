# Native Rakazo on Modal

This deployment runs the original Web preview server, API, worker and Pi runtime
in one initial Modal container. It requires an external PostgreSQL database and a
native sandbox provider. No Docker daemon or additional agent harness is used.

Use a new App, Secret and Volume dedicated to this product. The Modal workspace
provides account access and billing; unrelated applications are not modified.

The image caches dependency downloads before copying application source, using
[pnpm 9.15.0 fetch](https://github.com/pnpm/pnpm/blob/v9.15.0/pkg-manager/plugin-commands-installation/src/fetch.ts).
Its input layer includes the lockfile, root `package.json` (overrides and patch
configuration), `pnpm-workspace.yaml`, `.npmrc` and `patches/`. The full frozen
source is then copied as before, followed by `pnpm install --offline --frozen-lockfile`
and the existing generation, checks and build. Development and optional dependencies
remain included. Add any new pnpm configuration or hook files to the fetch input layer.

## Before deploying

- Use Node 24 and Modal 1.6.1 or newer. Check the workspace billing summary before
  allocating compute; free plan membership does not guarantee remaining credit.
- Point `DATABASE_URL` at a dedicated, empty database owned by the runtime role.
  Upstream migrations expect `public`; do not run them over an existing CRM.
- The image installs the public CA provided by Supabase's database settings and
  supplies it to Node. TLS verification stays enabled; no host trust settings change.
- The API/worker image includes Poppler for native PDF text reading and citation
  verification. It reads verified PDF bytes with fixed arguments; it does not
  enable agent shell/computer tools or OCR. Other host installations need
  `pdftotext` on the backend PATH to read PDF text.
- On Modal's IPv4 network, use Supabase's free Session pooler, with the qualified
  role name and the dedicated database. Verify `current_database()` and `LISTEN`
  before migrating; transaction pooling does not preserve the worker's sessions.
- Keep the existing native authentication and encryption keys stable in a private
  dotenv file. Set `SIGNUP_ALLOWLIST` to the owner allowed to claim this deployment.
- Supply `SANDBOX_PROVIDER=e2b` and a verified `E2B_API_KEY`. Confirm the sandbox
  account's available credit before the first real run.
- Retain `AGENT_RUNTIME=pi`, `WAKEUP_DRIVER=graphile`, `SECRET_STORE=encrypted`,
  `CLOUD_AGENT_PROVIDER=none`, `MCP_STDIO_ENABLED=false` and bounded DB pools.
- Do not include unused integration keys or credentials from another application.

Example commands, using a private dotenv file outside the checkout:

```sh
export MODAL_APP_NAME=rakazo-recruiting
export MODAL_SECRET_NAME=rakazo-recruiting-config
export MODAL_VOLUME_NAME=rakazo-recruiting-files
modal billing summary --json
modal secret create "$MODAL_SECRET_NAME" --from-dotenv /private/path/runtime.env
modal deploy --strategy recreate infra/modal/app.py
```

The entrypoint obtains its registered public URL from Modal and gives that same
origin to native authentication and Web/API configuration. It applies the unchanged
upstream migrations before starting the three services. The Volume is mounted at
`/data` for native artifacts and workspace checkpoints, with a final commit after
the services stop. One container avoids concurrent containers writing the same
native file store; scaling requires revisiting that storage boundary.

The server uses Modal's native `nonpreemptible=True` placement to prevent platform
preemption from interrupting the sole file-store writer. Modal charges 3× the
standard CPU and memory rates for this placement; the existing resource bounds
remain unchanged. Deployments and application failures can still require a restart.

## Platform-funded inference

Native onboarding and chat can use a deployment-supplied model without each user
connecting a model account. For direct OpenAI, set `PI_DEFAULT_PROVIDER=openai`
and keep `OPENAI_API_KEY` in the deployment Secret. `PI_DEFAULT_MODEL` can select
an explicitly supported native model; the OpenAI default is `gpt-6-luna` through
Pi's OpenAI Responses provider. These are the existing deployment configuration
fields; no user credential is created or copied.

API calls use the platform account's API billing, separately from ChatGPT plan
credits. Existing personal model connections and explicitly selected bot/routine
models remain personal; this configuration does not rewrite them. Keep the actual
caller identity and native Space isolation. Product recruiting-agent bootstrap
and platform service/task authorization must be verified separately before calling
new-user onboarding complete. Personal email/calendar connections also retain
their own ownership and authorization.

## Shared artifact storage

The native API and worker can use Supabase private object storage through the same
`ArtifactStore` interface. Configure all three server-only fields together:

- `ARTIFACT_STORAGE_URL`: the HTTPS project origin, without a path or query.
- `ARTIFACT_STORAGE_KEY`: the project server secret key (`sb_secret_…`), kept in
  the existing private deployment Secret. It is sent only as `apikey`.
- `ARTIFACT_STORAGE_BUCKET`: one existing private bucket name.

With all three fields absent, the existing local provider remains selected.
Partial or invalid remote configuration stops startup. Remote failures do not
fall back to local files, and this adapter does not create buckets or permissions.

Do not enable remote storage over an existing installation until all referenced
local artifact objects have been copied from `artifacts/<space>/<uuid>` to
`<space>/<uuid>` in the private bucket, preserving their storage keys and checking
actual bytes against each database row's length and SHA256. Quiesce writers for
the final inventory and cutover so no attachment is omitted. Switch API and worker
together; retain the verified old data. No such copy or cutover is performed by
this configuration change.

This only shares immutable artifact objects. Agent home checkpoints, pending OAuth
logins and credential-refresh coordination still require their own native-state
work before multiple application containers can be enabled safely. Keep the
single-writer deployment until those boundaries and failover are verified.

## Acceptance

An open port is only liveness. The deployment is accepted only after native owner
sign-in, successful Codex OAuth, a real Main/Sourcer Crew conversation with two
rounds, and persistence after reload and a controlled restart. Check that a public
test workspace file survives sandbox pause/replacement and container replacement.
Record the deployed revision, HTTPS URL, screenshots, pass/fail results, and usage.
Do not connect business integrations or claim this baseline proves their behavior.

## Shutdown check

All three services receive SIGTERM before sharing one eight-second exit deadline.
Remaining services are killed together and reaped before `Volume.commit()` runs;
commit and process-wait errors propagate. `exit_grace_period=10` is HTTP request
draining, followed by Modal's separate 30-second termination/exit-hook window
([native lifecycle](https://modal.com/docs/guide/servers#container-lifecycle)).
This preserves more of that window for the native commit; it does not guarantee
commit completion after a hard kill or make per-checkpoint persistence atomic.

Run this offline standard-library check from the repository root. It executes the
actual shutdown method with three simulated lagging processes, never a real
process or Volume:

```sh
python3 - <<'PY'
import ast, contextlib, signal, subprocess
from pathlib import Path
from types import SimpleNamespace

module = ast.parse(Path("infra/modal/app.py").read_text())
server = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == "Recruiting")
stop = next(n for n in server.body if isinstance(n, ast.FunctionDef) and n.name == "stop")
stop.decorator_list = []
for failure in (None, "reap", "commit"):
    elapsed, events = [0.0], []
    class Process:
        def __init__(self, pid): self.pid, self.dead = pid, False
        def poll(self): return 0 if self.dead else None
        def wait(self, timeout=None):
            if not self.dead:
                elapsed[0] += timeout
                raise subprocess.TimeoutExpired("simulated", timeout)
            if failure == "reap": raise RuntimeError("reap")
            events.append(("reaped", self.pid))
    processes = [Process(pid) for pid in (1, 2, 3)]
    def kill(pid, sig):
        events.append((sig, pid))
        if sig == signal.SIGKILL: processes[pid - 1].dead = True
    def commit():
        assert all(("reaped", p.pid) in events for p in processes)
        events.append(("commit",))
        if failure == "commit": raise RuntimeError("commit")
    scope = dict(contextlib=contextlib, signal=signal, subprocess=subprocess,
                 time=SimpleNamespace(monotonic=lambda: elapsed[0]),
                 os=SimpleNamespace(killpg=kill), files=SimpleNamespace(commit=commit))
    exec(compile(ast.Module(body=[stop], type_ignores=[]), "shutdown-check", "exec"), scope)
    try:
        scope["stop"](SimpleNamespace(processes=processes, stopping=SimpleNamespace(set=lambda: None)))
        assert failure is None
    except RuntimeError as error:
        assert str(error) == failure
    assert elapsed[0] <= 8, elapsed
    assert [sig for sig, *_ in events[:3]] == [signal.SIGTERM] * 3
    if failure == "reap": assert ("commit",) not in events
print("shutdown shared deadline, stopped-before-commit and error propagation: passed")
PY
```
