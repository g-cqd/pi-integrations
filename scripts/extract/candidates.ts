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

/** Prefix every Google OAuth client secret carries. */
export const SECRET_PREFIX = "GOCSPX-";

/**
 * Body lengths tried, in bytes after the prefix. Google's Desktop secrets are
 * 35 bytes in total (prefix plus 28). The window is deliberately narrow: wide
 * enough to recover a secret whose length changes in a future app version,
 * narrow enough that a slice running off the end of a real secret is rejected by
 * the character rules rather than reported as a candidate.
 */
export const BODY_LENGTHS = { min: 24, max: 40 } as const;

/**
 * Token-endpoint errors, and what each one proves. This is why verification is
 * a live request and not a pattern match: only the server can tell a real
 * pairing from a well-formed neighbour.
 *
 * - `invalid_grant`: Google accepted the client credentials and rejected only
 *   the deliberately bogus authorization code. This is the accepted signal.
 * - `invalid_client`: the client id and secret do not pair. Rejected.
 * - Anything else (`invalid_request`, a transport failure, an HTML error page)
 *   is inconclusive and the candidate is dropped rather than guessed at.
 */
export const TOKEN_ERRORS = {
	accepted: "invalid_grant",
	rejected: "invalid_client",
} as const;

const SHAPE = new RegExp(`^${SECRET_PREFIX}[A-Za-z0-9_-]+$`);

/** Byte offset of every secret prefix in the binary. */
export function findPrefixOffsets(image: Uint8Array): number[] {
	const needle = new TextEncoder().encode(SECRET_PREFIX);
	const offsets: number[] = [];
	outer: for (let i = 0; i + needle.length <= image.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (image[i + j] !== needle[j]) continue outer;
		}
		offsets.push(i);
	}
	return offsets;
}

/**
 * Whether a byte slice is a well-formed candidate: the length is inside the
 * plausible window, the prefix is intact, and the rest is only the characters
 * Google uses.
 *
 * The upper bound matters as much as the lower one. Without it a slice running
 * off the end of a real secret picks up the next one and is reported as a
 * single 70-byte candidate, which is exactly the bug this exists to prevent.
 */
export function isCandidate(bytes: Uint8Array): boolean {
	const min = SECRET_PREFIX.length + BODY_LENGTHS.min;
	const max = SECRET_PREFIX.length + BODY_LENGTHS.max;
	if (bytes.length < min || bytes.length > max) return false;
	// Reject early rather than letting TextDecoder insert replacement characters.
	for (const byte of bytes) if (byte < 0x21 || byte > 0x7e) return false;
	return SHAPE.test(new TextDecoder("latin1").decode(bytes));
}

/**
 * Every distinct well-formed candidate in the image, longest plausible run
 * first for a given offset. Order is not a signal: which candidate is correct
 * is decided by the token endpoint, never by this function.
 */
export function findCandidates(image: Uint8Array): string[] {
	const decoder = new TextDecoder("latin1");
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const offset of findPrefixOffsets(image)) {
		for (let body = BODY_LENGTHS.min; body <= BODY_LENGTHS.max; body++) {
			const total = SECRET_PREFIX.length + body;
			if (offset + total > image.length) continue;
			const slice = image.subarray(offset, offset + total);
			if (!isCandidate(slice)) continue;
			const text = decoder.decode(slice);
			if (seen.has(text)) continue;
			seen.add(text);
			candidates.push(text);
		}
	}
	return candidates;
}

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
