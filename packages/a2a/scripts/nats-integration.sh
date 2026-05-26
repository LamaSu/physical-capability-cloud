#!/usr/bin/env bash
# packages/a2a/scripts/nats-integration.sh
#
# Brings up a single-container NATS JetStream server via docker compose,
# waits for it to report healthy, runs the @pcc/a2a integration suite with
# NATS_INTEGRATION=1, then tears the container down (and removes the
# anonymous tmpfs volume) regardless of test outcome.
#
# Usage:
#   pnpm --filter @pcc/a2a test:nats
# or directly:
#   bash packages/a2a/scripts/nats-integration.sh
#
# Exit code is the test-runner's exit code; the teardown runs from a trap so
# a Ctrl-C also cleans the container up.
#
# Requirements: docker compose v2 (`docker compose ...`), curl.

set -euo pipefail

# Resolve paths relative to this script so we work from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${PKG_DIR}/docker-compose.nats.yml"
HEALTHCHECK_URL="${NATS_HTTP_URL:-http://localhost:8222/healthz?js-enabled-only=true}"
WAIT_TIMEOUT_SECONDS="${NATS_WAIT_TIMEOUT:-60}"

echo "[nats-integration] compose file: ${COMPOSE_FILE}"
echo "[nats-integration] healthcheck:  ${HEALTHCHECK_URL}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[nats-integration] ERROR: docker not found in PATH" >&2
  exit 127
fi

cleanup() {
  echo "[nats-integration] tearing down NATS container..."
  docker compose -f "${COMPOSE_FILE}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "[nats-integration] starting NATS JetStream..."
docker compose -f "${COMPOSE_FILE}" up -d

echo "[nats-integration] waiting for healthy (up to ${WAIT_TIMEOUT_SECONDS}s)..."
deadline=$(( $(date +%s) + WAIT_TIMEOUT_SECONDS ))
while true; do
  if curl -fsS "${HEALTHCHECK_URL}" >/dev/null 2>&1; then
    echo "[nats-integration] NATS healthy."
    break
  fi
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "[nats-integration] ERROR: NATS did not become healthy within ${WAIT_TIMEOUT_SECONDS}s" >&2
    docker compose -f "${COMPOSE_FILE}" logs --tail=200 nats >&2 || true
    exit 1
  fi
  sleep 1
done

echo "[nats-integration] running integration suite (NATS_INTEGRATION=1)..."
# Run the test from the package dir so `pnpm test` picks up the local
# package.json. `--` separates pnpm flags from vitest filter args.
cd "${PKG_DIR}"
NATS_INTEGRATION=1 pnpm test -- nats-backend
TEST_EXIT=$?

echo "[nats-integration] suite exit code: ${TEST_EXIT}"
exit "${TEST_EXIT}"
