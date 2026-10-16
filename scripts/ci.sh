#!/usr/bin/env bash
# The CI pipeline, runnable locally. Mirrors .github/workflows/ci.yml step for
# step, so verification never depends on hosted Actions being available.
#
#   ./scripts/ci.sh
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n=== %s ===\n' "$1"; }

step "install (frozen lockfile, no scripts)"
bun install --frozen-lockfile --ignore-scripts

step "type-check"
bun run check

step "tests with coverage"
bun run test:coverage

step "offline provider registration"
PI_CMD="bun node_modules/@earendil-works/pi-coding-agent/dist/cli.js" ./scripts/smoke-registration.sh

printf '\nAll CI steps passed locally.\n'
