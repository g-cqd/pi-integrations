/**
 * Locate and validate candidate Antigravity OAuth client secrets in an `agy`
 * binary, and work out where the accepted one should be written.
 *
 * This module is pure: it reads bytes it is handed and performs no network or
 * filesystem writes. scripts/extract-agy-client-secret.ts does the I/O, so the
 * search rules stay testable without an `agy` install or a live request.
 *
 * Why candidates must be sliced to a length rather than grepped. Google stores
 * these secrets as adjacent fixed-width strings in the binary's string table,
 * with no separator between them. A greedy `GOCSPX-[A-Za-z0-9_-]*` therefore
 * runs two secrets together and returns a value that is not in the file at all.
 * The real secret is 35 bytes; the greedy match is 70 and useless.
 *
 * Nothing here trusts shape. A candidate is only accepted once the token
 * endpoint confirms the pairing, which is the check scripts/extract-agy-client-secret.ts
 * performs; see `verify` in that script and `TOKEN_ERRORS` below.
 */

export { SECRET_PREFIX, BODY_LENGTHS, findPrefixOffsets, isCandidate, findCandidates } from "../../src/domains/agy/client-secret.ts";

export const TOKEN_ERRORS = {
	accepted: "invalid_grant",
	rejected: "invalid_client",
} as const;

/**
 * Where the accepted secret belongs. Mirrors the resolution order in
 * src/domains/agy/oauth.ts: an explicit override wins, otherwise the documented
 * default under the user's home directory. The extractor is given this path so
 * the two cannot drift apart.
 */
export function defaultSecretPath(env: Record<string, string | undefined> = {}): string {
	const override = env.AGY_OAUTH_CLIENT_SECRET_FILE;
	if (override) return override;
	const home = env.HOME ?? "";
	return `${home}/.config/pi-integrations/agy-oauth-client-secret`;
}
