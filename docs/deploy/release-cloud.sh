#!/usr/bin/env bash
# Release script for rakazo production (copied from the release session; cloud copy of the Mac release-main.sh) for rakazo production (Modal app wekruit-recruiting).
#
#   release-cloud.sh <SHA> check    # read-only: live revision, migration/infra diff, active-run gate
#   release-cloud.sh <SHA> deploy   # check + unit tests (red blocks) + modal deploy --strategy recreate + readiness/revision proof
#   release-cloud.sh <SHA> test     # unit tests only, no prod access; run while prod is busy so the deploy skips them
#   release-cloud.sh <SHA> prebuild # build the Modal image for SHA only, nothing deployed
#   release-cloud.sh main watch     # keep running: test and prebuild each new origin/main head as it lands (background)
#   release-cloud.sh <branch> premerge # unit tests on main merged with the branch, before it is merged;
#                                      # a pass is reused when the real merge has the same code
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

# Build the Modal image from an exact release folder, so a later deploy of the same folder reuses
# the cached image instead of building it. Uses a short-lived app with no functions;
# RELEASE_PREBUILD=0 turns it off.
prebuild_image() {
  (cd "$1" && python3 -c '
import importlib.util, modal
spec = importlib.util.spec_from_file_location("release_app", "infra/modal/app.py")
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)
builder = modal.App(release.APP_NAME + "-prebuild")
with modal.enable_output(), builder.run():
    release.image.build(builder)
')
}

# Pre-test each new main head as soon as it lands, so a deploy finds its tests already done.
# A head that failed is not retried here; deploy mode tests it again.
if [ "$MODE" = watch ]; then
  mkdir -p "$WORK/failed"
  while :; do
    git -C "$REPO" fetch -q origin main || true
    head=$(git -C "$REPO" rev-parse origin/main)
    if [ ! -f "$WORK/tested/$head" ] && [ ! -f "$WORK/failed/$head" ]; then
      [ "${RELEASE_PREBUILD:-1}" = 1 ] && [ ! -f "$WORK/prebuilt/$head" ] && bash "$0" "$head" prebuild &
      bash "$0" "$head" test || touch "$WORK/failed/$head"
      wait
    fi
    sleep "${RELEASE_WATCH_INTERVAL:-30}"
  done
fi

# 1) Resolve the SHA on main. A premerge run tests the merge of main and the branch instead, so a
# branch that breaks main with its merge is caught before it is merged.
git -C "$REPO" fetch -q origin main
if [ "$MODE" = premerge ]; then
  git -C "$REPO" fetch -q origin "$SHA_IN"
  TREE_ID=$(git -C "$REPO" merge-tree --write-tree origin/main FETCH_HEAD) || die "$SHA_IN does not merge cleanly into main"
  SHA=$(git -C "$REPO" commit-tree "$TREE_ID" -p origin/main -p FETCH_HEAD -m "premerge $SHA_IN")
  git -C "$REPO" update-ref "refs/premerge/$SHA" "$SHA"
else
  SHA=$(git -C "$REPO" rev-parse --verify "$SHA_IN^{commit}") || die "unknown SHA $SHA_IN"
  git -C "$REPO" merge-base --is-ancestor "$SHA" origin/main || die "$SHA is not on origin/main"
fi
SHORT=${SHA:0:8}
# Keep the whole timestamped run on disk; wrappers often show only the tail.
case "$MODE" in check|deploy) mkdir -p "$WORK"; exec > >(tee -a "$WORK/release-$SHORT.log") 2>&1 ;; esac
# Unit tests run in one persistent checkout ($WORK/testtree) so node_modules, the Prisma client
# and vitest's cache survive between releases; install is a near no-op while the lockfile is unchanged.
# A commit is tested once: its code (everything outside docs/) matching an already tested commit
# reuses that result, and a commit whose only changes since a tested ancestor are JS/TS modules runs
# just the tests that import them (vitest --changed; package.json and vitest config changes still run
# everything). RELEASE_FULL_TESTS=1 always runs the whole suite. One test run at a time; a second
# caller for the same commit waits and reuses the result.
TREE="$WORK/testtree"
code_same() { git -C "$REPO" diff --quiet "$1" "$2" -- . ':(exclude)docs'; }
module_only() { ! git -C "$REPO" diff --name-only "$1" "$2" -- . ':(exclude)docs' | grep -qvE '\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$'; }
run_tests() {
  local TESTED="$WORK/tested/$SHA" LOG="$WORK/test-$SHORT.log" prev base="" scope
  mkdir -p "$WORK/tested"
  [ -f "$TESTED" ] && return 0
  exec 8>"$WORK/.test-lock"; flock 8
  [ -f "$TESTED" ] && { exec 8>&-; return 0; }
  for prev in $(ls -t "$WORK/tested" | head -40); do
    git -C "$REPO" cat-file -e "$prev^{commit}" 2>/dev/null || continue
    if code_same "$prev" "$SHA"; then log "code of $SHORT matches tested ${prev:0:8}; tests not rerun"; touch "$TESTED"; exec 8>&-; return 0; fi
    # Nearest tested ancestor, for the affected-only run.
    if [ -z "$base" ] && git -C "$REPO" merge-base --is-ancestor "$prev" "$SHA"; then base=$prev; fi
  done
  [ -n "$base" ] && [ "${RELEASE_FULL_TESTS:-}" != 1 ] && module_only "$base" "$SHA" || base=""
  [ -d "$TREE/.git" ] || git clone -q --no-checkout "$REPO" "$TREE"
  git -C "$TREE" fetch -q "$REPO" +refs/remotes/origin/main:refs/remotes/origin/main '+refs/premerge/*:refs/premerge/*'
  git -C "$TREE" checkout -q -f --detach "$SHA"
  git -C "$TREE" clean -qfdx -e node_modules -e packages/db/src/generated
  scope=${base:+"tests affected since tested ${base:0:8}"}
  log "testing $SHORT (${scope:-full suite})"
  local prisma_key; prisma_key=$(cat "$TREE/packages/db/prisma/schema.prisma" "$TREE/pnpm-lock.yaml" | sha256sum | cut -c1-16)
  ( cd "$TREE" \
    && pnpm install --frozen-lockfile --prefer-offline --store-dir "$WORK/pnpm-store" --config.engine-strict=false >"$LOG" 2>&1 \
    && { [ "$(cat packages/db/src/generated/.key 2>/dev/null)" = "$prisma_key" ] \
         || { (cd packages/db && npx prisma generate) && echo "$prisma_key" > packages/db/src/generated/.key; }; } >>"$LOG" 2>&1 \
    && pnpm exec vitest run ${base:+--changed "$base" --passWithNoTests} packages apps/api apps/worker apps/web >>"$LOG" 2>&1 ) \
    || { grep -E "FAIL|Tests  " "$LOG" | head -20 >&2; exec 8>&-; die "unit tests failed for $SHORT (log: $LOG)"; }
  grep -E "Tests  |No test files" "$LOG" | tail -1
  touch "$TESTED"; exec 8>&-
}
[ "$MODE" = test ] && { run_tests; log "TESTS OK $SHORT (nothing deployed)"; exit 0; }
[ "$MODE" = premerge ] && { run_tests; log "PREMERGE OK $SHA_IN on main ${SHORT} (safe to merge)"; exit 0; }
if [ "$MODE" = prebuild ]; then
  P="$WORK/prebuild/$SHA"; rm -rf "$P"; mkdir -p "$P" "$WORK/prebuilt"
  git -C "$REPO" archive --format=tar "$SHA" | tar -x -C "$P"
  echo "$SHA" > "$P/.wekruit-source-revision"
  prebuild_image "$P" > "$WORK/prebuild-$SHORT.log" 2>&1 || { rm -rf "$P"; die "image prebuild failed for $SHORT (log: $WORK/prebuild-$SHORT.log)"; }
  touch "$WORK/prebuilt/$SHA"; rm -rf "$P"; log "IMAGE PREBUILT $SHORT"; exit 0
fi

# 2) Live state and what changes.
LIVE=$(live_revision)
if [ -z "$LIVE" ]; then [ "${RELEASE_ROLLBACK:-}" = 1 ] || die "live /ready did not answer with a revision (RELEASE_ROLLBACK=1 to roll back anyway)"; LIVE=unknown; fi
log "live ${LIVE:0:8} -> target $SHORT ($(git -C "$REPO" rev-list --count "$LIVE..$SHA" 2>/dev/null || echo '?') commits)"
git -C "$REPO" diff --name-status "$LIVE" "$SHA" -- packages/db/prisma/migrations infra/modal 2>/dev/null | sed 's/^/  /' || true
N=$(containers); log "containers running: $N"
[ "$N" = 1 ] || die "expected exactly 1 container (another deploy may be in progress)"

# 3) Active-run gate: recreate kills in-flight runs. waiting_input cards survive recreate.
log "checking active runs"; ACTIVE=$(db_query "$ACTIVE_SQL") || ACTIVE="unknown"
log "active runs (30 min): $ACTIVE"
LEDGER_BEFORE=$(db_query "$LEDGER_SQL") || LEDGER_BEFORE="unknown (db query failed)"
log "ledger before: $LEDGER_BEFORE"
[ "$MODE" = check ] && { log "CHECK DONE $SHORT (nothing deployed)"; exit 0; }
[ "$MODE" = deploy ] || die "mode must be check, test or deploy"
# The cross-role readback needs a private file listing the test copies plus a sign-in; without
# either it is skipped with a warning so the release itself is not blocked.
GLOBAL_FIXTURES=${RAKAZO_GLOBAL_FIXTURES:-${RELEASE_REGRESSION_CASES:+$RELEASE_REGRESSION_CASES/global-recruiting.json}}
GLOBAL_CHECK=1
[ -n "$GLOBAL_FIXTURES" ] && [ -f "$GLOBAL_FIXTURES" ] || GLOBAL_CHECK=0
[ -n "${RAKAZO_TOKEN:-}" ] || { [ -n "${RAKAZO_EMAIL:-}" ] && [ -n "${RAKAZO_PASSWORD:-}" ]; } || GLOBAL_CHECK=0

# 4) One release at a time on this machine; exact-SHA archive with the revision marker.
mkdir -p "$WORK"; exec 9>"$WORK/.lock"; flock -n 9 || die "another release is running here"
DIR="$WORK/releases/$SHA"; rm -rf "$DIR"; mkdir -p "$DIR"
git -C "$REPO" archive --format=tar "$SHA" | tar -x -C "$DIR"
echo "$SHA" > "$DIR/.wekruit-source-revision"
# Build the image while the tests run, unless the watcher already built it for this commit.
PREBUILD=""
if [ "${RELEASE_PREBUILD:-1}" = 1 ] && [ ! -f "$WORK/prebuilt/$SHA" ]; then
  prebuild_image "$DIR" > "$WORK/prebuild-$SHORT.log" 2>&1 &
  PREBUILD=$!; log "building image for $SHORT in the background"
fi
run_tests
# Wait for a gap with no running work (waiting_input is excluded above); give up after RELEASE_GAP_WAIT s.
gap_deadline=$(( $(date +%s) + ${RELEASE_GAP_WAIT:-1800} ))
while [ "$ACTIVE" != "[]" ] && [ "${RELEASE_ALLOW_ACTIVE:-}" != "$SHORT" ] && [ "${RELEASE_ROLLBACK:-}" != 1 ]; do
  [ "$(date +%s)" -lt "$gap_deadline" ] || die "no gap without active runs; rerun later or with RELEASE_ALLOW_ACTIVE=$SHORT after the coordinator says go"
  sleep 15; ACTIVE=$(db_query "$ACTIVE_SQL") || ACTIVE="unknown"
  log "waiting for gap, active: $([ "$ACTIVE" = unknown ] && echo unknown || echo "$ACTIVE" | grep -o '"status"' | wc -l)"
done

# Left-nav pages that already fail on the live build do not block a release; only regressions do.
BASE_VIEWS=unknown
if [ -f "$DIR/infra/acceptance/home-load.mjs" ] && [ -n "${RAKAZO_EMAIL:-}" ] && [ -n "${RAKAZO_PASSWORD:-}" ]; then
  RAKAZO_ORIGIN="${RAKAZO_ORIGIN:-https://headhunter.wekruit.com}" RAKAZO_SESSION_FILE="$WORK/home-session.json" \
    node "$DIR/infra/acceptance/home-load.mjs" > "$WORK/home-base-$SHORT.log" 2>&1 && BASE_VIEWS=ok || {
      [ $? = 3 ] || BASE_VIEWS=failing; }
  log "live build left-nav pages: $BASE_VIEWS"
fi

[ -z "$PREBUILD" ] || { wait "$PREBUILD" && mkdir -p "$WORK/prebuilt" && touch "$WORK/prebuilt/$SHA" && log "image prebuilt" || log "image prebuild failed (log: $WORK/prebuild-$SHORT.log); deploy builds it"; }

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
  # Signed-in Home and the left-nav pages (Contacts, Sequence, Inbox, Interview) must open within budget.
  # A fresh container may be cold, so it gets a second try. Needs RAKAZO_EMAIL/RAKAZO_PASSWORD.
  if [ -f "$DIR/infra/acceptance/home-load.mjs" ] && [ -n "${RAKAZO_EMAIL:-}" ] && [ -n "${RAKAZO_PASSWORD:-}" ]; then
    home=1
    for attempt in 1 2; do
      RAKAZO_ORIGIN="${RAKAZO_ORIGIN:-https://headhunter.wekruit.com}" RAKAZO_SESSION_FILE="$WORK/home-session.json" \
        node "$DIR/infra/acceptance/home-load.mjs" > "$WORK/home-$SHORT.log" 2>&1 && home=0 || home=$?
      [ "$home" = 1 ] || [ "$home" = 4 ] || break
      sleep 10
    done
    case "$home" in
      0) log "home load ok: $(grep -o 'overview [0-9]* ms' "$WORK/home-$SHORT.log")" ;;
      1) cat "$WORK/home-$SHORT.log"; rollback "home page too slow (log: $WORK/home-$SHORT.log)" ;;
      4) cat "$WORK/home-$SHORT.log"
         [ "$BASE_VIEWS" = failing ] || rollback "left-nav pages broken (log: $WORK/home-$SHORT.log)"
         log "WARN left-nav pages still fail, as on the live build before this release" ;;
      *) log "WARN home load check not run: $(head -1 "$WORK/home-$SHORT.log")" ;;
    esac
  else
    log "WARN home load check skipped: set RAKAZO_EMAIL and RAKAZO_PASSWORD"
  fi
else
  for p in / /ready /health; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${RAKAZO_ORIGIN:-https://headhunter.wekruit.com}$p")
    [ "$code" = 200 ] || rollback "custom domain $p returned $code"
  done
fi
# Contact lookup and the send card on a fresh first ten (about 10 minutes; the card is never
# answered, so nothing is sent). Needs the private JD fixtures in RELEASE_CASES and the test account
# in RAKAZO_EMAIL/RAKAZO_PASSWORD; a red result rolls the release back. Skipped on a rollback.
if [ -n "${RELEASE_CASES:-}" ] && [ -f "$DIR/infra/acceptance/regression.mjs" ] \
  && [ -n "${RAKAZO_EMAIL:-}" ] && [ -n "${RAKAZO_PASSWORD:-}" ] && [ "${RELEASE_ROLLBACK:-}" != 1 ]; then
  RAKAZO_URL="$URL" RAKAZO_ORIGIN="${RAKAZO_ORIGIN:-https://headhunter.wekruit.com}" \
    node "$DIR/infra/acceptance/regression.mjs" --only contacts --cases "$RELEASE_CASES" \
      --out "$WORK/contacts-$SHORT" > "$WORK/contacts-$SHORT.log" 2>&1 \
    || { tail -8 "$WORK/contacts-$SHORT.log"; rollback "contacts check failed (log: $WORK/contacts-$SHORT.log)"; }
  log "contacts ok"
else
  log "contacts check skipped (set RELEASE_CASES and the test account to run it)"
fi
# Account-level pages must read actual product and CRM records after deployment.
if [ "$GLOBAL_CHECK" = 1 ]; then
  RAKAZO_URL="$URL" RAKAZO_ORIGIN="${RAKAZO_ORIGIN:-https://headhunter.wekruit.com}" \
    node "$DIR/infra/acceptance/regression.mjs" --only global-recruiting \
      --global-fixtures "$GLOBAL_FIXTURES" --out "$WORK/global-recruiting-$SHORT" \
      > "$WORK/global-recruiting-$SHORT.log" 2>&1 \
    || rollback "global recruiting regression failed (log: $WORK/global-recruiting-$SHORT.log)"
  log "global recruiting regression passed"
else
  log "WARN global recruiting check skipped: set RAKAZO_GLOBAL_FIXTURES and a sign-in"
fi
for _ in $(seq 1 40); do [ "$(containers)" = 1 ] && break; sleep 3; done
[ "$(containers)" = 1 ] || die "more than one container after deploy"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/health")" = 200 ] || die "/health not 200"
LEDGER_AFTER=$(db_query "$LEDGER_SQL") || LEDGER_AFTER="unknown (db query failed)"
kill $PROBE 2>/dev/null || true
DOWN=$(awk '$2!="200"{n++} END{print n*2+0}' "$WORK/health-$SHORT.log")
log "ledger after: $LEDGER_AFTER"
echo "RELEASE OK $SHORT live=$SHA previous=$LIVE health_non200≈${DOWN}s"
