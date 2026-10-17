import assert from "node:assert/strict";
import { test } from "bun:test";
import {
	BODY_LENGTHS, SECRET_PREFIX, TOKEN_ERRORS,
	defaultSecretPath, findCandidates, findPrefixOffsets, isCandidate,
} from "../../scripts/extract/candidates.ts";

// These fixtures are synthetic and deliberately secret-shaped: they exist to
// prove the search slices candidates correctly. No value here is credential-
// valued, and the guard in test/agy/no-bundled-secret.test.ts excludes files
// holding its own patterns, not these.

const encode = (value: string) => new TextEncoder().encode(value);
const FAKE_A = `${SECRET_PREFIX}${"A".repeat(28)}`; // 35 bytes, real length
const FAKE_B = `${SECRET_PREFIX}${"B".repeat(28)}`;
const DECOY = `${SECRET_PREFIX}${"D".repeat(28)}`;

/** A binary-like buffer: text with binary gaps, as a real string table has. */
function image(...parts: Array<Uint8Array | string>): Uint8Array {
	const chunks = parts.map((p) => (typeof p === "string" ? encode(p) : p));
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

test("prefix offsets are found across gaps", () => {
	const img = image("noise", FAKE_A, "\x00\x01binary", FAKE_B, "\xff");
	const offsets = findPrefixOffsets(img);
	assert.equal(offsets.length, 2);
	assert.equal(new TextDecoder("latin1").decode(img.subarray(offsets[0], offsets[0] + FAKE_A.length)), FAKE_A);
	assert.equal(new TextDecoder("latin1").decode(img.subarray(offsets[1], offsets[1] + FAKE_B.length)), FAKE_B);
});

test("adjacent fixed-width secrets are not run together", () => {
	// The failure this whole script exists to prevent: two secrets with no
	// separator, as Google stores them.
	const glued = image(FAKE_A + FAKE_B);
	const candidates = findCandidates(glued);
	assert.ok(candidates.includes(FAKE_A), "the first secret must be recovered whole");
	assert.ok(candidates.includes(FAKE_B), "the second secret must be recovered whole");
	assert.ok(
		!candidates.includes(FAKE_A + FAKE_B),
		"the glued 70-byte run is not a value in the binary and must not be offered",
	);
});

test("the greedy greedy-match length is rejected", () => {
	// A candidate that spans both secrets is longer than any real secret.
	assert.equal(FAKE_A.length, SECRET_PREFIX.length + 28);
	assert.ok(!isCandidate(encode(FAKE_A + FAKE_B)), "a glued run is not a well-formed candidate");
});

test("candidates in a plausible length window are kept, others are not", () => {
	for (const body of [BODY_LENGTHS.min, 28, BODY_LENGTHS.max]) {
		const value = `${SECRET_PREFIX}${"X".repeat(body)}`;
		assert.ok(isCandidate(encode(value)), `${value.length} bytes should be in the window`);
	}
	const tooShort = `${SECRET_PREFIX}${"X".repeat(BODY_LENGTHS.min - 1)}`;
	assert.ok(!isCandidate(encode(tooShort)), "shorter than the window");
	const tooLong = `${SECRET_PREFIX}${"X".repeat(BODY_LENGTHS.max + 1)}`;
	assert.ok(!isCandidate(encode(tooLong)), "longer than the window");
});

test("binary data and wrong characters are rejected", () => {
	assert.ok(!isCandidate(encode(`${SECRET_PREFIX}${"X".repeat(28)}\x00`)), "NUL is not a secret character");
	assert.ok(!isCandidate(encode(`${SECRET_PREFIX}${"X".repeat(20)} has space`)), "whitespace is rejected");
	assert.ok(!isCandidate(encode(`NOTASECRET${"X".repeat(28)}`)), "the prefix must be intact");
	assert.ok(!isCandidate(encode(`${SECRET_PREFIX}bad$chars${"X".repeat(20)}`)), "non-alphanumerics are rejected");
});

test("a decoy placed first does not shadow the real candidate", () => {
	const candidates = findCandidates(image(DECOY, "\x00", FAKE_A));
	assert.ok(candidates.includes(DECOY), "the decoy is still surfaced for verification");
	assert.ok(candidates.includes(FAKE_A), "the real candidate is still found behind it");
	assert.notEqual(candidates[0], FAKE_A, "order is not a correctness signal; verification decides");
});

test("candidates are deduplicated", () => {
	const candidates = findCandidates(image(FAKE_A, "\x00", FAKE_A));
	assert.equal(candidates.filter((c) => c === FAKE_A).length, 1);
});

test("the run-time path mirrors the domain's resolution order", () => {
	assert.equal(
		defaultSecretPath({ HOME: "/home/x" }),
		"/home/x/.config/pi-integrations/agy-oauth-client-secret",
	);
	assert.equal(
		defaultSecretPath({ HOME: "/home/x", AGY_OAUTH_CLIENT_SECRET_FILE: "/custom/path" }),
		"/custom/path",
		"an explicit override wins, as in src/domains/agy/oauth.ts",
	);
});

test("the accepted signal is distinct from the rejected one", () => {
	// Verification hinges on telling these apart: only the first means Google
	// accepted the client credentials.
	assert.equal(TOKEN_ERRORS.accepted, "invalid_grant");
	assert.equal(TOKEN_ERRORS.rejected, "invalid_client");
	assert.notEqual(TOKEN_ERRORS.accepted, TOKEN_ERRORS.rejected);
});
