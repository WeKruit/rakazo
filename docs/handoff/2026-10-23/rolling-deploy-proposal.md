# Rolling deploy with a writer lock (proposal, no PR yet)

Status 2026-10-23 15:20 UTC. Outage per deploy is now 26 s, down from a 65 s median.
PR #48 (live in 8aec3a5c) did that. What remains is the time to acquire the new
container plus the old container's drain, because `--strategy recreate` with
`max_containers=1` serializes them. This proposal overlaps that work with the old
container still serving. It keeps the rule that only one container ever runs the
API and worker.

Target: about 6–10 s with no API, and the web shell stays up throughout. Getting
to 0 s needs the shared-store work at the end.

## What must stay single-writer (checked in code)

| State | Where | Safe with two containers? |
|---|---|---|
| Postgres rows, Graphile jobs | `DATABASE_URL` | Yes. Graphile locks jobs per worker. |
| Agent home checkpoints | `LocalAgentHomeStore(DATA_DIR)` in API and worker | No. Both write the same Modal Volume. |
| Local artifacts, Pi sessions, push tokens | `DATA_DIR` | No (unless remote artifact storage is on). |
| Pending OAuth logins, credential-refresh kicks | in-memory Maps in `mcp-oauth.ts` and `pi-oauth.ts` | Lost on restart, same as today. |
| Modal Volume view | mounted snapshot, `files.commit()` at exit | The new container must `reload()` after the old one commits. |

So the lock must cover the API and worker processes and the volume handoff. It
does not need to cover the web preview server, which is stateless (static files
plus a proxy to 127.0.0.1:3100).

## Design

1. **App config:** `max_containers=2` (Modal's own docs say 1 prevents a graceful
   replacement on rolling deploy). Keep `min_containers=1` and `max_concurrency=128`.
   Deploy with the default rolling strategy instead of `--strategy recreate`.
2. **New container start (`@modal.enter`):** start only `vite preview` on :8000, so
   Modal marks the container ready and routes traffic to it. Then start a writer-lock
   holder in a background thread and return.
3. **Writer-lock holder:** a small Node script (pg is already in the image). It opens one
   dedicated session-pooler connection and blocks on
   `pg_advisory_lock(1380019075, 2)`. That reuses the namespace in
   `createPostgresReconciliationLeadership`, with a new lock id 2 so the reconciler's
   lock 1 is untouched. It prints `acquired` and keeps the session open for the
   container's life. It exits if the connection errors.
   - What we reuse from `createPostgresReconciliationLeadership`: the namespace
     constant, the two-key lock form, and the rule "never return a connection with
     an uncertain lock to the pool; destroy it".
   - What it lacks and the deploy lock needs: (a) a blocking wait (it only tries
     every 30 s); (b) lifetime outside the worker process, because the lock must be
     held before the API and worker start; (c) treating a lost lock as fatal. Today
     the reconciler just retries; the deploy lock must stop the container.
     Recommendation: do not stretch that function. Add a separate holder next to
     `infra/modal/app.py` that shares only the constants, exported from adapters.
4. **After the lock is acquired:** `files.reload()`, then `prisma migrate deploy`
   (old code is already stopped, so migrations keep today's ordering), then start
   API and worker. With #48 this is about 3–5 s.
5. **Old container exit (`@modal.exit`):** stop services, reap, `files.commit()`, then
   exit the lock holder. Releasing the lock last is what makes step 4's reload see
   the committed files.
6. **Fencing:** the existing supervisor thread already SIGTERMs the container when any
   child dies. Adding the lock holder as a child means losing the DB session, and so
   the lock, takes the container down within about 2 s.
7. **`exit_grace_period` 10 → 2 s:** SSE streams never finish, so the 10 s grace
   mostly waits for nothing. Long requests are chat sends that enqueue jobs and return.

Timeline: deploy → new container acquired and web ready while old still serves →
traffic moves to new (static UI loads; API calls get 502/503, which the #34 client
retry covers) → old drains 2 s and stops (~3 s) → new gets lock, reloads, migrates,
starts API (~5 s). Expected API gap: 6–10 s.

## Risks and how to check them before shipping

1. **Autoscaler adds a second container under load** (max 2). It would serve the web
   UI with no API, waiting on the lock forever. Mitigations: keep `max_concurrency=128`
   and leave `target_concurrency` unset. A follower that waits more than 5 min while
   the leader runs the same `RAKAZO_GIT_SHA` exits. Verify Modal's scale-up behavior
   on a throwaway app first.
2. **Readiness semantics:** we assume Modal marks the container ready when :8000
   listens even if `@modal.enter` has returned with work still running in a
   background thread. Verify on a throwaway app.
3. **Split brain on a pooler blip:** if the old session drops, the lock frees while
   the old processes may still be writing for up to ~2 s before fencing kills them.
   Today's recreate has no such window. True fencing needs a token checked on every
   volume write. That is out of scope; accept or reject explicitly.
4. **Volume consistency:** if the old container is hard-killed before `commit()`, the new
   one reloads stale files. That risk exists today too. Commit before releasing the
   lock, and never the other way round.
5. **Migrations:** unchanged ordering (after the old one stops). Any future migration
   that must run before traffic still blocks API start by its own duration.
6. **Deploy script change:** dropping `--strategy recreate` is a release-script change.
   It needs the user's go-ahead and should land after the Instantly test.
7. **Rollback:** redeploy with `--strategy recreate` and `max_containers=1`. No data or
   schema changes are involved.

## Cost

A second container exists only during the handoff (~1–2 min at 0.125 CPU reserved,
3× nonpreemptible rate). There are no new Modal resources or Secrets, and no schema
change.

## Zero downtime (later)

Running the API and worker in both containers at once needs agent homes and artifacts
off the local volume (the remote `ArtifactStore` already exists; homes still need it),
plus OAuth pending state in Postgres. Then the lock only gates the worker's run
executor, and the API can overlap. That is the "shared-store" work the README already
names.
