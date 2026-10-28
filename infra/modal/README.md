# Native Rakazo on Modal

For the proposed PR/staging/promotion path, see
[the release runbook](../../docs/development/pr-driven-releases.md).
Its activation requires separate owner approval; this file is not a release authorization.
Deployments now require the named Volume to exist; they never create it implicitly.

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

Compute is pinned to `us-west`; the existing routing region and public URL stay
unchanged so native sign-in and authorized connector callbacks keep their current
origin. This moves compute, not the routing proxy or the Supabase database. The
existing Volume is reused and remains the only native file store. Region selection
adds Modal's published compute multiplier, within the existing usage budget; it
does not require another plan. Keep the single-writer bounds and use the immediately
previous frozen product release for rollback, not an older core-package baseline.

## Custom domain

Modal Servers are reachable only on their Modal URL. To serve the product on your own
domain, put a reverse proxy in front that forwards to that URL with the Modal Host header,
such as the Cloudflare Worker in `infra/cloudflare/custom-domain-proxy.js` (set its
`UPSTREAM_ORIGIN` variable to the Modal URL and attach the domain as a Worker custom domain).

Once the domain serves the product, add `RAKAZO_PUBLIC_ORIGIN=https://<domain>` to the
deployment Secret and redeploy. Sign-in, OAuth callbacks and links then use that origin,
and the Web server keeps accepting the Modal host the proxy forwards to. Register
`https://<domain>/api/auth/callback/oidc` with the OIDC provider when product SSO is
configured. Sign-in on the bare Modal URL stops working after the switch; share the new URL.

## Cold start

A deployment replaces the only container, so the site is unavailable from the old
container's exit until the new one listens. The image therefore precompiles the API
and worker entrypoints (`scripts/bundle-server.mjs`): workspace packages are bundled
into `apps/{api,worker}/dist/index.mjs` and npm dependencies stay external, pinned to
the files each package resolves in the image. Startup runs migrations with the
package's Prisma binary and then plain JavaScript, not tsx. The CPU limit lets
startup burst above the idle request; it does not add containers. A rolling deploy
still needs the shared-store and writer-lock work below before `max_containers` can
rise above one.

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

## Product sign-in and first-party MCP

An explicitly trusted MCP service can consume the signed-in product user's native
OIDC Account without a second service login. Configure `FIRST_PARTY_MCP_URL` with
the exact HTTPS endpoint, alongside the existing `OIDC_*` product sign-in fields.
API and worker use the same configuration and auth secret. The URL cannot include
credentials, query parameters or a fragment; unrelated endpoints retain their own
authentication. Existing personal MCP connections take precedence.

The native recruiting defaults install the configured CRM connection and scoped
tool assignments for new private workspaces. Managed upgrades preserve private
changes and revoked assignments. Installing a tool is not a CRM membership grant:
the service still authorizes the actual user's organization and row permissions.
Tokens remain in the original encrypted OIDC Account; they are read/refreshed under
its database row lock, never copied into an MCP secret or sent to the browser.
The upstream token HTTP endpoints are closed; server-side native refresh remains
available. Verify real OIDC-to-service calls, concurrent refresh and new-user
isolation separately before calling this integration accepted.

## Shared artifact storage

The native API and worker can use Supabase private object storage through the same
`ArtifactStore` interface. Configure all three server-only fields together:

- `ARTIFACT_STORAGE_URL`: the HTTPS project origin, without a path or query.
- `ARTIFACT_STORAGE_KEY`: the project server secret key (`sb_secret_…`), kept in
  the existing private deployment Secret. It is sent only as `apikey`.
- `ARTIFACT_STORAGE_BUCKET`: one existing private bucket name.

With all three fields absent, the existing local provider remains selected.
Partial or invalid remote configuration stops startup. The adapter does not create
buckets or permissions.

Enabling remote storage over an existing installation needs no downtime: new files
go to the bucket, and files saved on the volume before stay readable from it. Then
copy them inside the running container with `pnpm --filter @rakazo/api artifacts:copy`.
It uploads `artifacts/<space>/<uuid>` to `<space>/<uuid>`, reads each object back and
compares SHA-256, and can be rerun. The volume copies are kept.

The same bucket also holds computer homes. Each home write publishes one gzipped
snapshot under `agent-homes/<key>/<revision>` and moves `agent-homes/<key>/current`
to it; before a read, a container whose local copy has an older revision downloads
the current one. A home already on the volume is published the first time it is
read, and `artifacts:copy` publishes every remaining one.

Pending in-app model subscription sign-ins (`PiOAuthLogins`) are still held in
process memory, so a sign-in must finish on the container that started it. MCP
OAuth and credential refresh already coordinate through the database. Keep the
single-writer deployment until sign-in and failover are verified.

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
