import assert from "node:assert/strict";
import { test } from "bun:test";
import { InMemoryModelsStore, type Credential, type CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import copilot from "../../src/domains/copilot/index.ts";
import { PROVIDER_ID } from "../../src/domains/copilot/provider.ts";

const credential: Credential = {
	type: "oauth", access: "synthetic-copilot", refresh: "synthetic-github", expires: 8e15,
	apiUrl: "https://api.individual.githubcopilot.com", machineId: "synthetic-machine", deviceId: "synthetic-device",
};
const messages = { messages: [{ role: "user" as const, content: "Reply OK", timestamp: 0 }] };

for (const endpoint of ["/chat/completions", "/responses", "/v1/messages"]) for (const status of [401, 402, 403, 429, 500]) {
	test(`HTTP ${status}: Pi dispatches ${endpoint} through the Copilot credential adapter, not a built-in transport`, async () => {
		let stored: Credential | undefined = { ...credential };
		const credentials: CredentialStore = {
			read: async id => id === PROVIDER_ID ? stored : undefined,
			list: async () => [{ providerId: PROVIDER_ID, type: "oauth" }],
			modify: async (_id, fn) => { stored = await fn(stored); return stored; },
			delete: async () => { stored = undefined; },
		};
		const modelsStore = new InMemoryModelsStore();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore, refreshOnCreate: false });
		let config!: ProviderConfig;
		copilot({ on: () => () => {}, registerProvider: (_id: string, value: ProviderConfig) => { config = value; } } as unknown as ExtensionAPI);
		// Restore a synthetic persisted native catalog without any network.
		const wireApi = endpoint === "/responses" ? "openai-responses" : endpoint === "/v1/messages" ? "anthropic-messages" : "openai-completions";
		await modelsStore.write(PROVIDER_ID, { models: [{ type: "chat", provider: PROVIDER_ID, id: "synthetic-model", name: "Synthetic", api: wireApi,
				baseUrl: credential.apiUrl as string, reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
		runtime.registerProvider(PROVIDER_ID, config);
		const refreshed = await runtime.refresh({ allowNetwork: false, providers: [PROVIDER_ID] });
		assert.equal(refreshed.errors.size, 0);
		const selected = runtime.getModel(PROVIDER_ID, "synthetic-model")!;
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const result = await runtime.completeSimple(selected, messages, {
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				calls.push({ url: input instanceof Request ? input.url : String(input), init });
				// A status failure still exercises real SDK serialization, request auth,
				// callbacks, error normalization, and Pi's composer dispatch.
				return new Response("synthetic-private-provider-detail", { status });
			}) as typeof fetch,
		});
		assert.equal(calls.length, 1, JSON.stringify(result));
		assert.equal(new URL(calls[0].url).origin + new URL(calls[0].url).pathname, `${credential.apiUrl}${endpoint}`);
		const headers = new Headers(calls[0].init?.headers);
		assert.equal(headers.get("authorization"), "Bearer synthetic-copilot");
		assert.equal(headers.get("x-api-key"), null);
		assert.equal(calls[0].init?.redirect, "error");
		assert.equal(result.stopReason, "error");
		assert.ok(!result.errorMessage?.includes("synthetic-private-provider-detail"));
		assert.ok(!JSON.stringify(calls).includes("synthetic-github"));
	});
}
