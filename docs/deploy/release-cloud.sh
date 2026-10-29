#!/usr/bin/env bash
# Release script for rakazo production (copied from the release session; cloud copy of the Mac release-main.sh) for rakazo production (Modal app wekruit-recruiting).
#
#   release-cloud.sh <SHA> check    # read-only: live revision, migration/infra diff, active-run gate
#   release-cloud.sh <SHA> deploy   # check + unit tests (red blocks) + modal deploy --strategy recreate + readiness/revision proof
#   release-cloud.sh <SHA> test     # unit tests only, no prod access; run while prod is busy so the deploy skips them
#   RELEASE_ROLLBACK=1 ... deploy   # emergency rollback to a tested SHA: works while live /ready is broken, no gap wait
#
# Rules kept from the runbook: main only, one release at a time, recreate only, no new Modal
# resources or Secrets, never prints secret values. Needs MODAL_TOKEN_ID/MODAL_TOKEN_SECRET in env.
# Prints "RELEASE OK <short>" only after /ready serves the new revision on a single container.
set -euo pipefail

SHA_IN=${1:?usage: release-cloud.sh <SHA> check|deploy}
MODE=${2:-check}
REPO=${RAKAZO_REPO:-/home/user/rakazo}
WORK=${RELEASE_WORK:-$HOME/rakazo-releases}
# Direct Modal URL of the app (not the custom domain); set it in the release environment.
URL=${RAKAZO_URL:?set RAKAZO_URL to the Modal app URL}
export MODAL_APP_NAME=wekruit-recruiting MODAL_SECRET_NAME=wekruit-recruiting-config \
  MODAL_VOLUME_NAME=wekruit-recruiting-files MODAL_ENVIRONMENT=main

die() { echo "RELEASE CHECK FAILED: $*" >&2; exit 1; }
log() { echo "$(date -u +%H:%M:%S) $*"; }

[ -n "${MODAL_TOKEN_ID:-}" ] && [ -n "${MODAL_TOKEN_SECRET:-}" ] || die "Modal token env vars missing"
# The session proxy needs python-socks; plain `pip install modal` cannot connect.
python3 -c 'import modal, python_socks' 2>/dev/null || pip install -q 'modal[api-proxy-support]==1.6.2' 2>/dev/null
command -v modal >/dev/null || die "modal CLI missing"

live_revision() { curl -sS -o /dev/null -D - --max-time 15 "$URL/ready" | tr -d '\r' | awk 'tolower($1)=="x-rakazo-revision:"{print $2}'; }
containers() { modal container list --json | python3 -c 'import json,sys; print(sum(c["app_name"]==sys.argv[1] for c in json.load(sys.stdin)))' "$MODAL_APP_NAME"; }
# Read-only SQL inside the live container (DATABASE_URL never leaves it).
db_query() {
  local id; id=$(modal container list --json | python3 -c 'import json,sys; print(next(c["container_id"] for c in json.load(sys.stdin) if c["app_name"]==sys.argv[1]))' "$MODAL_APP_NAME")
  # exec exits 0 even when node fails, so only a JSON array counts as an answer.
  local out; out=$(modal container exec "$id" -- node --no-warnings --input-type=module -e "import {createRequire} from 'module'; const {Client}=createRequire('/app/packages/db/package.json')('pg'); const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect(); await c.query('begin read only'); const r=await c.query(process.argv[1]); console.log(JSON.stringify(r.rows)); await c.query('rollback'); await c.end();" "$1" 2>&1) || true
  case "$out" in \[*) echo "$out" ;; *) echo "db query failed: $(echo "$out" | grep -m1 -oE '\(E[A-Z]+\)[^\n]*|error: .*' | cut -c1-160)" >&2; return 1 ;; esac
}
ACTIVE_SQL="select r.id, r.status, b.name bot, g.name grp, r.\"updatedAt\" from runs r join bots b on b.id=r.\"botId\" join threads t on t.id=r.\"threadId\" left join chat_groups g on g.id=t.\"groupId\" where r.status not in ('completed','failed','cancelled','canceled','interrupted','waiting_input') and r.\"updatedAt\" > now() - interval '30 minutes' order by r.\"updatedAt\" desc"
LEDGER_SQL="select count(*)::int n, max(migration_name) latest from _prisma_migrations where finished_at is not null and rolled_back_at is null"

# 1) Resolve the SHA on main.
git -C "$REPO" fetch -q origin main
SHA=$(git -C "$REPO" rev-parse --verify "$SHA_IN^{commit}") || die "unknown SHA $SHA_IN"
git -C "$REPO" merge-base --is-ancestor "$SHA" origin/main || die "$SHA is not on origin/main"
SHORT=${SHA:0:8}
run_tests() {
# Red tests block the deploy (CI stays off). Same tests as the server ships: packages, api, worker, web.
# A SHA that already passed here is not tested again.
local TESTED="$WORK/tested/$SHA"
if [ ! -f "$TESTED" ]; then
  local TDIR="$WORK/test/$SHA"; rm -rf "$TDIR"; mkdir -p "$TDIR" "$WORK/tested"
  git -C "$REPO" archive --format=tar "$SHA" | tar -x -C "$TDIR"
  log "testing $SHORT (install + unit tests, ~7 min)"
  ( cd "$TDIR" \
    && pnpm install --frozen-lockfile --store-dir "$WORK/pnpm-store" --config.engine-strict=false >"$WORK/test-$SHORT.log" 2>&1 \
    && (cd packages/db && npx prisma generate) >>"$WORK/test-$SHORT.log" 2>&1 \
    && pnpm exec vitest run packages apps/api apps/worker apps/web >>"$WORK/test-$SHORT.log" 2>&1 ) \
    || { grep -E "FAIL|Tests  " "$WORK/test-$SHORT.log" | head -20 >&2; die "unit tests failed for $SHORT (log: $WORK/test-$SHORT.log)"; }
  grep -E "Tests  " "$WORK/test-$SHORT.log" | tail -1
  touch "$TESTED"; rm -rf "$TDIR"
fi
}
[ "$MODE" = test ] && { run_tests; log "TESTS OK $SHORT (nothing deployed)"; exit 0; }

# 2) Live state and what changes.
LIVE=$(live_revision)
if [ -z "$LIVE" ]; then [ "${RELEASE_ROLLBACK:-}" = 1 ] || die "live /ready did not answer with a revision (RELEASE_ROLLBACK=1 to roll back anyway)"; LIVE=unknown; fi
log "live ${LIVE:0:8} -> target $SHORT ($(git -C "$REPO" rev-list --count "$LIVE..$SHA" 2>/dev/null || echo '?') commits)"
git -C "$REPO" diff --name-status "$LIVE" "$SHA" -- packages/db/prisma/migrations infra/modal 2>/dev/null | sed 's/^/  /' || true
N=$(containers); log "containers running: $N"
[ "$N" = 1 ] || die "expected exactly 1 container (another deploy may be in progress)"

# 3) Active-run gate: recreate kills in-flight runs. waiting_input cards survive recreate.
ACTIVE=$(db_query "$ACTIVE_SQL") || ACTIVE="unknown"
log "active runs (30 min): $ACTIVE"
LEDGER_BEFORE=$(db_query "$LEDGER_SQL") || LEDGER_BEFORE="unknown (db query failed)"
log "ledger before: $LEDGER_BEFORE"
[ "$MODE" = check ] && { log "CHECK DONE $SHORT (nothing deployed)"; exit 0; }
[ "$MODE" = deploy ] || die "mode must be check, test or deploy"
run_tests
# Wait for a gap with no running work (waiting_input is excluded above); give up after RELEASE_GAP_WAIT s.
gap_deadline=$(( $(date +%s) + ${RELEASE_GAP_WAIT:-1800} ))
while [ "$ACTIVE" != "[]" ] && [ "${RELEASE_ALLOW_ACTIVE:-}" != "$SHORT" ] && [ "${RELEASE_ROLLBACK:-}" != 1 ]; do
  [ "$(date +%s)" -lt "$gap_deadline" ] || die "no gap without active runs; rerun later or with RELEASE_ALLOW_ACTIVE=$SHORT after the coordinator says go"
  sleep 15; ACTIVE=$(db_query "$ACTIVE_SQL") || ACTIVE="unknown"
  log "waiting for gap, active: $([ "$ACTIVE" = unknown ] && echo unknown || echo "$ACTIVE" | grep -o '"status"' | wc -l)"
done

# 4) One release at a time on this machine; exact-SHA archive with the revision marker.
mkdir -p "$WORK"; exec 9>"$WORK/.lock"; flock -n 9 || die "another release is running here"
DIR="$WORK/releases/$SHA"; rm -rf "$DIR"; mkdir -p "$DIR"
git -C "$REPO" archive --format=tar "$SHA" | tar -x -C "$DIR"
echo "$SHA" > "$DIR/.wekruit-source-revision"

# 5) Deploy, sampling public /health every 2 s to measure the outage window.
( while sleep 2; do printf '%s %s\n' "$(date +%s)" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/health")"; done ) > "$WORK/health-$SHORT.log" &
PROBE=$!; trap 'kill $PROBE 2>/dev/null || true' EXIT
log "deploying $SHORT (recreate)"
(cd "$DIR" && modal deploy --strategy recreate infra/modal/app.py) || die "modal deploy failed for $SHORT"

# 6) Proof: the new revision serves /ready, and the smoke check passes on both hosts within 60 s.
#    Otherwise redeploy the previous build automatically (its release folder is kept here).
rollback() {
  local prev="$WORK/releases/$LIVE"
  [ "$LIVE" != unknown ] && [ -d "$prev" ] || die "$1; NO AUTO-ROLLBACK (no local build of previous ${LIVE:0:8})"
  log "ROLLING BACK to ${LIVE:0:8}: $1"
  (cd "$prev" && modal deploy --strategy recreate infra/modal/app.py) || die "$1; ROLLBACK DEPLOY FAILED"
  for _ in $(seq 1 60); do [ "$(live_revision)" = "$LIVE" ] && break; sleep 3; done
  echo "RELEASE ROLLED BACK $SHORT -> ${LIVE:0:8} (live now: $(live_revision)): $1"; exit 1
}
deadline=$(( $(date +%s) + 120 ))
until [ "$(live_revision)" = "$SHA" ]; do
  [ "$(date +%s)" -lt "$deadline" ] || rollback "/ready did not serve $SHORT within 120 s"
  sleep 3
done
if [ -f "$DIR/infra/acceptance/smoke.mjs" ]; then
  RAKAZO_URL="$URL" RAKAZO_ORIGIN="${RAKAZO_ORIGIN:-https://headhunter.wekruit.com}" RAKAZO_EXPECT_SHA="$SHA" \
    node "$DIR/infra/acceptance/smoke.mjs" --wait 60 > "$WORK/smoke-$SHORT.log" 2>&1 \
    || { tail -15 "$WORK/smoke-$SHORT.log"; rollback "smoke check failed (log: $WORK/smoke-$SHORT.log)"; }
  log "smoke ok: $(tail -1 "$WORK/smoke-$SHORT.log")"
else
  for p in / /ready /health; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${RAKAZO_ORIGIN:-https://headhunter.wekruit.com}$p")
    [ "$code" = 200 ] || rollback "custom domain $p returned $code"
  done
fi
for _ in $(seq 1 40); do [ "$(containers)" = 1 ] && break; sleep 3; done
[ "$(containers)" = 1 ] || die "more than one container after deploy"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/health")" = 200 ] || die "/health not 200"
LEDGER_AFTER=$(db_query "$LEDGER_SQL") || LEDGER_AFTER="unknown (db query failed)"
kill $PROBE 2>/dev/null || true
DOWN=$(awk '$2!="200"{n++} END{print n*2+0}' "$WORK/health-$SHORT.log")
log "ledger after: $LEDGER_AFTER"
echo "RELEASE OK $SHORT live=$SHA previous=$LIVE health_non200≈${DOWN}s"
