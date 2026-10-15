# Native Rakazo on Modal

This deployment runs the original Web preview server, API, worker and Pi runtime
in one initial Modal container. It requires an external PostgreSQL database and a
native sandbox provider. No Docker daemon or additional agent harness is used.

Use a new App, Secret and Volume dedicated to this product. The Modal workspace
provides account access and billing; unrelated applications are not modified.

## Before deploying

- Use Node 24 and Modal 1.6.1 or newer. Check the workspace billing summary before
  allocating compute; free plan membership does not guarantee remaining credit.
- Point `DATABASE_URL` at a dedicated, empty database owned by the runtime role.
  Upstream migrations expect `public`; do not run them over an existing CRM.
- The image installs the public CA provided by Supabase's database settings and
  supplies it to Node. TLS verification stays enabled; no host trust settings change.
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

## Acceptance

An open port is only liveness. The deployment is accepted only after native owner
sign-in, successful Codex OAuth, a real Main/Sourcer Crew conversation with two
rounds, and persistence after reload and a controlled restart. Check that a public
test workspace file survives sandbox pause/replacement and container replacement.
Record the deployed revision, HTTPS URL, screenshots, pass/fail results, and usage.
Do not connect business integrations or claim this baseline proves their behavior.
