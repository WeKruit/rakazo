#!/usr/bin/env bash
# Legacy Compose only: build the explicitly approved, tested full source revision.
#
# Install as /usr/local/sbin/rakazo-deploy-main and run it as the deploy user, for example
# from CI through an SSH forced command. The deploy user needs passwordless sudo for Docker.
set -Eeuo pipefail

# Forced-command SSH exposes the requested command through SSH_ORIGINAL_COMMAND.
requested_revision="${1:-}"
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  [[ "$SSH_ORIGINAL_COMMAND" =~ ^deploy-main\ ([0-9a-f]{40})$ ]] || { echo "Expected deploy-main FULL_SHA" >&2; exit 1; }
  requested_revision="${BASH_REMATCH[1]}"
fi
[[ "$requested_revision" =~ ^[0-9a-f]{40}$ ]] || { echo "A tested full SHA is required" >&2; exit 1; }

# A forced SSH command carries no environment, so read the checkout path from a root-owned file.
if [[ -z "${RAKAZO_DEPLOY_DIR:-}" && -r /etc/rakazo/deploy.env ]]; then
  # shellcheck disable=SC1091
  source /etc/rakazo/deploy.env
fi
[[ "${RAKAZO_LEGACY_COMPOSE_APPROVED_SHA:-}" == "$requested_revision" && "${RAKAZO_DEPLOYMENT_HOLD:-}" == clear ]] || {
  echo "Legacy Compose approval or hold prerequisite is missing" >&2; exit 1;
}
APP_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
[[ "${APP_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }
COMPOSE_FILE="infra/compose/docker-compose.prod.yml"
# CI allows 30 minutes: 15m build + 5m start + ~1m of health retries + 8m rollback.
BUILD_TIMEOUT="${RAKAZO_DEPLOY_BUILD_TIMEOUT:-15m}"
UP_TIMEOUT="${RAKAZO_DEPLOY_UP_TIMEOUT:-5m}"
ROLLBACK_TIMEOUT="${RAKAZO_DEPLOY_ROLLBACK_TIMEOUT:-8m}"

cd "${APP_DIR}"
if [[ -z "${RAKAZO_HEALTH_URL:-}" ]]; then
  host="$(sed -n 's/^RAKAZO_HOST=//p' .env | tail -n 1)"
  [[ -n "${host}" ]] || { echo "Set RAKAZO_HOST in .env or RAKAZO_HEALTH_URL" >&2; exit 1; }
  RAKAZO_HEALTH_URL="https://${host}/health"
fi

compose() {
  local limit="$1"
  shift
  timeout --kill-after=30s "${limit}" sudo docker compose --env-file .env -f "${COMPOSE_FILE}" "$@"
}

healthy() {
  curl --fail --silent --show-error --max-time 15 "${RAKAZO_HEALTH_URL}" >/dev/null
}

exec 9>"${APP_DIR}/.deploy.lock"
if ! flock -n 9; then
  # CI runs one deploy at a time, so a held lock means an earlier deploy is stuck. Fail loudly
  # instead of reporting a deploy that never happened.
  echo "Another production deployment holds the lock; refusing to report success." >&2
  exit 1
fi

previous_revision="$(git rev-parse HEAD)"
[[ -z "$(git status --porcelain)" ]] || { echo "Refusing a dirty deployment checkout" >&2; exit 1; }
git fetch --quiet --prune origin main
target_revision="$requested_revision"
[[ "$(git rev-parse origin/main)" == "$target_revision" ]] || { echo "Approved revision is no longer main; review and retry explicitly" >&2; exit 1; }

# Written only after a healthy rollout. A reset can make HEAD match before containers change.
deployed_revision=""
if [[ -r "${APP_DIR}/.last-deployed-revision" ]]; then
  deployed_revision="$(tr -d '[:space:]' <"${APP_DIR}/.last-deployed-revision")"
fi
if [[ "${previous_revision}" == "${target_revision}" && "${deployed_revision}" == "${target_revision}" ]] && healthy; then
  echo "Production is already at ${target_revision} and healthy."
  exit 0
fi

rollback() {
  trap - ERR
  echo "Deployment failed; restoring the previous revision ${previous_revision}." >&2
  git reset --hard "${previous_revision}"
  compose "${ROLLBACK_TIMEOUT}" up -d --build --remove-orphans
  exit 1
}
trap rollback ERR

git reset --hard "${target_revision}"
compose 1m config --quiet
compose "${BUILD_TIMEOUT}" build
compose "${UP_TIMEOUT}" up -d --remove-orphans

for _ in {1..30}; do
  if healthy; then
    printf '%s\n' "${target_revision}" >"${APP_DIR}/.last-deployed-revision"
    trap - ERR
    echo "Deployed ${target_revision} successfully."
    exit 0
  fi
  sleep "${RAKAZO_DEPLOY_HEALTH_INTERVAL:-2}"
done

echo "Production health check did not recover in time." >&2
false
