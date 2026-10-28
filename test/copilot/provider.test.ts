import assert from "node:assert/strict";
import { test } from "bun:test";
import { createAssistantMessageEventStream, normalizeContext, type RefreshModelsContext } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createCopilotProvider, API_ID, CATALOG_PLACEHOLDER, PROVIDER_ID } from "../../src/domains/copilot/provider.ts";
import { CLIENT_ID, DEFAULT_API_URL } from "../../src/domains/copilot/protocol.ts";
import { loginCallbacks, sequenceFetch, virtualClock } from "../support/fixtures.ts";

const NOW = 1_800_000_000_000;
const device = { device_code: "synthetic-device", user_code: "TEST-CODE", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 600 };
const envelope = (over: Record<string, unknown> = {}) => ({ token: "synthetic-copilot", expires_at: NOW / 1000 + 1800, refresh_in: 1200, endpoints: { api: "https://api.individual.githubcopilot.com" }, ...over });
const model = (id = "synthetic-model", endpoints = ["/chat/completions"]) => ({
	id, name: id, model_picker_enabled: true, policy: { state: "enabled" }, supported_endpoints: endpoints,
	capabilities: { type: "chat", limits: { max_prompt_tokens: 32000, max_output_tokens: 4096 }, supports: { tool_calls: true, streaming: true, vision: true } },
});
function fixture(responses: unknown[] = []) {
	const http = sequenceFetch(responses);
	const clock = virtualClock(NOW);
	const calls: Parameters<NonNullable<ProviderConfig["streamSimple"]>>[] = [];
	const stream = createAssistantMessageEventStream(); stream.end();
	const config = createCopilotProvider({ ...http, ...clock, streamSimple: (...args) => { calls.push(args); return stream; } });
	return { ...http, clock, config, streams: calls, stream };
}
async function login(f: ReturnType<typeof fixture>) { return f.config.oauth!.login(loginCallbacks()); }
function catalogContext(credential: unknown, allowNetwork = true, stored?: unknown) {
	const published: unknown[] = [];
	return { context: { credential, allowNetwork, stored, signal: new AbortController().signal, publish: async (value: { update?: () => void }) => { published.push(value); value.update?.(); return true; } } as RefreshModelsContext, published };
}

test("Copilot registration is offline, separate from the built-in provider, and sign-in only", () => {
	const f = fixture();
	assert.equal(PROVIDER_ID, "copilot-vscode");
	assert.equal(f.config.baseUrl, DEFAULT_API_URL);
	assert.equal(f.config.apiKey, undefined);
	assert.equal(f.config.headers, undefined);
	assert.equal(f.config.oauth!.isSubscription, true);
	assert.deepEqual(f.config.models!.map(m => m.id), [CATALOG_PLACEHOLDER]);
	assert.equal(f.calls.length, 0);
});

test("device login uses the source-published VS Code OAuth app and minimum Copilot scope", async () => {
	const f = fixture([device, { error: "authorization_pending" }, { access_token: "synthetic-github" }, envelope()]);
	const shown: unknown[] = [];
	const credential = await f.config.oauth!.login(loginCallbacks({ onDeviceCode: info => { shown.push(info); } }));
	assert.equal(shown.length, 1);
	assert.equal(credential.refresh, "synthetic-github");
	assert.equal(credential.access, "synthetic-copilot");
	assert.equal(credential.apiUrl, "https://api.individual.githubcopilot.com");
	assert.equal(credential.expires, NOW + 10000 + 1200000);
	const form = new URLSearchParams(String(f.calls[0].init.body));
	assert.equal(form.get("client_id"), CLIENT_ID);
	assert.equal(form.get("scope"), "user:email");
	assert.equal(f.calls[3].url, "https://api.github.com/copilot_internal/v2/token");
	assert.equal(new Headers(f.calls[3].init.headers).get("authorization"), "token synthetic-github");
	assert.ok(f.calls.every(call => call.init.redirect === "error"));
});

test("device polling honors slow_down and never displays an untrusted verification URL", async () => {
	const f = fixture([device, { error: "slow_down" }, { access_token: "synthetic-github" }, envelope()]);
	await login(f);
	assert.equal(f.clock.now(), NOW + 15000);
	for (const uri of ["https://attacker.example/login/device", "http://github.com/login/device", "https://github.com/login/device-evil"]) {
		const bad = fixture([{ ...device, verification_uri: uri }]);
		let shown = false;
		await assert.rejects(bad.config.oauth!.login(loginCallbacks({ onDeviceCode: () => { shown = true; } })));
		assert.equal(shown, false);
		assert.equal(bad.calls.length, 1);
	}
});

test("denied login and cancellation stop polling without leaking provider descriptions", async () => {
	const f = fixture([device, { error: "access_denied", error_description: "synthetic-private-detail" }]);
	await assert.rejects(login(f), (e: Error) => /access_denied/.test(e.message) && !e.message.includes("synthetic-private-detail"));
	assert.equal(f.calls.length, 2);
	const g = fixture(); const controller = new AbortController(); controller.abort();
	await assert.rejects(g.config.oauth!.login(loginCallbacks({ signal: controller.signal })), { name: "AbortError" });
	assert.equal(g.calls.length, 0);
});

test("refresh retains the GitHub grant and installation identity, updates endpoints, and uses refresh_in despite clock skew", async () => {
	const f = fixture([device, { access_token: "synthetic-github" }, envelope(), envelope({ token: "synthetic-new", expires_at: 1, refresh_in: 60, endpoints: { api: "https://api.business.githubcopilot.com" } })]);
	const previous = await login(f);
	const refreshed = await f.config.oauth!.refreshToken(previous, new AbortController().signal);
	assert.equal(refreshed.access, "synthetic-new");
	assert.equal(refreshed.refresh, previous.refresh);
	assert.equal(refreshed.machineId, previous.machineId);
	assert.equal(refreshed.deviceId, previous.deviceId);
	assert.equal(refreshed.apiUrl, "https://api.business.githubcopilot.com");
	assert.equal(refreshed.expires, f.clock.now() + 60000);
});

test("token envelopes fail closed on malformed refresh timing or untrusted API origins", async () => {
	for (const value of [
		envelope({ refresh_in: 0 }), envelope({ refresh_in: "1200" }), envelope({ token: "bad\nsecret" }),
		envelope({ endpoints: { api: "https://githubcopilot.com.attacker.example" } }),
		envelope({ endpoints: { api: "https://api.individual.githubcopilot.com/other" } }),
		envelope({ endpoints: { api: "http://api.individual.githubcopilot.com" } }),
	]) {
		const f = fixture([device, { access_token: "synthetic-github" }, value]);
		await assert.rejects(login(f));
		assert.equal(f.calls.length, 3);
	}
	const f = fixture([device, { access_token: "synthetic-github" }, envelope({ endpoints: undefined })]);
	assert.equal((await login(f)).apiUrl, DEFAULT_API_URL);
});

test("catalog discovery uses credential endpoints and exposes only eligible streaming tool models", async () => {
	const f = fixture([device, { access_token: "synthetic-github" }, envelope(), { data: [
		model(), model("responses", ["/responses", "/chat/completions"]), model("messages", ["/v1/messages"]),
		{ ...model("hidden"), model_picker_enabled: false }, { ...model("disabled"), policy: { state: "disabled" } },
		{ ...model("nonchat"), capabilities: { type: "embeddings" } }, model("unsupported", ["ws:/responses"]),
	] }]);
	const credential = await login(f);
	const { context, published } = catalogContext(credential);
	const models = await f.config.refreshModels!(context);
	assert.deepEqual(models.map(m => [m.id, m.api]), [["synthetic-model", API_ID], ["responses", API_ID], ["messages", API_ID]]);
	assert.equal(f.calls[3].url, "https://api.individual.githubcopilot.com/models");
	assert.equal(new Headers(f.calls[3].init.headers).get("copilot-integration-id"), "vscode-chat");
	assert.equal(published.length, 1);
	assert.ok(!JSON.stringify(published).includes("synthetic-copilot"));
	const persisted = (published[0] as { persist: { models: Array<{ api: string }> } }).persist.models;
	assert.deepEqual(persisted.map(m => m.api), ["openai-completions", "openai-responses", "anthropic-messages"]);
	assert.deepEqual(await f.config.refreshModels!(catalogContext(undefined, false, { models: persisted }).context), models.map(m => ({ ...m, provider: PROVIDER_ID })));
	assert.equal(f.calls.length, 4);
});

test("catalog errors preserve HTTP status without leaking response bodies or changing model policies", async () => {
	const f = fixture([device, { access_token: "synthetic-github" }, envelope(), new Response("synthetic-private-detail", { status: 403 })]);
	const credential = await login(f);
	await assert.rejects(f.config.refreshModels!(catalogContext(credential).context), (e: Error) => /403/.test(e.message) && !e.message.includes("synthetic-private-detail"));
	assert.ok(f.calls.every(c => !c.url.endsWith("/policy")));
});

test("streaming unpacks only the Copilot token, pins endpoints, and preserves context, hooks, and event stream", async () => {
	const f = fixture([device, { access_token: "synthetic-github" }, envelope(), { data: [model()] }]);
	const credential = await login(f);
	await f.config.refreshModels!(catalogContext(credential).context);
	const context = normalizeContext({ systemPrompt: "Synthetic instruction", messages: [{ role: "user", content: "Synthetic prompt", timestamp: 0 }] });
	const key = f.config.oauth!.getApiKey(credential);
	const onPayload = () => undefined;
	const input = { ...model(), provider: PROVIDER_ID, api: "openai-completions", baseUrl: "https://attacker.example" } as never;
	assert.equal(f.config.streamSimple!(input, context, { apiKey: key, sessionId: "synthetic-session", onPayload }), f.stream);
	const [sentModel, sentContext, options] = f.streams[0];
	assert.equal(sentModel.provider, PROVIDER_ID);
	assert.equal(sentModel.baseUrl, "https://api.individual.githubcopilot.com");
	assert.equal(sentContext, context);
	assert.equal(options!.apiKey, "synthetic-copilot");
	assert.equal(options!.onPayload, onPayload);
	const headers = new Headers(options!.headers as HeadersInit);
	assert.equal(headers.get("x-initiator"), "user");
	assert.equal(headers.get("openai-intent"), "conversation-agent");
	assert.equal(headers.get("editor-version"), "vscode/1.115.0");
	assert.equal(headers.get("vscode-machineid"), credential.machineId as string);
	assert.equal(headers.get("vscode-sessionid"), "synthetic-session");
	assert.ok(!JSON.stringify(options).includes("synthetic-github"));
});

test("tool follow-ups are agent initiated and image inputs get the vision header", async () => {
	const f = fixture([device, { access_token: "synthetic-github" }, envelope(), { data: [model("synthetic-model", ["/v1/messages"])] }]);
	const credential = await login(f);
	await f.config.refreshModels!(catalogContext(credential).context);
	const context = normalizeContext({ messages: [
		{ role: "user", content: "Synthetic prompt", timestamp: 0 },
		{ role: "toolResult", toolCallId: "synthetic-tool", toolName: "read", content: [{ type: "image", data: "c3ludGhldGlj", mimeType: "image/png" }], isError: false, timestamp: 1 },
	] });
	f.config.streamSimple!({ id: "synthetic-model", api: "anthropic-messages" } as never, context, { apiKey: f.config.oauth!.getApiKey(credential) });
	const headers = new Headers(f.streams[0][2]!.headers as HeadersInit);
	assert.equal(headers.get("x-initiator"), "agent");
	assert.equal(headers.get("copilot-vision-request"), "true");
	assert.equal(headers.get("authorization"), "Bearer synthetic-copilot");
	assert.equal(f.streams[0][2]!.apiKey, undefined, "Anthropic must not also send x-api-key");
});

test("packed request credentials are validated, and placeholders never reach inference", () => {
	const f = fixture();
	const context = normalizeContext({ messages: [] });
	assert.throws(() => f.config.streamSimple!({ id: CATALOG_PLACEHOLDER } as never, context, {}), /catalog/i);
	assert.throws(() => f.config.streamSimple!({ id: "synthetic-model" } as never, context, { apiKey: "synthetic-unpacked" }), /credential/i);
	assert.equal(f.streams.length, 0);
});

test("device-code lifetime bounds polling and cancellation prevents refresh requests", async () => {
	const f = fixture([{ ...device, expires_in: 12 }, { error: "authorization_pending" }, { error: "authorization_pending" }]);
	await assert.rejects(login(f), /timed out/);
	assert.equal(f.clock.now(), NOW + 12000);
	assert.equal(f.calls.length, 3);
	const g = fixture();
	const controller = new AbortController(); controller.abort();
	await assert.rejects(g.config.oauth!.refreshToken({ refresh: "synthetic-github", access: "synthetic-copilot", expires: 0, machineId: "synthetic-machine", deviceId: "synthetic-device" }, controller.signal), { name: "AbortError" });
	assert.equal(g.calls.length, 0);
});

test("inference transport rejects endpoint changes and suppresses provider error bodies", async () => {
	const f = fixture([device, { access_token: "synthetic-github" }, envelope(), { data: [model()] }, new Response("synthetic-private-detail", { status: 403 })]);
	const credential = await login(f);
	await f.config.refreshModels!(catalogContext(credential).context);
	f.config.streamSimple!({ id: "synthetic-model", api: API_ID } as never, normalizeContext({ messages: [] }), { apiKey: f.config.oauth!.getApiKey(credential) });
	const fetchImpl = f.streams[0][2]!.fetch!;
	await assert.rejects(fetchImpl("https://attacker.example/chat/completions"), /Untrusted/);
	await assert.rejects(fetchImpl("https://api.individual.githubcopilot.com/models"), /Untrusted/);
	assert.equal(f.calls.length, 4);
	const result = await fetchImpl("https://api.individual.githubcopilot.com/chat/completions");
	assert.equal(result.status, 403);
	assert.ok(!(await result.text()).includes("synthetic-private-detail"));
	assert.equal(f.calls[4].init.redirect, "error");
	assert.equal(new Headers(f.calls[4].init.headers).get("authorization"), "Bearer synthetic-copilot");
});

 test("inference forwards quota snapshots without consuming the stream; observers are non-fatal", async () => {
  const snapshots: unknown[] = [];
  const response = new Response("synthetic-stream", { headers: { "x-quota-snapshot-premium_models": "ent=100&rem=50" } });
  let captured: Parameters<NonNullable<ProviderConfig["streamSimple"]>>[2];
  const config = createCopilotProvider({ now: () => NOW, onQuota: q => { snapshots.push(q); throw new Error("observer failure"); }, streamSimple: (_m, _c, opts) => { captured = opts; return createAssistantMessageEventStream(); } });
  await config.refreshModels!(catalogContext(undefined, false, { models: [{ id: "synthetic-model", api: "openai-completions", input: ["text"] }] }).context);
  config.streamSimple!({ id: "synthetic-model", api: API_ID } as never, normalizeContext({ messages: [] }), {
   apiKey: config.oauth!.getApiKey({ access: "synthetic-copilot", refresh: "synthetic-github", expires: NOW, apiUrl: DEFAULT_API_URL, machineId: "machine", deviceId: "device" }),
   fetch: (async () => response) as unknown as typeof fetch,
  });
  const result = await captured!.fetch!(DEFAULT_API_URL + "/chat/completions");
  assert.equal(await result.text(), "synthetic-stream");
  assert.equal(snapshots.length, 1); assert.equal((snapshots[0] as { remaining: number }).remaining, 50);
 });

test("a new login invalidates the previous account quota even if authorization fails", async () => {
 const snapshots: unknown[] = [];
 const config = createCopilotProvider({ onQuota: q => snapshots.push(q), fetchImpl: async () => { throw new Error("synthetic-network-error"); }, streamSimple: () => createAssistantMessageEventStream() });
 await assert.rejects(config.oauth!.login(loginCallbacks()));
 assert.deepEqual(snapshots, [undefined]);
});
