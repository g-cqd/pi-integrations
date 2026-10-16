import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import {
	AUTHORIZE_URL, CLIENT_ID, CLIENT_SECRET_ENV, CLIENT_SECRET_FILE_ENV, DEFAULT_CLIENT_SECRET_FILE, REDIRECT_URI, SCOPES, TOKEN_URL,
	buildAuthorizeUrl, exchangeAuthorizationCode, parseAuthorizationInput, refreshCredentials, readSecretFileSync,
	requireClientSecret, resolveClientSecret, secretFromEnv, secretFromFile,
	type AgyCredentials,
} from "../../src/domains/agy/oauth.ts";
import { syntheticJwt } from "../support/jwt.ts";
import { sequenceFetch } from "../support/fixtures.ts";

// Synthetic only. The secret is a made-up placeholder; no real credential is in this
// repository, and the file reader is injected so nothing touches the filesystem.

const NOW = 1_800_000_000_000;
const SECRET = "synthetic-client-secret-value";
const STATE = "synthetic-state_123";
const CODE = "4/synthetic_authorization_code_value";
const secret = () => SECRET;
/** Mirrors the module's ~ expansion so a default-path assertion is exact. */
const expand = (path: string) => path.replace(/^~/, process.env.HOME ?? "/home/x");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));
const tokenBody = (over: Record<string, unknown> = {}) => ({
	access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token", expires_in: 3599,
	token_type: "Bearer", scope: "openid", id_token: syntheticJwt({ email: "user@example.test" }), ...over,
});

test("endpoints and client id are the ones the real CLI uses", () => {
	assert.equal(AUTHORIZE_URL, "https://accounts.google.com/o/oauth2/auth");
	assert.equal(TOKEN_URL, "https://oauth2.googleapis.com/token");
	assert.equal(REDIRECT_URI, "https://antigravity.google/oauth-callback");
	assert.equal(CLIENT_ID, "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com");
	assert.equal(CLIENT_SECRET_ENV, "AGY_OAUTH_CLIENT_SECRET");
});

test("the authorization URL is byte-identical in shape to the one captured from the real CLI", () => {
	// Captured from `agy`'s own "Google OAuth" sign-in link (state and challenge are per-login).
	const captured = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&code_challenge=CHALLENGE&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcclog+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fexperimentsandconfigs+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Faicode+openid&state=STATE";
	assert.equal(buildAuthorizeUrl({ state: "STATE", codeChallenge: "CHALLENGE" }), captured);
	assert.equal(SCOPES.length, 7);
});

test("no client secret is bundled in the module's public surface", () => {
	// The Antigravity app's real secret must not appear here in any form.
	for (const value of [CLIENT_ID, AUTHORIZE_URL, TOKEN_URL, REDIRECT_URI, ...SCOPES, DEFAULT_CLIENT_SECRET_FILE]) {
		assert.ok(!/GOCSPX-/.test(value), `${value} must not carry a secret`);
	}
	assert.ok(!/GOCSPX-/.test(buildAuthorizeUrl({ state: "s", codeChallenge: "c" })));
	assert.equal(requireClientSecret({ clientSecret: () => SECRET }).length, SECRET.length);
});

// ---------------------------------------------------------------------------
// Client secret handling
// ---------------------------------------------------------------------------

test("the secret is read from the environment, trimmed, and blank means unset", () => {
	assert.equal(secretFromEnv({ AGY_OAUTH_CLIENT_SECRET: "  abc  " }), "abc");
	assert.equal(secretFromEnv({ AGY_OAUTH_CLIENT_SECRET: "   " }), undefined);
	assert.equal(secretFromEnv({}), undefined);
});

test("the environment wins, blank means unset, and the file is the fallback", () => {
	const withFile = (env: Record<string, string | undefined>) => secretFromFile(env, (path) => path === expand(DEFAULT_CLIENT_SECRET_FILE) ? "  file-value  " : undefined);
	assert.equal(resolveClientSecret({}), undefined, "nothing configured means no secret");
	assert.equal(resolveClientSecret({ AGY_OAUTH_CLIENT_SECRET: "  env-value  " }), "env-value");
	assert.equal(resolveClientSecret({ AGY_OAUTH_CLIENT_SECRET: "   ", AGY_OAUTH_CLIENT_SECRET_FILE: "/custom/path" }, (p) => p === "/custom/path" ? "file-value" : undefined), "file-value");
	assert.equal(withFile({}), "file-value");
	assert.equal(secretFromFile({}, () => undefined), undefined);
	assert.equal(secretFromFile({}, () => "   "), undefined, "a blank file means unset");
	assert.equal(resolveClientSecret({ AGY_OAUTH_CLIENT_SECRET: "env" }, () => "file"), "env", "the environment takes precedence");
});

test("the default path expands ~ and is overridable", () => {
	const expand = (p: string) => p.replace(/^~/, process.env.HOME ?? "/home/x");
	assert.ok(DEFAULT_CLIENT_SECRET_FILE.startsWith("~/"), "the default lives under the home directory");
	assert.equal(secretFromFile({}, (p) => p === expand(DEFAULT_CLIENT_SECRET_FILE) ? "ok" : undefined), "ok");
	assert.equal(secretFromFile({ [CLIENT_SECRET_FILE_ENV]: "/etc/agy/secret" }, (p) => p === "/etc/agy/secret" ? "ok" : undefined), "ok");
});

test("the real reader tolerates a missing, empty, or unreadable file", () => {
	assert.equal(readSecretFileSync("/definitely/not/here/agy-secret"), undefined);
	assert.equal(readSecretFileSync(process.env.HOME ?? "/"), undefined, "a directory is not a secret");
});

test("with nothing configured the resolvers yield nothing and no request is made", async () => {
	const saved = process.env[CLIENT_SECRET_ENV];
	const savedFile = process.env[CLIENT_SECRET_FILE_ENV];
	delete process.env[CLIENT_SECRET_ENV]; delete process.env[CLIENT_SECRET_FILE_ENV];
	try {
		const f = sequenceFetch([tokenBody()]);
		await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: f.fetchImpl, now: () => NOW }), new RegExp(CLIENT_SECRET_ENV));
		assert.equal(f.calls.length, 0);
	} finally {
		if (saved === undefined) delete process.env[CLIENT_SECRET_ENV]; else process.env[CLIENT_SECRET_ENV] = saved;
		if (savedFile === undefined) delete process.env[CLIENT_SECRET_FILE_ENV]; else process.env[CLIENT_SECRET_FILE_ENV] = savedFile;
	}
});

test("a resolved secret is sent only in the token body and never leaks into results or errors", async () => {
	const ok = sequenceFetch([tokenBody()]);
	const credentials = await exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: ok.fetchImpl, clientSecret: secret, now: () => NOW });
	assert.equal(form(ok.calls[0].init).client_secret, SECRET);
	assert.ok(!ok.calls[0].url.includes(SECRET));
	assert.ok(!JSON.stringify(credentials).includes(SECRET));
	const bad = sequenceFetch([json({ error: "invalid_client", error_description: `bad ${SECRET}` }, 401)]);
	await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: bad.fetchImpl, clientSecret: secret }), (e: Error) => !e.message.includes(SECRET));
	const net = sequenceFetch([new Error(`transport ${SECRET}`)]);
	await assert.rejects(refreshCredentials({ access: "a", refresh: "r", expires: 0 }, { fetchImpl: net.fetchImpl, clientSecret: secret }), (e: Error) => !e.message.includes(SECRET));
});

test("an injected missing or malformed secret fails with guidance, before any request", async () => {
	for (const clientSecret of [() => undefined, () => "", () => "has whitespace", () => "x".repeat(20000)]) {
		const f = sequenceFetch([tokenBody()]);
		await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: f.fetchImpl, clientSecret }), /antigravity-google-client-secret|AGY_OAUTH_CLIENT_SECRET/);
		await assert.rejects(refreshCredentials({ access: "a", refresh: "r", expires: 0 }, { fetchImpl: f.fetchImpl, clientSecret }), /AGY_OAUTH_CLIENT_SECRET/);
		assert.equal(f.calls.length, 0);
	}
	assert.equal(requireClientSecret({ clientSecret: secret }), SECRET);
});

test("the secret is sent only in the token request body and never appears in results or errors", async () => {
	const ok = sequenceFetch([tokenBody()]);
	const credentials = await exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: ok.fetchImpl, clientSecret: secret, now: () => NOW });
	assert.equal(form(ok.calls[0].init).client_secret, SECRET);
	assert.ok(!ok.calls[0].url.includes(SECRET));
	assert.ok(!JSON.stringify(credentials).includes(SECRET));
	const bad = sequenceFetch([json({ error: "invalid_client", error_description: `bad ${SECRET}` }, 401)]);
	await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: bad.fetchImpl, clientSecret: secret }), (e: Error) => !e.message.includes(SECRET));
	const net = sequenceFetch([new Error(`transport ${SECRET}`)]);
	await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: net.fetchImpl, clientSecret: secret }), (e: Error) => !e.message.includes(SECRET));
});

// ---------------------------------------------------------------------------
// Pasted input
// ---------------------------------------------------------------------------

test("the bare code the hosted page displays is accepted, as are redirect-URL forms with matching state", () => {
	for (const input of [CODE, ` ${CODE}\n`, `${REDIRECT_URI}?code=${encodeURIComponent(CODE)}&state=${STATE}`, `${REDIRECT_URI}?code=${encodeURIComponent(CODE)}`, `code=${encodeURIComponent(CODE)}&state=${STATE}`]) {
		assert.deepEqual(parseAuthorizationInput(input, STATE), { code: CODE }, input);
	}
});

for (const [label, input] of [
	["empty", ""], ["too short", "4/short"], ["spaces inside", "4/synthetic code with spaces"],
	["wrong state in URL", `${REDIRECT_URI}?code=${encodeURIComponent(CODE)}&state=other`],
	["foreign origin", `https://evil.example/oauth-callback?code=${encodeURIComponent(CODE)}`],
	["wrong path", `https://antigravity.google/other?code=${encodeURIComponent(CODE)}`],
	["http scheme", `http://antigravity.google/oauth-callback?code=${encodeURIComponent(CODE)}`],
	["userinfo", `https://u:p@antigravity.google/oauth-callback?code=${encodeURIComponent(CODE)}`],
	["duplicate code", `${REDIRECT_URI}?code=${encodeURIComponent(CODE)}&code=${encodeURIComponent(CODE)}`],
	["provider error", `${REDIRECT_URI}?error=access_denied&state=${STATE}`],
	["too long", "4/" + "a".repeat(5000)],
] as const) {
	test(`pasted input is rejected: ${label}`, () => assert.equal(parseAuthorizationInput(input, STATE), null));
}

// ---------------------------------------------------------------------------
// Exchange and refresh
// ---------------------------------------------------------------------------

test("exchange sends the code grant and maps credentials, reading only the email from the ID token", async () => {
	const f = sequenceFetch([tokenBody()]);
	const credentials = await exchangeAuthorizationCode({ code: CODE, codeVerifier: "synthetic-verifier", fetchImpl: f.fetchImpl, clientSecret: secret, now: () => NOW });
	assert.equal(f.calls[0].url, TOKEN_URL);
	assert.equal(new Headers(f.calls[0].init.headers).get("content-type"), "application/x-www-form-urlencoded");
	assert.deepEqual(form(f.calls[0].init), {
		grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: SECRET, code: CODE,
		code_verifier: "synthetic-verifier", redirect_uri: REDIRECT_URI,
	});
	assert.equal(credentials.access, "synthetic-access-token");
	assert.equal(credentials.refresh, "synthetic-refresh-token");
	assert.equal(credentials.expires, NOW + 3_599_000 - 300_000);
	assert.equal(credentials.account_email, "user@example.test");
	assert.equal(credentials.scopes, "openid");
	assert.ok(!("id_token" in credentials), "the ID token is not stored");
});

test("a response without a refresh token fails clearly rather than storing a session that cannot renew", async () => {
	const f = sequenceFetch([tokenBody({ refresh_token: undefined })]);
	await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: f.fetchImpl, clientSecret: secret }), /no refresh token/);
});

test("a malformed ID token or hostile email is ignored, not trusted", async () => {
	for (const id_token of ["not-a-jwt", syntheticJwt({ email: "<script>@x" }), syntheticJwt({ email: 7 }), undefined]) {
		const f = sequenceFetch([tokenBody({ id_token })]);
		const credentials = await exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: f.fetchImpl, clientSecret: secret, now: () => NOW });
		assert.equal(credentials.account_email, undefined);
	}
});

for (const [label, patch] of [
	["wrong token type", { token_type: "mac" }], ["missing token type", { token_type: undefined }],
	["empty access token", { access_token: "" }], ["access token with whitespace", { access_token: "a b" }],
	["string lifetime", { expires_in: "3600" }], ["zero lifetime", { expires_in: 0 }],
	["non-string scope", { scope: 1 }], ["bad refresh token", { refresh_token: "has space" }],
] as const) {
	test(`token response is refused: ${label}`, async () => {
		const f = sequenceFetch([tokenBody(patch)]);
		await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: f.fetchImpl, clientSecret: secret }), /Invalid (credential response|token lifetime)/);
	});
}

test("error responses expose only an allowlisted code, with recovery guidance, and are not retried", async () => {
	const f = sequenceFetch([json({ error: "invalid_grant", error_description: "synthetic-sensitive-description" }, 400)]);
	await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: f.fetchImpl, clientSecret: secret }), (e: Error) => {
		assert.match(e.message, /exchange returned 400 \(invalid_grant\)/);
		assert.match(e.message, /Run \/login again/);
		assert.ok(!e.message.includes("synthetic-sensitive-description"));
		return true;
	});
	assert.equal(f.calls.length, 1);
	const unknown = sequenceFetch([json({ error: "synthetic-secret-code" }, 400), new Response("synthetic-body", { status: 500 })]);
	await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: unknown.fetchImpl, clientSecret: secret }), (e: Error) => !e.message.includes("synthetic-secret") && /returned 400\./.test(e.message));
	await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: unknown.fetchImpl, clientSecret: secret }), (e: Error) => !e.message.includes("synthetic-body"));
});

const STORED: AgyCredentials = { access: "old-access", refresh: "synthetic-stored-refresh", expires: 0, projectId: "synthetic-project-1", tierId: "standard-tier", account_email: "user@example.test" };

test("refresh keeps the stored refresh token when none is returned and carries every extra field forward", async () => {
	const f = sequenceFetch([{ access_token: "new-access", expires_in: 3599, token_type: "Bearer" }]);
	const refreshed = await refreshCredentials(STORED, { fetchImpl: f.fetchImpl, clientSecret: secret, now: () => NOW });
	assert.deepEqual(form(f.calls[0].init), { grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: SECRET, refresh_token: "synthetic-stored-refresh" });
	assert.equal(refreshed.access, "new-access");
	assert.equal(refreshed.refresh, "synthetic-stored-refresh");
	assert.equal(refreshed.expires, NOW + 3_599_000 - 300_000);
	assert.equal(refreshed.projectId, "synthetic-project-1", "the project resolved at sign-in survives refresh");
	assert.equal(refreshed.tierId, "standard-tier");
	assert.equal(refreshed.account_email, "user@example.test");
});

test("refresh adopts a rotated refresh token when the server sends one", async () => {
	const f = sequenceFetch([{ access_token: "new-access", refresh_token: "synthetic-rotated-refresh", expires_in: 3599, token_type: "Bearer" }]);
	assert.equal((await refreshCredentials(STORED, { fetchImpl: f.fetchImpl, clientSecret: secret, now: () => NOW })).refresh, "synthetic-rotated-refresh");
});

test("a revoked refresh token fails once with guidance and without leaking it", async () => {
	const f = sequenceFetch([json({ error: "invalid_grant" }, 400)]);
	await assert.rejects(refreshCredentials(STORED, { fetchImpl: f.fetchImpl, clientSecret: secret }), (e: Error) => /invalid_grant.*\/login/.test(e.message) && !e.message.includes("synthetic-stored-refresh"));
	assert.equal(f.calls.length, 1);
});

// ---------------------------------------------------------------------------
// The client secret is supplied at run time and never committed.
// ---------------------------------------------------------------------------

