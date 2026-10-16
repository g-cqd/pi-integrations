import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import {
	BASE_URL, createCodexProvider, DISPLAY_NAME, METHOD_BROWSER, METHOD_DEVICE, PROVIDER_ID,
} from "../../src/domains/codex/provider.ts";
import { DEVICE_REDIRECT_URI, DEVICE_VERIFICATION_URI, REDIRECT_URI } from "../../src/domains/codex/oauth.ts";
import type { LoopbackOptions } from "../../src/shared/index.ts";
import { codexAccessToken } from "../support/jwt.ts";
import { loginCallbacks, sequenceFetch, virtualClock } from "../support/fixtures.ts";

const NOW = 1_800_000_000_000;
const CODE = "synthetic_authorization_code_123";
const token = (over: Record<string, unknown> = {}) => ({
	access_token: codexAccessToken(), refresh_token: "synthetic-refresh-token", expires_in: 864000, ...over,
});
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));

interface LoopbackPlan { unavailable?: boolean; never?: boolean; code?: string }
function fixture(responses: unknown[], plan: LoopbackPlan = {}) {
	const http = sequenceFetch(responses);
	const clock = virtualClock(NOW);
	const loopback = { started: undefined as LoopbackOptions | undefined, closed: 0 };
	const config = createCodexProvider({
		models: [], streamSimple: () => { throw new Error("Do not infer during login"); },
		fetchImpl: http.fetchImpl, ...clock,
		startLoopback: async (options) => {
			loopback.started = options;
			if (plan.unavailable) throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
			return {
				port: 1455,
				result: plan.never ? new Promise<string>(() => {}) : Promise.resolve(plan.code ?? CODE),
				close: () => { loopback.closed++; },
			};
		},
	});
	const auth: Array<{ url: string; instructions?: string }> = [];
	const devices: Array<Record<string, unknown>> = [];
	const prompts: string[] = [];
	const callbacks = loginCallbacks({
		onAuth: (info) => { auth.push(info); },
		onDeviceCode: (info) => { devices.push({ ...info }); },
		onPrompt: async (prompt) => { prompts.push(prompt.message); throw new Error("Unexpected prompt"); },
		onSelect: async () => METHOD_BROWSER,
	});
	return { config, calls: http.calls, callbacks, loopback, auth, devices, prompts };
}
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

test("sign-in is the only credential path, and it is declared as a subscription", () => {
	const f = fixture([]);
	assert.equal(PROVIDER_ID, "codex-subscription");
	assert.equal(f.config.name, DISPLAY_NAME);
	assert.equal(f.config.apiKey, undefined, "no API-key configuration");
	assert.equal(f.config.headers, undefined);
	assert.equal(f.config.baseUrl, BASE_URL);
	assert.equal(f.config.api, "openai-codex-responses");
	assert.equal(f.config.oauth?.isSubscription, true);
	assert.equal(f.calls.length, 0);
});

test("getApiKey hands the access token to the streamer, which reads the account id from it", () => {
	const f = fixture([]);
	assert.equal(f.config.oauth!.getApiKey({ access: "synthetic-access", refresh: "r", expires: 0 }), "synthetic-access");
});

// ---------------------------------------------------------------------------
// Browser sign-in
// ---------------------------------------------------------------------------

test("browser sign-in: loopback callback, PKCE-bound exchange, loopback closed, no prompt", async () => {
	const f = fixture([token()]);
	const credentials = await f.config.oauth!.login(f.callbacks);
	assert.equal(credentials.accountId, "acct_synthetic_123");
	assert.equal(f.calls.length, 1);
	assert.equal(f.loopback.started?.port, 1455);
	assert.equal(f.loopback.started?.path, "/auth/callback");
	assert.equal(f.loopback.started?.state, stateOf(f.auth[0].url), "the server checks the same state the URL carries");
	assert.match(f.auth[0].instructions!, /browser window/);
	const body = form(f.calls[0].init);
	assert.equal(body.code, CODE);
	assert.equal(body.redirect_uri, REDIRECT_URI);
	assert.equal(new URL(f.auth[0].url).searchParams.get("code_challenge"), createHash("sha256").update(body.code_verifier).digest("base64url"));
	assert.equal(f.loopback.closed, 1);
	assert.deepEqual(f.prompts, []);
});

test("each sign-in generates fresh state and PKCE material", async () => {
	const f = fixture([token(), token()]);
	await f.config.oauth!.login(f.callbacks);
	await f.config.oauth!.login(f.callbacks);
	assert.notEqual(stateOf(f.auth[0].url), stateOf(f.auth[1].url));
	assert.notEqual(form(f.calls[0].init).code_verifier, form(f.calls[1].init).code_verifier);
});

test("when the callback port is taken, sign-in falls back to a pasted redirect URL", async () => {
	const f = fixture([token()], { unavailable: true });
	f.callbacks.onPrompt = async (prompt) => {
		f.prompts.push(prompt.message);
		return `${REDIRECT_URI}?code=${CODE}&state=${stateOf(f.auth[0].url)}`;
	};
	const credentials = await f.config.oauth!.login(f.callbacks);
	assert.equal(credentials.accountId, "acct_synthetic_123");
	assert.match(f.auth[0].instructions!, /paste the full redirect URL/);
	assert.equal(f.prompts.length, 1);
	assert.equal(f.loopback.closed, 0, "nothing was bound, so nothing to close");
});

test("a pasted response with the wrong state is rejected before any credential request", async () => {
	const f = fixture([token()], { unavailable: true });
	f.callbacks.onPrompt = async () => `${CODE}#attacker-state`;
	await assert.rejects(f.config.oauth!.login(f.callbacks), (error: Error) => {
		assert.match(error.message, /state/i);
		assert.ok(!error.message.includes(CODE));
		return true;
	});
	assert.equal(f.calls.length, 0);
});

test("with a callback server and a host manual-input hook, the manual paste can win and the server is still closed", async () => {
	const f = fixture([token()], { never: true });
	f.callbacks.onManualCodeInput = async () => `${CODE}#${stateOf(f.auth[0].url)}`;
	const credentials = await f.config.oauth!.login(f.callbacks);
	assert.equal(credentials.accountId, "acct_synthetic_123");
	assert.equal(f.loopback.closed, 1);
	assert.deepEqual(f.prompts, [], "the manual hook replaces the blocking prompt");
});

test("the callback wins over a manual hook that never answers", async () => {
	const f = fixture([token()]);
	f.callbacks.onManualCodeInput = () => new Promise(() => {});
	await f.config.oauth!.login(f.callbacks);
	assert.equal(form(f.calls[0].init).code, CODE);
	assert.equal(f.loopback.closed, 1);
});

test("a failed exchange still closes the callback server and is not retried", async () => {
	const f = fixture([new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), /invalid_grant/);
	assert.equal(f.calls.length, 1);
	assert.equal(f.loopback.closed, 1);
});

test("an uncertain exchange failure is sanitized", async () => {
	const f = fixture([new Error("transport debug: synthetic-callback-secret")]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), (error: Error) => !error.message.includes("synthetic-callback-secret"));
});

// ---------------------------------------------------------------------------
// Method selection and cancellation
// ---------------------------------------------------------------------------

test("a host that cannot show a selection gets the browser flow", async () => {
	const f = fixture([token()]);
	f.callbacks.onSelect = async () => undefined;
	await f.config.oauth!.login(f.callbacks);
	assert.equal(f.auth.length, 1);
});

test("an unknown method fails before any request or server", async () => {
	const f = fixture([token()]);
	f.callbacks.onSelect = async () => "carrier-pigeon";
	await assert.rejects(f.config.oauth!.login(f.callbacks), /Unknown Codex sign-in method/);
	assert.equal(f.calls.length, 0);
	assert.equal(f.loopback.started, undefined);
});

test("an already-cancelled sign-in never selects, binds, opens a browser, or calls fetch", async () => {
	const f = fixture([token()]);
	const controller = new AbortController();
	controller.abort();
	f.callbacks.signal = controller.signal;
	f.callbacks.onSelect = async () => { throw new Error("must not select"); };
	await assert.rejects(f.config.oauth!.login(f.callbacks), { name: "AbortError" });
	assert.equal(f.calls.length, 0);
	assert.equal(f.loopback.started, undefined);
});

test("cancellation after the browser link prevents the exchange", async () => {
	const f = fixture([token()]);
	const controller = new AbortController();
	f.callbacks.signal = controller.signal;
	f.callbacks.onAuth = () => controller.abort();
	await assert.rejects(f.config.oauth!.login(f.callbacks), { name: "AbortError" });
	assert.equal(f.calls.length, 0);
	assert.equal(f.loopback.closed, 1);
});

// ---------------------------------------------------------------------------
// Device-code sign-in
// ---------------------------------------------------------------------------

const deviceStart = { device_auth_id: "deviceauth_synthetic", user_code: "ABCD-1234", interval: "5" };
const pending = () => new Response("", { status: 403 });
const approved = { authorization_code: "synthetic-auth-code", code_verifier: "synthetic-device-verifier" };

test("device sign-in shows the code, waits through pending, and exchanges with the device redirect", async () => {
	const f = fixture([deviceStart, pending(), pending(), approved, token()]);
	f.callbacks.onSelect = async () => METHOD_DEVICE;
	const credentials = await f.config.oauth!.login(f.callbacks);
	assert.equal(credentials.accountId, "acct_synthetic_123");
	assert.deepEqual(f.devices, [{ userCode: "ABCD-1234", verificationUri: DEVICE_VERIFICATION_URI, intervalSeconds: 5, expiresInSeconds: 900 }]);
	assert.equal(f.calls.length, 5);
	assert.deepEqual(form(f.calls[4].init), {
		grant_type: "authorization_code", client_id: "app_EMoamEEZ73f0CkXaXp7hrann", code: "synthetic-auth-code",
		code_verifier: "synthetic-device-verifier", redirect_uri: DEVICE_REDIRECT_URI,
	});
	assert.equal(f.loopback.started, undefined, "the device flow binds no port");
	assert.equal(f.auth.length, 0, "and opens no browser link");
});

test("device sign-in has a finite deadline without real sleeps", async () => {
	const f = fixture([deviceStart, ...Array.from({ length: 400 }, pending)]);
	f.callbacks.onSelect = async () => METHOD_DEVICE;
	await assert.rejects(f.config.oauth!.login(f.callbacks), /timed out/i);
	assert.ok(f.calls.length <= 182, `polled ${f.calls.length} times`);
});

test("device sign-in stops on a terminal server failure without exchanging", async () => {
	const f = fixture([deviceStart, new Response(JSON.stringify({ error: "expired_token" }), { status: 400 })]);
	f.callbacks.onSelect = async () => METHOD_DEVICE;
	await assert.rejects(f.config.oauth!.login(f.callbacks), /expired_token/);
	assert.equal(f.calls.length, 2);
});

test("device sign-in cancellation during the wait prevents any exchange", async () => {
	const f = fixture([deviceStart, pending(), approved, token()]);
	const controller = new AbortController();
	f.callbacks.signal = controller.signal;
	f.callbacks.onSelect = async () => METHOD_DEVICE;
	f.callbacks.onDeviceCode = () => controller.abort();
	await assert.rejects(f.config.oauth!.login(f.callbacks), { name: "AbortError" });
	assert.equal(f.calls.length, 1, "only the code request was sent");
});

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

test("refresh returns replacement credentials, never retries, and honors cancellation", async () => {
	const f = fixture([token({ refresh_token: "synthetic-next-refresh" })]);
	const credentials = await f.config.oauth!.refreshToken({ access: "old", refresh: "synthetic-old-refresh", expires: 0 }, new AbortController().signal);
	assert.equal(credentials.refresh, "synthetic-next-refresh");
	assert.equal(form(f.calls[0].init).refresh_token, "synthetic-old-refresh");
	assert.ok(f.calls[0].init.signal instanceof AbortSignal);

	const g = fixture([token()]);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(g.config.oauth!.refreshToken({ access: "a", refresh: "r", expires: 0 }, controller.signal), { name: "AbortError" });
	assert.equal(g.calls.length, 0);
});
