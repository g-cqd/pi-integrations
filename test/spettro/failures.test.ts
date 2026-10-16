import assert from "node:assert/strict";
import { test } from "bun:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai/compat";
import { createSpettroProvider } from "../../src/domains/spettro/provider.ts";
import { loginCallbacks, sequenceFetch, virtualClock } from "../support/fixtures.ts";

function fixture(responses: unknown[]) {
	const http = sequenceFetch(responses);
	const config = createSpettroProvider({ ...http, ...virtualClock(), env: {}, streamSimple: () => { throw new Error("Unexpected inference"); } });
	return { ...http, config };
}

function refreshContext(credential: RefreshModelsContext["credential"]): RefreshModelsContext {
	return { credential, allowNetwork: true, signal: new AbortController().signal, publish: async () => true };
}

test("Spettro catalog accepts a canonical API-key credential as well as browser-login credentials", async () => {
	const f = fixture([{ data: [{ id: "synthetic-model" }] }]);
	const models = await f.config.refreshModels!(refreshContext({ type: "api_key", key: "synthetic-env-key" }));
	assert.deepEqual(models.map(m => m.id), ["synthetic-model"]);
	assert.equal(new Headers(f.calls[0].init.headers).get("authorization"), "Bearer synthetic-env-key");
});

test("Spettro HTTP 404 device expiration is terminal and does not retry", async () => {
	const f = fixture([{ browser_url: "https://spettro.app/login" }, new Response("synthetic-private-key", { status: 404 })]);
	await assert.rejects(f.config.oauth!.login(loginCallbacks()), /expired/i);
	assert.equal(f.calls.length, 2);
});

test("Spettro catalog rejects HTTP 401 without echoing a secret body", async () => {
	const f = fixture([new Response("synthetic-private-key", { status: 401 })]);
	await assert.rejects(f.config.refreshModels!(refreshContext({ type: "oauth", access: "synthetic-key", refresh: "", expires: 0 })), (error: Error) => {
		assert.match(error.message, /401/);
		assert.ok(!error.message.includes("synthetic-private-key"));
		return true;
	});
});

test("Spettro compatibility refresh honors cancellation without network", async () => {
	const f = fixture([]);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(f.config.oauth!.refreshToken({ access: "synthetic-key", refresh: "", expires: 0 }, controller.signal), { name: "AbortError" });
	assert.equal(f.calls.length, 0);
});
