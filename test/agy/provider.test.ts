import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai/compat";
import { CATALOG_PLACEHOLDER, createAgyProvider, DISPLAY_NAME, PROVIDER_ID, toModelConfig } from "../../src/domains/agy/provider.ts";
import { API_ID, decodeApiKey } from "../../src/domains/agy/stream.ts";
import { DEFAULT_BASE_URL } from "../../src/domains/agy/cloudcode.ts";
import { CLIENT_ID, REDIRECT_URI } from "../../src/domains/agy/oauth.ts";
import { loginCallbacks, sequenceFetch, virtualClock } from "../support/fixtures.ts";

// Synthetic only. The secret is a made-up placeholder; ids and tokens are invented.

const NOW = 1_800_000_000_000;
const SECRET = "synthetic-client-secret-value";
const CODE = "4/synthetic_authorization_code_value";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const token = (over: Record<string, unknown> = {}) => ({
	access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token", expires_in: 3599, token_type: "Bearer", scope: "openid", ...over,
});
const account = { cloudaicompanionProject: "synthetic-project-123", currentTier: { id: "standard-tier", name: "Standard" } };
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));

function fixture(responses: unknown[] = [], secret: (() => string | undefined) = () => SECRET) {
	const http = sequenceFetch(responses);
	const streams: unknown[][] = [];
	const config = createAgyProvider({
		env: {}, fetchImpl: http.fetchImpl, ...virtualClock(NOW), now: () => NOW, clientSecret: secret,
		streamSimple: ((...args: unknown[]) => { streams.push(args); return { sentinel: true } as never; }) as never,
	});
	const auth: Array<{ url: string; instructions?: string }> = [];
	const prompts: string[] = [];
	const callbacks = loginCallbacks({
		onAuth: (info) => { auth.push(info); },
		onPrompt: async (prompt) => { prompts.push(prompt.message); return CODE; },
	});
	return { config, calls: http.calls, callbacks, auth, prompts, streams };
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

test("sign-in is the only credential path, declared as a subscription, with a placeholder catalog until a live refresh", () => {
	const f = fixture();
	assert.equal(PROVIDER_ID, "agy-subscription");
	assert.equal(f.config.name, DISPLAY_NAME);
	assert.equal(f.config.apiKey, undefined, "no API-key configuration");
	assert.equal(f.config.headers, undefined);
	assert.equal(f.config.api, API_ID);
	assert.equal(f.config.baseUrl, DEFAULT_BASE_URL);
	assert.equal(f.config.oauth?.isSubscription, true);
	assert.deepEqual(f.config.models?.map((m) => m.id), [CATALOG_PLACEHOLDER]);
	assert.equal(f.calls.length, 0, "registration makes no request");
});

test("the endpoint can be pointed at production, and an unsafe override fails at registration", () => {
	assert.equal(createAgyProvider({ env: { AGY_API_URL: "https://cloudcode-pa.googleapis.com" }, clientSecret: () => SECRET }).baseUrl, "https://cloudcode-pa.googleapis.com");
	assert.throws(() => createAgyProvider({ env: { AGY_API_URL: "http://plain.example" } }), /Unsafe/);
});

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

test("a missing client secret stops sign-in before the browser link, any prompt, or any request", async () => {
	const f = fixture([token(), account], () => undefined);
	await assert.rejects(f.config.oauth!.login(f.callbacks), /AGY_OAUTH_CLIENT_SECRET/);
	assert.equal(f.auth.length, 0);
	assert.deepEqual(f.prompts, []);
	assert.equal(f.calls.length, 0);
});

test("sign-in: link with PKCE, paste, exchange, then project lookup stored with the credential", async () => {
	const f = fixture([token(), account]);
	const credentials = await f.config.oauth!.login(f.callbacks);
	assert.equal(credentials.access, "synthetic-access-token");
	assert.equal(credentials.refresh, "synthetic-refresh-token");
	assert.equal(credentials.projectId, "synthetic-project-123");
	assert.equal(credentials.tierId, "standard-tier");
	assert.equal(credentials.expires, NOW + 3_599_000 - 300_000);
	assert.equal(f.calls.length, 2);

	const link = new URL(f.auth[0].url);
	assert.equal(link.searchParams.get("client_id"), CLIENT_ID);
	assert.equal(link.searchParams.get("redirect_uri"), REDIRECT_URI);
	assert.equal(link.searchParams.get("code_challenge_method"), "S256");
	const exchange = form(f.calls[0].init);
	assert.equal(exchange.code, CODE);
	assert.equal(exchange.client_secret, SECRET);
	assert.equal(link.searchParams.get("code_challenge"), createHash("sha256").update(exchange.code_verifier).digest("base64url"));
	assert.match(f.calls[1].url, /\/v1internal:loadCodeAssist$/);
	assert.equal(new Headers(f.calls[1].init.headers).get("authorization"), "Bearer synthetic-access-token");
	assert.ok(!JSON.stringify(credentials).includes(SECRET));
});

test("a pasted redirect URL with matching state works; a mismatched one is rejected before any request", async () => {
	const ok = fixture([token(), account]);
	ok.callbacks.onPrompt = async () => `${REDIRECT_URI}?code=${encodeURIComponent(CODE)}&state=${new URL(ok.auth[0].url).searchParams.get("state")}`;
	assert.equal((await ok.config.oauth!.login(ok.callbacks)).projectId, "synthetic-project-123");

	const bad = fixture([token(), account]);
	bad.callbacks.onPrompt = async () => `${REDIRECT_URI}?code=${encodeURIComponent(CODE)}&state=attacker-state`;
	await assert.rejects(bad.config.oauth!.login(bad.callbacks), (e: Error) => /Invalid authorization response/.test(e.message) && !e.message.includes(CODE));
	assert.equal(bad.calls.length, 0);
});

test("each sign-in gets fresh state and PKCE material", async () => {
	const f = fixture([token(), account, token(), account]);
	await f.config.oauth!.login(f.callbacks);
	await f.config.oauth!.login(f.callbacks);
	assert.notEqual(new URL(f.auth[0].url).searchParams.get("state"), new URL(f.auth[1].url).searchParams.get("state"));
	assert.notEqual(form(f.calls[0].init).code_verifier, form(f.calls[2].init).code_verifier);
});

test("an account with no Cloud Code project fails sign-in with onboarding guidance instead of storing a useless credential", async () => {
	const f = fixture([token(), { currentTier: { id: "free-tier", name: "Free" } }]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), /Finish onboarding once in the `agy` CLI/);
});

test("a failed exchange is sanitized and not retried, and cancellation never reaches the network", async () => {
	const f = fixture([json({ error: "invalid_grant", error_description: "synthetic-detail" }, 400)]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), (e: Error) => /invalid_grant/.test(e.message) && !e.message.includes("synthetic-detail"));
	assert.equal(f.calls.length, 1);

	const g = fixture([token(), account]);
	const controller = new AbortController();
	g.callbacks.signal = controller.signal;
	g.callbacks.onAuth = () => controller.abort();
	await assert.rejects(g.config.oauth!.login(g.callbacks), { name: "AbortError" });
	assert.equal(g.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Refresh and key packing
// ---------------------------------------------------------------------------

test("refresh renews the token, keeps the project, and honors cancellation", async () => {
	const f = fixture([{ access_token: "new-access", expires_in: 3599, token_type: "Bearer" }]);
	const stored = { access: "old", refresh: "synthetic-stored-refresh", expires: 0, projectId: "synthetic-project-123", tierId: "standard-tier" };
	const refreshed = await f.config.oauth!.refreshToken(stored, new AbortController().signal);
	assert.equal(refreshed.access, "new-access");
	assert.equal(refreshed.refresh, "synthetic-stored-refresh");
	assert.equal(refreshed.projectId, "synthetic-project-123");
	assert.equal(form(f.calls[0].init).client_secret, SECRET);

	const g = fixture([token()]);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(g.config.oauth!.refreshToken(stored, controller.signal), { name: "AbortError" });
	assert.equal(g.calls.length, 0);
});

test("getApiKey packs the project with the token for the streamer; without a project the stream refuses", () => {
	const f = fixture();
	const withProject = f.config.oauth!.getApiKey({ access: "tok-1", refresh: "r", expires: 0, projectId: "synthetic-project-123" });
	assert.deepEqual(decodeApiKey(withProject), { token: "tok-1", projectId: "synthetic-project-123" });
	const without = f.config.oauth!.getApiKey({ access: "tok-1", refresh: "r", expires: 0 });
	assert.throws(() => decodeApiKey(without), /no Cloud Code project/);
});

// ---------------------------------------------------------------------------
// Live catalog
// ---------------------------------------------------------------------------

const ctx = (credential: unknown, allowNetwork = true): RefreshModelsContext =>
	({ credential, allowNetwork, signal: new AbortController().signal, publish: async () => true }) as never;
const live = { access: "synthetic-access-token", refresh: "r", expires: 0, projectId: "synthetic-project-123" };
const details = (over: Record<string, unknown> = {}) => ({ displayName: "Synthetic", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, ...over });

test("a refresh that cannot run keeps the placeholder visible and makes no request", async () => {
	const f = fixture();
	for (const c of [ctx(live, false), ctx(undefined), ctx({ type: "api_key", key: "k" }), ctx({ ...live, projectId: undefined }), ctx({ ...live, access: "" })]) {
		assert.deepEqual((await f.config.refreshModels!(c)).map((m) => m.id), [CATALOG_PLACEHOLDER]);
	}
	assert.equal(f.calls.length, 0);
});

test("the live catalog is mapped from the server's own fields, default first, nothing invented", async () => {
	const f = fixture([{
		models: { "m-low": details({ displayName: "M (Low)", supportsImages: false }), "m-high": details({ displayName: "M (High)", maxTokens: undefined, maxOutputTokens: undefined, preview: true }) },
		defaultAgentModelId: "m-high",
	}]);
	const models = await f.config.refreshModels!(ctx(live));
	assert.deepEqual(models.map((m) => m.id), ["m-high", "m-low"]);
	assert.deepEqual(models[1], {
		id: "m-low", name: "M (Low)", api: API_ID, baseUrl: DEFAULT_BASE_URL, input: ["text"], reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 65536,
	});
	assert.equal(models[0].name, "M (High) (preview)");
	assert.equal((models[0] as { contextWindow: number }).contextWindow, 128000, "a documented fallback, not a verified limit, when the server reports none");
	assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { project: "synthetic-project-123" });
});

test("an empty catalog keeps the placeholder, and an HTTP failure surfaces sanitized", async () => {
	const empty = fixture([{ models: {} }]);
	assert.deepEqual((await empty.config.refreshModels!(ctx(live))).map((m) => m.id), [CATALOG_PLACEHOLDER]);
	const denied = fixture([json({ error: { status: "UNAUTHENTICATED", message: "bad ya29.leak" } }, 401)]);
	await assert.rejects(denied.config.refreshModels!(ctx(live)), (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes("leak"));
});

test("toModelConfig maps images and thinking flags", () => {
	const model = toModelConfig({ id: "x", displayName: "X", supportsImages: false, supportsThinking: false, recommended: false, preview: false }, DEFAULT_BASE_URL);
	assert.deepEqual([model.input, (model as { reasoning: boolean }).reasoning], [["text"], false]);
});

// ---------------------------------------------------------------------------
// Streaming delegation
// ---------------------------------------------------------------------------

test("the placeholder can never be sent; real models delegate with the caller's context and options untouched", () => {
	const f = fixture();
	assert.throws(() => f.config.streamSimple!({ id: CATALOG_PLACEHOLDER } as never, { messages: [] } as never), /catalog not loaded/);
	assert.equal(f.streams.length, 0);
	const context = { messages: [] } as never;
	const options = { apiKey: "k" } as never;
	const model = { id: "m-low" } as never;
	assert.deepEqual(f.config.streamSimple!(model, context, options), { sentinel: true });
	assert.equal(f.streams[0][0], model);
	assert.equal(f.streams[0][1], context);
	assert.equal(f.streams[0][2], options);
});
