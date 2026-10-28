import assert from "node:assert/strict";
import { test } from "bun:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import copilot from "../../src/domains/copilot/index.ts";
import { API_ID, PROVIDER_ID } from "../../src/domains/copilot/provider.ts";

const credential = { access: "synthetic-copilot", refresh: "synthetic-github", expires: 8e15, apiUrl: "https://api.individual.githubcopilot.com", machineId: "synthetic-machine", deviceId: "synthetic-device" };
const context = normalizeContext({ messages: [{ role: "user", content: "Reply OK", timestamp: 0 }] });
const sse = (events: unknown[]) => new Response(events.map(event => {
	const type = event && typeof event === "object" && "type" in event ? `event: ${event.type}\n` : "";
	return `${type}data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
}).join(""), { headers: { "content-type": "text/event-stream" } });

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
	test(`the real ${api} adapter streams a synthetic response through the Copilot connection`, async () => {
		let config!: ProviderConfig;
		copilot({ on: () => () => {}, registerProvider: (_id: string, value: ProviderConfig) => { config = value; } } as unknown as ExtensionAPI);
		const native: Model<typeof api> = { type: "chat", id: "synthetic-model", name: "Synthetic", provider: PROVIDER_ID, api,
			baseUrl: credential.apiUrl, reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		await config.refreshModels!({ allowNetwork: false, signal: new AbortController().signal, stored: { models: [native] }, publish: async p => { p.update?.(); return true; } });
		const events = api === "openai-completions" ? [
			{ id: "synthetic-response", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
			{ id: "synthetic-response", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }, "[DONE]",
		] : api === "openai-responses" ? [
			{ type: "response.created", response: { id: "synthetic-response", model: native.id } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "synthetic-message", role: "assistant", content: [] } },
			{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "synthetic-message", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] } },
			{ type: "response.completed", response: { id: "synthetic-response", status: "completed", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
		] : [
			{ type: "message_start", message: { id: "synthetic-response", role: "assistant", model: native.id, content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		const calls: unknown[] = [];
		let payloads = 0, responses = 0;
		const stream = config.streamSimple!({ ...native, api: API_ID }, context, {
			apiKey: config.oauth!.getApiKey(credential),
			onPayload: () => { payloads++; }, onResponse: () => { responses++; },
			fetch: (async (_input: unknown, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return sse(events); }) as typeof fetch,
		});
		const result = await stream.result();
		assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
		assert.deepEqual(result.content.filter(p => p.type === "text").map(p => p.text), ["OK"]);
		assert.equal(result.provider, PROVIDER_ID);
		assert.equal(result.usage.input, 2);
		assert.equal(result.usage.output, 1);
		assert.equal(calls.length, 1);
		assert.equal(payloads, 1);
		assert.equal(responses, 1);
	});
}
