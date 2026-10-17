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

// ---------------------------------------------------------------------------
// Harness loadability
//
// scripts/smoke-registration.sh proves the CLI lists these providers, and the
// tests above prove each entry registers in isolation. Neither checks the config
// object Pi actually receives: a provider can register successfully with a
// missing `streamSimple`, an unparseable `baseUrl`, or no models, and Pi then
// fails later at inference time rather than at load time. These assertions run
// against the real index.ts wiring, with the models Pi's own catalogs supply.
// ---------------------------------------------------------------------------

test("every domain's registered config is complete enough for Pi to use", () => {
	const f = fakePi();
	claude(f.pi); codex(f.pi); agy(f.pi); spettro(f.pi); mistral(f.pi);
	for (const [id, config] of f.providers) {
		assert.equal(typeof config.name, "string", `${id} needs a name`);
		assert.ok((config.name as string).length > 0, `${id} needs a non-empty name`);
		assert.equal(typeof config.api, "string", `${id} needs an api id`);
		assert.ok(Array.isArray(config.models) && config.models.length > 0, `${id} needs at least one model`);
		assert.equal(typeof config.streamSimple, "function", `${id} needs streamSimple`);
		const oauth = config.oauth;
		assert.ok(oauth, `${id} needs oauth`);
		for (const hook of ["login", "refreshToken", "getApiKey"] as const) {
			assert.equal(typeof oauth[hook], "function", `${id} oauth.${hook} must be callable`);
		}
		// isSubscription is optional in Pi's type and read as `=== true`, so
		// omitting it is how a provider says "not a subscription". Only a
		// non-boolean, non-undefined value would be a real defect.
		assert.ok(oauth.isSubscription === undefined || typeof oauth.isSubscription === "boolean",
			`${id} isSubscription must be a boolean when present`);
		// A baseUrl Pi cannot parse fails at request time, deep in inference.
		assert.doesNotThrow(() => new URL(String(config.baseUrl)), `${id} baseUrl must be a URL`);
	}
});

test("the subscription domains declare isSubscription and the API-key domain omits it", () => {
	// Pi reads `provider.auth.oauth?.isSubscription === true`, so declaring true
	// opts into subscription UI and refresh handling. Mistral/Vibe receives a
	// service-issued API key with no refresh grant; declaring it as a
	// subscription would promise Pi a rotating refresh token that never comes.
	const f = fakePi();
	claude(f.pi); codex(f.pi); agy(f.pi); spettro(f.pi); mistral(f.pi);
	for (const id of ["claude-subscription", "codex-subscription", "agy-subscription", "spettro"]) {
		assert.equal(f.providers.get(id)!.oauth!.isSubscription, true, `${id} is subscription sign-in`);
	}
	assert.equal(f.providers.get("mistral-vibe")!.oauth!.isSubscription, undefined,
		"mistral-vibe is API-key, so it must not claim a subscription");
});

test("each domain receives a non-empty model list from Pi's own catalogs", () => {
	// models is injected by index.ts, not by the domain, so an empty catalog in
	// Pi would silently produce a provider that lists nothing at all.
	const f = fakePi();
	claude(f.pi); codex(f.pi); agy(f.pi); spettro(f.pi); mistral(f.pi);
	for (const [id, config] of f.providers) {
		const models = config.models ?? [];
		assert.ok(models.length > 0, `${id} must list at least one model`);
		for (const model of models) {
			assert.equal(typeof model.id, "string", `${id} has a model without an id`);
			assert.ok((model.id as string).length > 0, `${id} has an empty model id`);
		}
	}
	// Antigravity starts as a placeholder until refreshModels discovers the account's.
	assert.deepEqual((f.providers.get("agy-subscription")!.models ?? []).map((m) => m.id), ["agy-catalog-loading"]);
	assert.deepEqual((f.providers.get("spettro")!.models ?? []).map((m) => m.id), ["spettro-catalog-loading"]);
});

test("each index returns a live Pi event stream from streamSimple", () => {
	// The index.ts wrappers are what Pi calls at inference time, and no test
	// invoked them. These assertions are deliberately about the contract Pi
	// depends on -- a real event stream, the caller's context forwarded, not the
	// request itself, which Pi's adapter performs with its own HTTP client and
	// which a global fetch spy cannot observe.
	const bogus = { id: "synthetic-model", api: "synthetic", provider: "synthetic", name: "synthetic", baseUrl: "http://127.0.0.1:1/synthetic" };
	const context = normalizeContext({ messages: [{ role: "user", content: "synthetic", timestamp: 0 }] });
	const options = { apiKey: "synthetic-key" } as SimpleStreamOptions;

	for (const [name, entry] of [["codex", codex], ["spettro", spettro], ["mistral-vibe", mistral], ["claude", claude]] as const) {
		const f = fakePi();
		entry(f.pi);
		const config = [...f.providers.values()][0]!;
		// A non-placeholder model id, so a catalog guard does not reject the call
		// before delegation is observable.
		const model = { ...bogus, id: "synthetic-model-not-a-placeholder", api: config.api };
		const stream = config.streamSimple!(model as never, context, options) as unknown as Record<string, unknown>;
		assert.ok(stream, `${name} must return a stream`);
		// Pi's event-stream contract: an async iterable plus a terminal result.
		assert.equal(typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator], "function",
			`${name} must return an async-iterable event stream`);
		for (const key of ["finalResultPromise", "isComplete"]) {
			assert.ok(key in stream, `${name} stream must expose ${key}, which Pi consumes`);
		}
	}

	// Antigravity owns its stream rather than delegating, and both catalog-guard
	// domains must refuse the placeholder instead of sending a request.
	const f = fakePi();
	agy(f.pi);
	assert.throws(
		() => f.providers.get("agy-subscription")!.streamSimple!({ ...bogus, id: "agy-catalog-loading" } as never, context, options),
		/catalog not loaded/,
		"the Antigravity placeholder must refuse to infer",
	);
	const f2 = fakePi();
	spettro(f2.pi);
	assert.throws(
		() => f2.providers.get("spettro")!.streamSimple!({ ...bogus, id: "spettro-catalog-loading" } as never, context, options),
		/catalog not loaded/,
		"the Spettro placeholder must refuse to infer",
	);
});

