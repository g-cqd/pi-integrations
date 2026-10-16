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
import codex from "../../src/domains/codex/index.ts";
import agy from "../../src/domains/agy/index.ts";
import { createProviderConfig } from "../../src/domains/claude/provider.ts";
import { createSpettroProvider } from "../../src/domains/spettro/provider.ts";
import { createMistralVibeProvider } from "../../src/domains/mistral-vibe/provider.ts";
import { createCodexProvider } from "../../src/domains/codex/provider.ts";
import { createAgyProvider } from "../../src/domains/agy/provider.ts";
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

for (const [name, entry, id] of [["claude", claude, "claude-subscription"], ["codex", codex, "codex-subscription"], ["agy", agy, "agy-subscription"], ["spettro", spettro, "spettro"], ["mistral-vibe", mistral, "mistral-vibe"]] as const) {
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

test("all domains coexist without replacing built-in providers or sharing provider IDs", () => {
	const f = fakePi();
	claude(f.pi); codex(f.pi); agy(f.pi); spettro(f.pi); mistral(f.pi);
	assert.deepEqual([...f.providers.keys()], ["claude-subscription", "codex-subscription", "agy-subscription", "spettro", "mistral-vibe"]);
	for (const builtIn of ["mistral", "openai", "openai-codex", "anthropic", "google"]) assert.ok(!f.providers.has(builtIn), `${builtIn} stays Pi's own`);
});

test("sign-in is the only credential path: no registered provider declares API-key configuration", () => {
	const f = fakePi();
	claude(f.pi); codex(f.pi); agy(f.pi); spettro(f.pi); mistral(f.pi);
	for (const [id, config] of f.providers) {
		assert.equal(config.apiKey, undefined, `${id} must not declare an apiKey`);
		assert.ok(config.oauth, `${id} must offer a sign-in`);
		assert.equal(config.headers, undefined, `${id} must not override request headers`);
	}
});

test("the Mistral domain offers only Mistral Large 4", () => {
	const f = fakePi();
	mistral(f.pi);
	assert.deepEqual((f.providers.get("mistral-vibe")!.models ?? []).map((m) => m.id), ["mistral-large-4"]);
});

test("the Codex domain reuses Pi's Codex catalog and the Codex responses API", () => {
	const f = fakePi();
	codex(f.pi);
	const config = f.providers.get("codex-subscription")!;
	assert.equal(config.api, "openai-codex-responses");
	assert.ok((config.models ?? []).length > 0);
	assert.ok((config.models ?? []).every((m) => (m.api ?? "openai-codex-responses") === "openai-codex-responses"));
});

test("manifest loads exactly the five domain entry points", () => {
	assert.deepEqual(manifest.pi.extensions, [
		"./src/domains/claude/index.ts", "./src/domains/codex/index.ts", "./src/domains/agy/index.ts",
		"./src/domains/spettro/index.ts", "./src/domains/mistral-vibe/index.ts",
	]);
	assert.equal(manifest.packageManager, "bun@1.4.3");
});

for (const name of ["claude", "codex", "agy", "spettro", "mistral-vibe"] as const) {
	test(`${name} preserves caller context/options and delegates the original event stream`, () => {
		const stream = createAssistantMessageEventStream();
		stream.end();
		const captured: Parameters<NonNullable<ProviderConfig["streamSimple"]>>[] = [];
		const streamSimple: NonNullable<ProviderConfig["streamSimple"]> = (...args) => { captured.push(args); return stream; };
		const config = name === "claude" ? createProviderConfig({ models: [], streamSimple, env: {} })
			: name === "codex" ? createCodexProvider({ models: [], streamSimple })
			: name === "agy" ? createAgyProvider({ streamSimple, env: {} })
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
