#!/usr/bin/env bash
# Refresh the test environment with a copy of production data, then bring the test app back.
#
#   RAKAZO_TEST_URL=<test app URL> sync-test-data.sh
#
# Production is only read. Everything in the test database is replaced, including accounts and
# roles created there since the last sync. Needs MODAL_TOKEN_ID/MODAL_TOKEN_SECRET in env.
set -euo pipefail
REPO=${RAKAZO_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}
: "${RAKAZO_TEST_URL:?set RAKAZO_TEST_URL to the test Modal app URL}"
log() { echo "$(date -u +%H:%M:%S) $*"; }

# The revision the test app serves now is redeployed afterwards.
SHA=$(curl -sS -o /dev/null -D - --max-time 15 "$RAKAZO_TEST_URL/ready" | tr -d '\r' | awk 'tolower($1)=="x-rakazo-revision:"{print $2}')
SHA=${SHA:-$(git -C "$REPO" rev-parse origin/main)}
log "stopping the test app (it serves ${SHA:0:8})"
MODAL_ENVIRONMENT=test modal app stop -y wekruit-recruiting-test || true
log "copying production data into the test database"
(cd "$REPO" && MODAL_ENVIRONMENT=main modal run -q infra/modal/sync_test_data.py)
log "redeploying ${SHA:0:8} to the test environment"
RELEASE_TARGET=test bash "$REPO/docs/deploy/release-cloud.sh" "$SHA" deploy
