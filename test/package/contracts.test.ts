import assert from "node:assert/strict";
import { test, spyOn } from "bun:test";
import {
	createAssistantMessageEventStream, getModels, normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import claude from "../../src/domains/claude/index.ts";
import spettro from "../../src/domains/spettro/index.ts";
import mistral from "../../src/domains/mistral-vibe/index.ts";
import { createProviderConfig } from "../../src/domains/claude/provider.ts";
import { createSpettroProvider } from "../../src/domains/spettro/provider.ts";
import { createMistralVibeProvider } from "../../src/domains/mistral-vibe/provider.ts";
import manifest from "../../package.json" with { type: "json" };

function fakePi() {
	const providers = new Map<string, ProviderConfig>();
	const pi = {
		registerProvider: (id: string, config: ProviderConfig) => {
			assert.ok(!providers.has(id), `duplicate provider ${id}`);
			providers.set(id, config);
		},
	} as unknown as ExtensionAPI;
	return { pi, providers };
}

for (const [name, entry, id] of [["claude", claude, "claude-subscription"], ["spettro", spettro, "spettro"], ["mistral-vibe", mistral, "mistral-vibe"]] as const) {
	test(`${name} can register independently without network or other providers`, () => {
		const f = fakePi();
		const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("Unexpected network at registration"); }, { preconnect: () => { throw new Error("Unexpected preconnect"); } }));
		try {
			entry(f.pi);
			assert.deepEqual([...f.providers.keys()], [id]);
			assert.equal(network.mock.calls.length, 0);
		} finally { network.mockRestore(); }
	});
}

test("all domains coexist without replacing built-in mistral or sharing provider IDs", () => {
	const f = fakePi();
	claude(f.pi); spettro(f.pi); mistral(f.pi);
	assert.deepEqual([...f.providers.keys()], ["claude-subscription", "spettro", "mistral-vibe"]);
	assert.ok(!f.providers.has("mistral"));
});

test("manifest loads only the three domain entry points", () => {
	assert.deepEqual(manifest.pi.extensions, ["./src/domains/claude/index.ts", "./src/domains/spettro/index.ts", "./src/domains/mistral-vibe/index.ts"]);
	assert.equal(manifest.packageManager, "bun@1.4.3");
});

for (const name of ["claude", "spettro", "mistral-vibe"] as const) {
	test(`${name} preserves caller context/options and delegates the original event stream`, () => {
		const stream = createAssistantMessageEventStream();
		stream.end();
		const captured: Parameters<NonNullable<ProviderConfig["streamSimple"]>>[] = [];
		const streamSimple: NonNullable<ProviderConfig["streamSimple"]> = (...args) => { captured.push(args); return stream; };
		const config = name === "claude" ? createProviderConfig({ models: [], streamSimple, env: {} })
			: name === "spettro" ? createSpettroProvider({ streamSimple, env: {} })
			: createMistralVibeProvider({ models: [], streamSimple });
		const context = normalizeContext({ systemPrompt: "Synthetic system instructions", messages: [{ role: "user", content: "synthetic prompt", timestamp: 0 }] });
		const before = structuredClone(context.messages);
		const options: SimpleStreamOptions = { signal: new AbortController().signal, apiKey: "synthetic-token", onPayload: async () => undefined };
		const model = getModels("anthropic")[0];
		assert.equal(config.streamSimple!(model, context, options), stream);
		assert.equal(captured[0][1], context);
		assert.equal(captured[0][2], options);
		assert.deepEqual(context.messages, before);
		assert.equal(config.headers, undefined);
	});
}
