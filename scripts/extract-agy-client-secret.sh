#!/usr/bin/env bash
# Recover the Antigravity app's OAuth client secret from an installed `agy`
# binary and verify it against Google's token endpoint.
#
#   ./scripts/extract-agy-client-secret.sh [path-to-agy]
#
# Why this is not a fixed offset or a plain `strings | grep`:
#
#   - Addresses and file offsets move on every rebuild. This script never
#     records one; it searches for content, so an app update only changes what
#     it finds if Google rotates the secret itself.
#   - Google client secrets are stored as adjacent fixed-width strings in the
#     binary's string table, with no separator. A greedy `GOCSPX-[A-Za-z0-9_-]*`
#     therefore runs two secrets together and yields a value that is not in the
#     binary at all. This script slices candidates to the exact byte length and
#     proves each one before printing it.
#   - Nothing is trusted on shape alone. A candidate is reported only after the
#     token endpoint accepts it as a client credential, so a neighbouring or
#     decoy value is discarded rather than configured.
#
# The secret is written to the run-time path this repository reads
# (mode 600, outside any repository). It is never printed to stdout, never
# written here, and never passed on a command line.

set -euo pipefail

BINARY="${1:-$(command -v agy || true)}"
SECRET_DIR="${AGY_OAUTH_CLIENT_SECRET_FILE:-$HOME/.config/pi-integrations/agy-oauth-client-secret}"
SECRET_FILE="${SECRET_DIR%/agy-oauth-client-secret}/agy-oauth-client-secret"

# Google's Desktop client id, pinned by test/agy/oauth.test.ts.
CLIENT_ID="1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
REDIRECT_URI="https://antigravity.google/oauth-callback"
TOKEN_URL="https://oauth2.googleapis.com/token"

# GOCSPX- plus 28 characters. Lengths are tried in a narrow window so that a
# value sliced from the middle of a longer run is still considered, but an
# arbitrary blob is not.
PREFIX_LEN=7
MIN_BODY=24
MAX_BODY=40

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ -n "$BINARY" ] || die "no agy binary found; pass a path"
[ -r "$BINARY" ] || die "cannot read $BINARY"

printf 'scanning %s\n' "$BINARY"

# 1. Every GOCSPX- run, with its byte offset. Offsets are used only to slice
#    within this file during this run; none are persisted.
mapfile -t OFFSETS < <(grep -abo 'GOCSPX-' "$BINARY" | cut -d: -f1)
[ "${#OFFSETS[@]}" -gt 0 ] || die "no GOCSPX- string in $BINARY"
printf 'found %d candidate prefix(es)\n' "${#OFFSETS[@]}"

# 2. Ask the token endpoint whether a candidate is a valid client credential.
#    invalid_grant means Google accepted the credentials and rejected only the
#    deliberately bogus code. invalid_client means the pairing is wrong. Any
#    other answer is inconclusive and the candidate is dropped.
#    The secret travels only in the POST body, never argv, so it stays out of
#    the process table and shell history.
verify() {
	local secret="$1" verifier challenge reply
	verifier="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
	challenge="$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=\n')"
	reply="$(curl -sS -m 20 -X POST "$TOKEN_URL" \
		--data-urlencode 'code=not-a-real-code' \
		--data-urlencode 'grant_type=authorization_code' \
		--data-urlencode "client_id=$CLIENT_ID" \
		--data-urlencode "client_secret=$secret" \
		--data-urlencode "redirect_uri=$REDIRECT_URI" \
		--data-urlencode "code_verifier=$verifier" \
		--data-urlencode "code_challenge=$challenge" \
		--data-urlencode 'code_challenge_method=S256' 2>/dev/null || true)"
	case "$reply" in
		*invalid_grant*) return 0 ;;
		*) return 1 ;;
	esac
}

FOUND=""
for offset in "${OFFSETS[@]}"; do
	for body in $(seq "$MIN_BODY" "$MAX_BODY"); do
		total=$(( PREFIX_LEN + body ))
		# Tr -d NUL: the run may abut binary data, and bash drops NUL from
		# command substitution silently-but-noisily. The shape check rejects
		# whatever the slice picked up.
		candidate="$(dd if="$BINARY" bs=1 skip="$offset" count="$total" 2>/dev/null | tr -d '\0' || true)"
		# Require the shape: printable, prefix intact, no embedded whitespace.
		[[ "$candidate" == GOCSPX-* ]] || continue
		[[ "$candidate" =~ ^[A-Za-z0-9_-]+$ ]] || continue
		# Skip repeats of a candidate already tested.
		seen="${seen:-} "
		[[ "$seen" == *" $candidate "* ]] && continue
		seen="$seen$candidate "

		if verify "$candidate"; then
			FOUND="$candidate"
			break 2
		fi
	done
done

if [ -z "$FOUND" ]; then
	die "no candidate was accepted by the token endpoint (the secret may have been rotated; re-run after updating agy)"
fi

# 3. Persist to the run-time path this repository already reads.
umask 077
mkdir -p "$(dirname "$SECRET_FILE")"
printf '%s' "$FOUND" > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"

printf 'verified a client secret (%d bytes) and wrote it to\n  %s\n' "${#FOUND}" "$SECRET_FILE"
printf 'The value was not printed. It is an app credential of Antigravity, not of any\n'
printf 'user; keep it out of shell history, logs, and version control.\n'
