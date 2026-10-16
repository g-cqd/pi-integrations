import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import {
	AUTHORIZE_URL, CLIENT_ID, REDIRECT_URI, SCOPES, TOKEN_URL,
	buildAuthorizeUrl, exchangeAuthorizationCode, generatePKCE,
	parseAuthorizationCode, refreshCredentials, revokeCredentials,
	toCredentials, type TokenResponse, type FetchImplementation,
} from "../../src/domains/claude/oauth.ts";

// Every credential, authorization code, and account field in this file is synthetic.
const token: TokenResponse = {
	token_type: "Bearer", access_token: "synthetic-access-A", refresh_token: "synthetic-refresh-B",
	expires_in: 28800, refresh_token_expires_in: 2592000,
	scope: "user:inference user:profile",
	organization: { name: "Synthetic organization" },
	account: { email_address: "user@example.test" },
};
const code = "synthetic_authorization_code_123";
const state = "synthetic_state_123";
const verifier = "synthetic_pkce_verifier_000000000000000000000";

function mock(status: number, body: unknown) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl: FetchImplementation = async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		return Response.json(body, { status });
	};
	return { calls, fetchImpl };
}

test("OAuth endpoints and requested scopes are explicit", () => {
	assert.equal(AUTHORIZE_URL, "https://claude.com/cai/oauth/authorize");
	assert.equal(TOKEN_URL, "https://platform.claude.com/v1/oauth/token");
	assert.equal(REDIRECT_URI, "https://platform.claude.com/oauth/code/callback");
	assert.equal(CLIENT_ID, "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
	assert.ok(SCOPES.split(" ").includes("user:inference"));
	assert.ok(SCOPES.split(" ").includes("org:create_api_key"), "broad permission must remain visible to reviewers");
});

test("PKCE produces a fresh verifier and its S256 challenge", async () => {
	const first = await generatePKCE();
	assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(first.challenge, createHash("sha256").update(first.verifier).digest("base64url"));
	assert.notEqual((await generatePKCE()).verifier, first.verifier);
});

test("authorization URL includes PKCE, state, and the manual code flow", () => {
	const url = new URL(buildAuthorizeUrl({ state, codeChallenge: "synthetic-challenge" }));
	assert.equal(url.origin + url.pathname, AUTHORIZE_URL);
	assert.equal(url.searchParams.get("state"), state);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("code_challenge"), "synthetic-challenge");
	assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
	assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
	assert.equal(url.searchParams.get("response_type"), "code");
	assert.equal(url.searchParams.get("code"), "true");
	assert.equal(url.searchParams.get("scope"), SCOPES);
	assert.ok(!url.searchParams.has("orgUUID"));
});

test("optional organization and login hint are encoded as URL parameters", () => {
	const url = new URL(buildAuthorizeUrl({ state, codeChallenge: "challenge", orgUUID: "synthetic-org", loginHint: "user+test@example.test" }));
	assert.equal(url.searchParams.get("orgUUID"), "synthetic-org");
	assert.equal(url.searchParams.get("login_hint"), "user+test@example.test");
});

test("code#state parsing retains both parts", () => {
	assert.deepEqual(parseAuthorizationCode(` ${code}#${state}\n`, state), { code, state });
});

test("bare-code low-level parsing does not bypass mandatory login state", () => {
	assert.deepEqual(parseAuthorizationCode(code), { code });
	assert.equal(parseAuthorizationCode(code, state), null);
});

test("approved callback query and success fragment forms preserve state", () => {
	for (const input of [
		`https://platform.claude.com/oauth/code/callback?code=${code}&state=${state}`,
		`https://platform.claude.com/oauth/code/success#code=${code}&state=${state}`,
	]) assert.deepEqual(parseAuthorizationCode(input, state), { code, state });
});

test("one unambiguous code pair can be extracted from surrounding instructions", () => {
	assert.deepEqual(parseAuthorizationCode(`Your authorization code is ${code}#${state} — paste into pi`, state), { code, state });
});

test("garbage authorization input is rejected", () => {
	for (const input of ["", "short", "not a valid code!!"]) assert.equal(parseAuthorizationCode(input), null);
});

test("code exchange sends one JSON request and maps validated credentials", async () => {
	const f = mock(200, token);
	const result = await exchangeAuthorizationCode({ code, codeVerifier: verifier, state, fetchImpl: f.fetchImpl });
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].url, TOKEN_URL);
	assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), {
		grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
		client_id: CLIENT_ID, code_verifier: verifier, state,
	});
	assert.equal(new Headers(f.calls[0].init.headers).get("content-type"), "application/json");
	assert.equal(result.access, token.access_token);
	assert.equal(result.refresh, token.refresh_token);
});

test("code exchange returns allowlisted errors, not arbitrary response descriptions", async () => {
	const f = mock(400, { error: "invalid_grant", error_description: "synthetic-sensitive-description" });
	await assert.rejects(exchangeAuthorizationCode({ code, codeVerifier: verifier, state, fetchImpl: f.fetchImpl }), (error: Error) => {
		assert.match(error.message, /400.*invalid_grant/);
		assert.ok(!error.message.includes("synthetic-sensitive-description"));
		return true;
	});
});

test("refresh returns both rotated tokens", async () => {
	const rotated = { ...token, access_token: "synthetic-next-access", refresh_token: "synthetic-next-refresh" };
	const f = mock(200, rotated);
	const result = await refreshCredentials({ refresh: token.refresh_token }, f);
	assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), {
		grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: CLIENT_ID,
	});
	assert.equal(result.access, rotated.access_token);
	assert.equal(result.refresh, rotated.refresh_token);
});

test("invalid refresh grants fail without retry", async () => {
	const f = mock(400, { error: "invalid_grant" });
	await assert.rejects(refreshCredentials({ refresh: token.refresh_token }, f), /invalid_grant/);
	assert.equal(f.calls.length, 1);
});

test("revoke helper posts a refresh-token revocation request", async () => {
	const f = mock(200, {});
	await revokeCredentials(token.refresh_token, f);
	assert.equal(f.calls[0].url, "https://platform.claude.com/v1/oauth/token/revoke");
	assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), {
		token: token.refresh_token, token_type_hint: "refresh_token", client_id: CLIENT_ID,
	});
});

test("credential mapping includes bounded expiry margin and optional account metadata", () => {
	const before = Date.now();
	const credentials = toCredentials(token);
	assert.ok(Math.abs(credentials.expires - (before + 28800000 - 300000)) < 2000);
	assert.equal(credentials.account_email, "user@example.test");
	assert.equal(credentials.org_name, "Synthetic organization");
	assert.equal(credentials.scopes, token.scope);
});
