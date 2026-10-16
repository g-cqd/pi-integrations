import assert from "node:assert/strict";
import { test } from "bun:test";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createProviderConfig, PROVIDER_ID } from "../../src/domains/claude/provider.ts";
import type { FetchImplementation } from "../../src/domains/claude/oauth.ts";

const response = {
	token_type: "Bearer",
	access_token: "synthetic-access-token",
	refresh_token: "synthetic-refresh-token",
	expires_in: 28800,
	scope: "user:inference",
};
const code = "synthetic_authorization_code_123";

function fixture() {
	const calls: RequestInit[] = [];
	const fetchImpl: FetchImplementation = async (_input, init) => {
		calls.push(init ?? {});
		return Response.json(response);
	};
	const streamSimple: NonNullable<ProviderConfig["streamSimple"]> = () => {
		throw new Error("Streaming must not run during registration or login");
	};
	const config = createProviderConfig({ models: [], streamSimple, fetchImpl, env: {} });
	let state = "";
	const callbacks: OAuthLoginCallbacks = {
		onAuth: ({ url }) => { state = new URL(url).searchParams.get("state")!; },
		onPrompt: async () => `${code}#${state}`,
		onDeviceCode: () => { throw new Error("Device flow is not used"); },
		onSelect: async () => { throw new Error("Method selection is not used"); },
	};
	return { config, calls, callbacks, streamSimple };
}

test("registration adds no header overrides and preserves the supplied stream implementation", () => {
	const f = fixture();
	assert.equal(PROVIDER_ID, "claude-subscription");
	assert.equal(f.config.headers, undefined);
	assert.equal(f.config.streamSimple, f.streamSimple);
	assert.equal(f.calls.length, 0);
});

test("model catalog is supplied by the host rather than invented by the extension", () => {
	const models: NonNullable<ProviderConfig["models"]> = [{
		id: "synthetic-model", name: "Synthetic model", input: ["text"],
		reasoning: false, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000, maxTokens: 100,
	}];
	const f = fixture();
	const config = createProviderConfig({ models, streamSimple: f.streamSimple, env: {} });
	assert.deepEqual(config.models, models);
	assert.equal(models[0].cost.input, 1, "do not pretend estimated prices are actual zero billing");
});

test("login checks returned state and exchanges exactly one synthetic code", async () => {
	const f = fixture();
	const credentials = await f.config.oauth!.login(f.callbacks);
	assert.equal(credentials.access, response.access_token);
	assert.equal(f.calls.length, 1);
	const body = JSON.parse(String(f.calls[0].body));
	assert.equal(body.code, code);
	assert.match(body.state, /^[a-f0-9]{64}$/);
	assert.equal(body.code_verifier.length, 43);
});

test("login rejects a bare code before any credential request", async () => {
	const f = fixture();
	f.callbacks.onPrompt = async () => code;
	await assert.rejects(f.config.oauth!.login(f.callbacks), /state/i);
	assert.equal(f.calls.length, 0);
});

test("login rejects mismatched state without echoing the pasted value", async () => {
	const f = fixture();
	f.callbacks.onPrompt = async () => `${code}#synthetic-wrong-state`;
	await assert.rejects(f.config.oauth!.login(f.callbacks), (error: Error) => {
		assert.match(error.message, /state/i);
		assert.ok(!error.message.includes(code));
		return true;
	});
	assert.equal(f.calls.length, 0);
});

test("already cancelled login never opens the browser or invokes fetch", async () => {
	const f = fixture();
	const controller = new AbortController();
	controller.abort();
	f.callbacks.signal = controller.signal;
	f.callbacks.onAuth = () => { throw new Error("Browser must not open"); };
	await assert.rejects(f.config.oauth!.login(f.callbacks), { name: "AbortError" });
	assert.equal(f.calls.length, 0);
});

test("cancellation while waiting for pasted input prevents exchange", async () => {
	const f = fixture();
	const controller = new AbortController();
	f.callbacks.signal = controller.signal;
	const onPrompt = f.callbacks.onPrompt;
	f.callbacks.onPrompt = async (prompt) => {
		controller.abort();
		return onPrompt(prompt);
	};
	await assert.rejects(f.config.oauth!.login(f.callbacks), { name: "AbortError" });
	assert.equal(f.calls.length, 0);
});

test("each login gets a fresh independent state", async () => {
	const f = fixture();
	await f.config.oauth!.login(f.callbacks);
	await f.config.oauth!.login(f.callbacks);
	assert.notEqual(JSON.parse(String(f.calls[0].body)).state, JSON.parse(String(f.calls[1].body)).state);
});

test("refresh returns replacement credentials and uses the supplied abort signal", async () => {
	const f = fixture();
	const signal = new AbortController().signal;
	const credentials = await f.config.oauth!.refreshToken({ access: "old-access", refresh: "old-refresh", expires: 0 }, signal);
	assert.equal(credentials.refresh, response.refresh_token);
	assert.equal(JSON.parse(String(f.calls[0].body)).refresh_token, "old-refresh");
	assert.ok(f.calls[0].signal instanceof AbortSignal);
	assert.equal(f.config.oauth!.getApiKey(credentials), response.access_token);
});

test("sign-in is the only credential path: no API-key or token environment configuration is declared", () => {
	const f = fixture();
	assert.equal(f.config.apiKey, undefined);
	assert.ok(f.config.oauth);
});
