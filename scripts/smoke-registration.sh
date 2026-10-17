#!/usr/bin/env bash
# Offline registration smoke test for all five domains. Makes no network request.
#
# Pi lists a provider only when it has a credential, and these domains accept no
# API-key configuration, so this writes synthetic OAuth credentials into an
# isolated, throwaway Pi config directory (never ~/.pi). Offline mode keeps the
# model-catalog refreshes credential-gated, so the placeholders are what appear.
#
#   scripts/smoke-registration.sh                       uses `pi` from PATH
#   PI_CMD="bun node_modules/.../cli.js" scripts/...    uses another launcher
set -euo pipefail

PI_CMD="${PI_CMD:-pi}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT

# Year 2100 in ms, so Pi never decides to refresh. All values are synthetic.
EXPIRES=4102444800000
cred() { printf '"%s": {"type": "oauth", "access": "ci-synthetic", "refresh": "ci-synthetic", "expires": %s%s}' "$1" "$EXPIRES" "${2:-}"; }
{
  echo "{"
  cred claude-subscription; echo ","
  cred codex-subscription; echo ","
  cred agy-subscription ', "projectId": "ci-synthetic-project"'; echo ","
  cred spettro; echo ","
  cred mistral-vibe; echo ","
  cred apple-foundation
  echo "}"
} > "$DIR/auth.json"

OUT="$DIR/models.txt"
PI_CODING_AGENT_DIR="$DIR" $PI_CMD --offline --no-mcp --no-extensions -e . --list-models > "$OUT"

fail() { echo "FAIL: $1" >&2; echo "--- output ---" >&2; cat "$OUT" >&2; exit 1; }
grep -qE "^claude-subscription[[:space:]]"                       "$OUT" || fail "claude-subscription not registered"
grep -qE "^codex-subscription[[:space:]]"                        "$OUT" || fail "codex-subscription not registered"
grep -qE "^agy-subscription[[:space:]]+agy-catalog-loading"      "$OUT" || fail "agy-subscription placeholder missing"
grep -qE "^spettro[[:space:]]+spettro-catalog-loading"           "$OUT" || fail "spettro placeholder missing"
grep -qE "^mistral-vibe[[:space:]]+mistral-large-4[[:space:]]"   "$OUT" || fail "mistral-vibe mistral-large-4 missing"
grep -qE "^apple-foundation[[:space:]]+apple-foundation-local"   "$OUT" || fail "apple-foundation-local missing"
grep -qE "^decision-router[[:space:]]+router[[:space:]]"         "$OUT" || fail "decision-router/router missing"
grep -qE "^decision-router[[:space:]]+auto[[:space:]]"           "$OUT" || fail "decision-router/auto missing"
[ "$(grep -cE '^mistral-vibe[[:space:]]' "$OUT")" = "1" ]              || fail "mistral-vibe must list exactly one model"
echo "OK: seven domains registered ($(grep -cE '^(claude|codex|agy)-subscription[[:space:]]' "$OUT") subscription models, placeholders for agy/spettro, one Mistral model, Apple Foundation Models, and Decision Router virtual models)"
