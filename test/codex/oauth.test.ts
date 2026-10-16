import assert from "node:assert/strict";
import { test } from "bun:test";
import {
	AUTHORIZE_URL, CLIENT_ID, DEVICE_REDIRECT_URI, DEVICE_TOKEN_URL, DEVICE_USER_CODE_URL, DEVICE_VERIFICATION_URI,
	REDIRECT_URI, SCOPE, TOKEN_URL, accountIdOf, buildAuthorizeUrl, exchangeAuthorizationCode, parseAuthorizationInput,
	pollDeviceAuthOnce, refreshCredentials, startDeviceAuth,
} from "../../src/domains/codex/oauth.ts";
import { codexAccessToken, syntheticJwt } from "../support/jwt.ts";
import { sequenceFetch } from "../support/fixtures.ts";

// Synthetic only: tokens are dummy JWTs, codes and ids are invented, no network.

const NOW = 1_800_000_000_000;
const STATE = "synthetic-state-abc123";
const CODE = "synthetic_authorization_code_123";
const tokenBody = (over: Record<string, unknown> = {}) => ({
	access_token: codexAccessToken(), refresh_token: "synthetic-refresh-token", expires_in: 864000, id_token: "ignored", ...over,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));

test("endpoints, client id, scope and redirect are explicit", () => {
	assert.equal(CLIENT_ID, "app_EMoamEEZ73f0CkXaXp7hrann");
	assert.equal(AUTHORIZE_URL, "https://auth.openai.com/oauth/authorize");
	assert.equal(TOKEN_URL, "https://auth.openai.com/oauth/token");
	assert.equal(REDIRECT_URI, "http://localhost:1455/auth/callback");
	assert.equal(SCOPE, "openid profile email offline_access");
	assert.equal(DEVICE_USER_CODE_URL, "https://auth.openai.com/api/accounts/deviceauth/usercode");
	assert.equal(DEVICE_TOKEN_URL, "https://auth.openai.com/api/accounts/deviceauth/token");
	assert.equal(DEVICE_VERIFICATION_URI, "https://auth.openai.com/codex/device");
	assert.equal(DEVICE_REDIRECT_URI, "https://auth.openai.com/deviceauth/callback");
});

test("authorization URL carries PKCE, state, scope and the Codex client parameters", () => {
	const url = new URL(buildAuthorizeUrl({ state: STATE, codeChallenge: "synthetic-challenge" }));
	assert.equal(url.origin + url.pathname, AUTHORIZE_URL);
	const q = Object.fromEntries(url.searchParams);
	assert.deepEqual(q, {
		response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
		code_challenge: "synthetic-challenge", code_challenge_method: "S256", state: STATE,
		id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "pi",
	});
});

// ---------------------------------------------------------------------------
// Pasted input
// ---------------------------------------------------------------------------

test("pasted redirect URL, code#state and code=&state= forms are accepted when state matches", () => {
	for (const input of [
		`${REDIRECT_URI}?code=${CODE}&state=${STATE}`,
		` ${REDIRECT_URI}?code=${CODE}&state=${STATE}\n`,
		`${CODE}#${STATE}`,
		`code=${CODE}&state=${STATE}`,
		`?code=${CODE}&state=${STATE}`,
	]) assert.deepEqual(parseAuthorizationInput(input, STATE), { code: CODE }, input);
});

for (const [label, input] of [
	["empty", ""],
	["bare code (no state to check)", CODE],
	["wrong state", `${CODE}#other-state`],
	["wrong state in URL", `${REDIRECT_URI}?code=${CODE}&state=other`],
	["missing state in URL", `${REDIRECT_URI}?code=${CODE}`],
	["foreign origin", `https://evil.example/auth/callback?code=${CODE}&state=${STATE}`],
	["wrong path", `http://localhost:1455/other?code=${CODE}&state=${STATE}`],
	["wrong port", `http://localhost:9999/auth/callback?code=${CODE}&state=${STATE}`],
	["userinfo in URL", `http://user:pw@localhost:1455/auth/callback?code=${CODE}&state=${STATE}`],
	["duplicate code", `${REDIRECT_URI}?code=${CODE}&code=other_code_12345&state=${STATE}`],
	["duplicate state", `${REDIRECT_URI}?code=${CODE}&state=${STATE}&state=${STATE}`],
	["provider error", `${REDIRECT_URI}?error=access_denied&state=${STATE}`],
	["too long", "a".repeat(5000)],
	["code too short", `short#${STATE}`],
	["extra hash segments", `${CODE}#${STATE}#more`],
] as const) {
	test(`pasted input is rejected: ${label}`, () => assert.equal(parseAuthorizationInput(input, STATE), null));
}

test("an empty expected state can never match", () => assert.equal(parseAuthorizationInput(`${CODE}#`, ""), null));

// ---------------------------------------------------------------------------
// Exchange and refresh
// ---------------------------------------------------------------------------

test("exchange sends one form-encoded request and maps validated credentials", async () => {
	const f = sequenceFetch([tokenBody()]);
	const credentials = await exchangeAuthorizationCode({ code: CODE, codeVerifier: "synthetic-verifier", fetchImpl: f.fetchImpl, now: () => NOW });
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].url, TOKEN_URL);
	assert.equal(new Headers(f.calls[0].init.headers).get("content-type"), "application/x-www-form-urlencoded");
	assert.deepEqual(form(f.calls[0].init), {
		grant_type: "authorization_code", client_id: CLIENT_ID, code: CODE, code_verifier: "synthetic-verifier", redirect_uri: REDIRECT_URI,
	});
	assert.equal(credentials.refresh, "synthetic-refresh-token");
	assert.equal(credentials.accountId, "acct_synthetic_123");
	assert.equal(credentials.expires, NOW + 864_000_000 - 300_000, "five-minute safety margin");
});

test("exchange honors a device-flow redirect URI", async () => {
	const f = sequenceFetch([tokenBody()]);
	await exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", redirectUri: DEVICE_REDIRECT_URI, fetchImpl: f.fetchImpl, now: () => NOW });
	assert.equal(form(f.calls[0].init).redirect_uri, DEVICE_REDIRECT_URI);
});

test("exchange errors expose only an allowlisted code, never the provider description", async () => {
	const f = sequenceFetch([json({ error: "invalid_grant", error_description: "synthetic-sensitive-description" }, 400)]);
	await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: f.fetchImpl }), (error: Error) => {
		assert.match(error.message, /exchange returned 400 \(invalid_grant\)/);
		assert.match(error.message, /Run \/login again/);
		assert.ok(!error.message.includes("synthetic-sensitive-description"));
		return true;
	});
	assert.equal(f.calls.length, 1, "no retry of a single-use grant");
});

test("unknown error codes and nested error objects are handled without echoing", async () => {
	const unknown = sequenceFetch([json({ error: "synthetic-secret-code-xyz" }, 400)]);
	await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: unknown.fetchImpl }), (e: Error) => !e.message.includes("synthetic-secret") && /returned 400\./.test(e.message));
	const nested = sequenceFetch([json({ error: { code: "refresh_token_reused", message: "synthetic-detail" } }, 401)]);
	await assert.rejects(refreshCredentials({ refresh: "r" }, { fetchImpl: nested.fetchImpl }), (e: Error) => /refresh returned 401 \(refresh_token_reused\)/.test(e.message) && !e.message.includes("synthetic-detail"));
});

for (const [label, body] of [
	["no account-id claim", tokenBody({ access_token: codexAccessToken(null) })],
	["account id with illegal characters", tokenBody({ access_token: codexAccessToken("bad id!") })],
	["account claim of the wrong type", tokenBody({ access_token: syntheticJwt({ "https://api.openai.com/auth": { chatgpt_account_id: 42 } }) })],
	["opaque (non-JWT) access token", tokenBody({ access_token: "not-a-jwt" })],
] as const) {
	test(`credentials are refused: ${label}`, async () => {
		const f = sequenceFetch([body]);
		await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: f.fetchImpl }), /without a ChatGPT account id/);
	});
}

for (const [label, patch] of [
	["missing refresh token", { refresh_token: undefined }],
	["refresh token with whitespace", { refresh_token: "has space" }],
	["empty access token", { access_token: "" }],
	["non-numeric expires_in", { expires_in: "3600" }],
	["zero lifetime", { expires_in: 0 }],
	["negative lifetime", { expires_in: -5 }],
] as const) {
	test(`token response is refused: ${label}`, async () => {
		const f = sequenceFetch([tokenBody(patch)]);
		await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: f.fetchImpl }), /Invalid (credential response|token lifetime)/);
	});
}

test("malformed and non-object success bodies are rejected without exposure", async () => {
	for (const response of [new Response("synthetic-secret-body"), json([1, 2]), json(null)]) {
		const f = sequenceFetch([response]);
		await assert.rejects(exchangeAuthorizationCode({ code: CODE, codeVerifier: "v", fetchImpl: f.fetchImpl }), (e: Error) => !e.message.includes("synthetic-secret") && /Invalid credential response/.test(e.message));
	}
});

test("refresh returns replacement credentials and sends the refresh grant", async () => {
	const rotated = codexAccessToken("acct_rotated_456");
	const f = sequenceFetch([tokenBody({ access_token: rotated, refresh_token: "synthetic-next-refresh" })]);
	const credentials = await refreshCredentials({ refresh: "synthetic-old-refresh" }, { fetchImpl: f.fetchImpl, now: () => NOW });
	assert.deepEqual(form(f.calls[0].init), { grant_type: "refresh_token", refresh_token: "synthetic-old-refresh", client_id: CLIENT_ID });
	assert.equal(credentials.access, rotated);
	assert.equal(credentials.refresh, "synthetic-next-refresh");
	assert.equal(credentials.accountId, "acct_rotated_456");
});

test("an invalid refresh grant fails once, with recovery guidance and no retry", async () => {
	const f = sequenceFetch([json({ error: "invalid_grant" }, 400)]);
	await assert.rejects(refreshCredentials({ refresh: "r" }, { fetchImpl: f.fetchImpl }), /invalid_grant.*\/login/);
	assert.equal(f.calls.length, 1);
});

test("transport failures do not leak the refresh token and are not retried", async () => {
	const f = sequenceFetch([new Error("transport debug: synthetic-refresh-secret")]);
	await assert.rejects(refreshCredentials({ refresh: "synthetic-refresh-secret" }, { fetchImpl: f.fetchImpl }), (e: Error) => !e.message.includes("synthetic-refresh-secret"));
	assert.equal(f.calls.length, 1);
});

test("account ids are read from base64url JWT claims", () => {
	assert.equal(accountIdOf(codexAccessToken("acct_ünï_??>>".replace(/[^A-Za-z0-9._-]/g, "x"))), "acct_xnx_xxxx");
	assert.equal(accountIdOf(codexAccessToken("acct_synthetic_123")), "acct_synthetic_123");
	assert.equal(accountIdOf("a.b.c"), undefined);
});

// ---------------------------------------------------------------------------
// Device flow
// ---------------------------------------------------------------------------

test("device start posts the client id and validates the response", async () => {
	const f = sequenceFetch([json({ device_auth_id: "deviceauth_synthetic", user_code: "ABCD-1234", interval: "5" })]);
	const device = await startDeviceAuth({ fetchImpl: f.fetchImpl });
	assert.deepEqual(device, { deviceAuthId: "deviceauth_synthetic", userCode: "ABCD-1234", intervalSeconds: 5 });
	assert.equal(f.calls[0].url, DEVICE_USER_CODE_URL);
	assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { client_id: CLIENT_ID });
});

test("the polling interval is clamped so a hostile server cannot cause a busy loop or an endless wait", async () => {
	for (const [raw, expected] of [[0, 1], [0.2, 1], [5, 5], ["7", 7], [600, 60]] as const) {
		const f = sequenceFetch([json({ device_auth_id: "d", user_code: "ABC-123", interval: raw })]);
		assert.equal((await startDeviceAuth({ fetchImpl: f.fetchImpl })).intervalSeconds, expected, String(raw));
	}
});

test("device start failures are specific and bounded", async () => {
	await assert.rejects(startDeviceAuth({ fetchImpl: sequenceFetch([new Response("x", { status: 404 })]).fetchImpl }), /not enabled for this server/);
	await assert.rejects(startDeviceAuth({ fetchImpl: sequenceFetch([new Response("synthetic-secret", { status: 500 })]).fetchImpl }), (e: Error) => /returned 500/.test(e.message) && !e.message.includes("synthetic-secret"));
	for (const bad of [null, {}, { device_auth_id: "d" }, { device_auth_id: "d", user_code: "ABC-123" }, { device_auth_id: "d", user_code: "ABC-123", interval: -1 },
		{ device_auth_id: "bad id!", user_code: "ABC-123", interval: 5 }, { device_auth_id: "d", user_code: "has space", interval: 5 }, { device_auth_id: "d", user_code: "ABC-123", interval: "soon" }]) {
		await assert.rejects(startDeviceAuth({ fetchImpl: sequenceFetch([json(bad)]).fetchImpl }), /Invalid Codex device-code response/, JSON.stringify(bad));
	}
});

const DEVICE = { deviceAuthId: "deviceauth_synthetic", userCode: "ABCD-1234", intervalSeconds: 5 };

test("device poll posts the id and code and maps approval to the grant", async () => {
	const f = sequenceFetch([json({ authorization_code: "synthetic-auth-code", code_verifier: "synthetic-verifier" })]);
	assert.deepEqual(await pollDeviceAuthOnce(DEVICE, { fetchImpl: f.fetchImpl }), {
		state: "complete", value: { authorizationCode: "synthetic-auth-code", codeVerifier: "synthetic-verifier" },
	});
	assert.equal(f.calls[0].url, DEVICE_TOKEN_URL);
	assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { device_auth_id: "deviceauth_synthetic", user_code: "ABCD-1234" });
});

test("403, 404 and the pending error code all mean not approved yet; slow_down is surfaced", async () => {
	for (const response of [new Response("", { status: 403 }), new Response("", { status: 404 }), json({ error: "deviceauth_authorization_pending" }, 400), json({ error: { code: "deviceauth_authorization_pending" } }, 400)]) {
		assert.deepEqual(await pollDeviceAuthOnce(DEVICE, { fetchImpl: sequenceFetch([response]).fetchImpl }), { state: "pending" });
	}
	assert.deepEqual(await pollDeviceAuthOnce(DEVICE, { fetchImpl: sequenceFetch([json({ error: "slow_down" }, 400)]).fetchImpl }), { state: "pending", slowDown: true });
});

test("a malformed approval and any other failure are terminal and never echo the body", async () => {
	await assert.rejects(pollDeviceAuthOnce(DEVICE, { fetchImpl: sequenceFetch([json({ authorization_code: "x" })]).fetchImpl }), /Invalid Codex device-code token response/);
	await assert.rejects(pollDeviceAuthOnce(DEVICE, { fetchImpl: sequenceFetch([json({ error: "expired_token", error_description: "synthetic-detail" }, 400)]).fetchImpl }), (e: Error) => /status 400 \(expired_token\)/.test(e.message) && !e.message.includes("synthetic-detail"));
	await assert.rejects(pollDeviceAuthOnce(DEVICE, { fetchImpl: sequenceFetch([new Response("synthetic-secret", { status: 500 })]).fetchImpl }), (e: Error) => /status 500/.test(e.message) && !e.message.includes("synthetic-secret"));
});
