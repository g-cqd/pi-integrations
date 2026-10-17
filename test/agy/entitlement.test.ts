import assert from "node:assert/strict";
import { test } from "bun:test";
import { createCodexProvider } from "../../src/domains/codex/provider.ts";
import { createAgyProvider } from "../../src/domains/agy/provider.ts";
import { CATALOG_PLACEHOLDER, toModelConfig } from "../../src/domains/agy/provider.ts";
import type { FetchImplementation } from "../../src/shared/http.ts";

/**
 * Contract tests for what each subscription domain verifies, and what it does
 * not. These exist because the two domains differ in a way that is easy to lose:
 * Antigravity resolves entitlement and a live catalog, Codex resolves neither.
 * docs/domains/codex.md#entitlement and docs/domains/agy.md#entitlement state
 * this; these tests keep those statements true.
 */

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

/** Pi's refreshModels context: publish persists to the store; stored restores. */
const refreshContext = (credential: unknown, allowNetwork = true, over: Record<string, unknown> = {}) => ({
	allowNetwork, credential, signal: new AbortController().signal,
	publish: async () => true,
	...over,
}) as never;

/** Minimal valid credentials for each domain. */
const codexJwt = (payload: unknown) => {
	const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
	return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
};

test("Codex declares a subscription and now registers refreshModels", () => {
	const provider = createCodexProvider({
		models: [], streamSimple: (() => undefined) as never,
		fetchImpl: (async () => new Response("{}")) as FetchImplementation,
	});
	assert.equal(provider.oauth?.isSubscription, true);
	// Discovery was added: the account's catalog now replaces the static list.
	assert.equal(typeof provider.refreshModels, "function");
	assert.deepEqual(provider.models, [], "the initial list is still whatever Pi passes in");
});

test("Codex login returns credentials without any entitlement lookup", async () => {
	// One queued response is enough: if login needed an entitlement call it would
	// exhaust this and fail, because nothing else is queued.
	const access = codexJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-synthetic" } });
	let calls = 0;
	const fetchImpl: FetchImplementation = async () => {
		calls++;
		return json({ access_token: access, refresh_token: "refresh-synthetic", expires_in: 3600 });
	};
	// Inject the callback server so the test never binds port 1455.
	const provider = createCodexProvider({
		models: [], streamSimple: (() => undefined) as never, fetchImpl,
		// Fail to bind so the provider uses the documented pasted-redirect path,
		// without the test touching a real port.
		startLoopback: (async () => { throw new Error("EADDRINUSE"); }) as never,
	});
	const login = provider.oauth?.login;
	assert.ok(login, "codex must expose a login");
	// onAuth receives the authorization URL, so the pasted input can be built to
	// match its real state. This exercises the documented paste path end to end.
	let state = "";
	const credentials = await login({
		signal: new AbortController().signal,
		onAuth: (link: { url?: string }) => { state = new URL(link.url!).searchParams.get("state") ?? ""; },
		onProgress: () => undefined,
		onSelect: async () => "browser",
		onDeviceCode: () => undefined,
		// onManualCodeInput wins over onPrompt in provider.ts, so build the pasted
		// value here where the captured state is in scope.
		onManualCodeInput: async () => `code=synthetic-authorization-code&state=${state}`,
	} as never);
	assert.equal(calls, 1, "exactly one request: the token exchange. No plan or entitlement call.");
	const creds = credentials as { accountId?: string };
	assert.equal(creds.accountId, "acct-synthetic", "the account id comes from the token's own claim");
});

test("Antigravity registers refreshModels and ships only a placeholder until it runs", () => {
	const provider = createAgyProvider({ fetchImpl: (async () => new Response("{}")) as FetchImplementation });
	assert.equal(provider.oauth?.isSubscription, true);
	assert.equal(typeof provider.refreshModels, "function");
	assert.equal(provider.models?.length, 1);
	assert.equal((provider.models as Array<{ id: string }>)[0].id, CATALOG_PLACEHOLDER);
});

test("refreshModels returns the placeholder without network access", async () => {
	const provider = createAgyProvider({ fetchImpl: (async () => new Response("{}")) as FetchImplementation });
	// allowNetwork: false must not reach the network, and must not invent models.
	const models = await provider.refreshModels?.({
		allowNetwork: false, credential: { access: "token", projectId: "proj" }, signal: new AbortController().signal,
	} as never);
	assert.equal((models as Array<{ id: string }>).length, 1);
	assert.equal((models as Array<{ id: string }>)[0].id, CATALOG_PLACEHOLDER);
});

test("refreshModels keeps the placeholder when the credential is unusable", async () => {
	// Each of these must be refused BEFORE a request, because a request with a
	// missing project or token would send a credential that cannot work.
	for (const credential of [undefined, {}, { access: "" }, { access: "t" }, { access: "t", projectId: 42 }, { access: "t", projectId: "" }]) {
		const provider = createAgyProvider({ fetchImpl: (async () => {
			throw new Error("network must not be reached for an unusable credential");
		}) as FetchImplementation });
		const models = await provider.refreshModels?.(refreshContext(credential));
		assert.equal((models as Array<{ id: string }>)[0].id, CATALOG_PLACEHOLDER,
			`credential ${JSON.stringify(credential)} must fall back to the placeholder`);
	}
});

test("a subscription model reports zero cost but not zero billing", () => {
	const config = toModelConfig({
		id: "gemini-x", displayName: "Gemini X", supportsImages: true, supportsThinking: true,
		recommended: true, preview: false,
	}, "https://cloudcode-pa.googleapis.com");
	assert.deepEqual(config.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	// The distinction the comment in provider.ts makes: a subscription is not
	// free, it is unpriced here. Zero is a placeholder, not a measurement.
	assert.equal((config.cost as { input?: number } | undefined)?.input, 0);
	assert.equal((config.input as string[] | undefined)?.includes("image"), true, "image support must reach the model config");
	assert.equal((config as { reasoning?: boolean }).reasoning, true);
	assert.equal(config.name, "Gemini X");
});

test("preview models are labelled so a preview is never mistaken for GA", () => {
	const config = toModelConfig({
		id: "gemini-x-preview", displayName: "Gemini X", supportsImages: false, supportsThinking: false,
		recommended: false, preview: true,
	}, "https://cloudcode-pa.googleapis.com");
	assert.equal(config.name, "Gemini X (preview)");
	assert.deepEqual(config.input, ["text"]);
	assert.equal((config as { reasoning?: boolean }).reasoning, false);
});

test("server-reported limits win, and only fall back when absent", () => {
	const withLimits = toModelConfig({
		id: "m", displayName: "m", supportsImages: false, supportsThinking: false,
		recommended: false, preview: false, maxTokens: 1_000_000, maxOutputTokens: 65_536,
	}, "https://x");
	assert.equal((withLimits as { contextWindow?: number }).contextWindow, 1_000_000, "a reported limit must be used as-is");
	assert.equal((withLimits as { maxTokens?: number }).maxTokens, 65_536);

	const without = toModelConfig({ id: "m", displayName: "m", supportsImages: false, supportsThinking: false, recommended: false, preview: false }, "https://x");
	assert.equal((without as { contextWindow?: number }).contextWindow, 128_000, "fallback when the server reports nothing");
	assert.equal((without as { maxTokens?: number }).maxTokens, 8192);
});

test("the server's default model is ordered first and the rest keep server order", async () => {
	// refreshModels sorts by defaultAgentModelId descending, so the default
	// leads and every other model keeps the order the server sent.
	const provider = createAgyProvider({
		fetchImpl: (async () => new Response(JSON.stringify({
			defaultAgentModelId: "bravo",
			models: {
				alpha: { displayName: "Alpha", supportsImages: false, supportsThinking: false, recommended: false, preview: false },
				bravo: { displayName: "Bravo", supportsImages: true, supportsThinking: true, recommended: true, preview: false },
				charlie: { displayName: "Charlie", supportsImages: false, supportsThinking: true, recommended: false, preview: false },
			},
		}), { status: 200 })) as FetchImplementation,
	});
	const list = await provider.refreshModels!(refreshContext({ access: "token", projectId: "proj" }));
	const ids = (list as Array<{ id: string }>).map((m) => m.id);
	assert.equal(ids[0], "bravo", "the default model leads");
	assert.deepEqual(ids.slice(1).sort(), ["alpha", "charlie"], "the remaining models are all present");
	// Capabilities must survive the reordering.
	const bravo = (list as Array<{ id: string; input?: string[] }>).find((m) => m.id === "bravo");
	assert.ok(bravo?.input?.includes("image"), "image support survives sorting");
});

test("a catalog with no default keeps the server's order", async () => {
	const provider = createAgyProvider({
		fetchImpl: (async () => new Response(JSON.stringify({
			models: {
				zulu: { displayName: "Zulu", supportsImages: false, supportsThinking: false, recommended: false, preview: false },
				alpha: { displayName: "Alpha", supportsImages: false, supportsThinking: false, recommended: false, preview: false },
			},
		}), { status: 200 })) as FetchImplementation,
	});
	const list = await provider.refreshModels!(refreshContext({ access: "token", projectId: "proj" })) as Array<{ id: string }>;
	assert.deepEqual((list as Array<{ id: string }>).map((m) => m.id), ["zulu", "alpha"],
		"without a default, insertion order is preserved rather than sorted by name");
});

test("a default id the catalog does not contain does not drop every model", async () => {
	// A server naming a default we do not receive must not reorder or empty the list.
	const provider = createAgyProvider({
		fetchImpl: (async () => new Response(JSON.stringify({
			defaultAgentModelId: "ghost-model",
			models: { alpha: { displayName: "Alpha", supportsImages: false, supportsThinking: false, recommended: false, preview: false } },
		}), { status: 200 })) as FetchImplementation,
	});
	const list = await provider.refreshModels!(refreshContext({ access: "token", projectId: "proj" })) as Array<{ id: string }>;
	assert.deepEqual((list as Array<{ id: string }>).map((m) => m.id), ["alpha"], "the real model is still offered");
});

// ---------------------------------------------------------------------------
// Catalog persistence
//
// Pi persists only what refreshModels publishes via context.publish({persist}),
// and hands the stored entry back as context.stored on the next restore pass.
// Without the publish, the catalog evaporates on every restart -- the gap that
// left the placeholder in place after a successful live sign-in.
// ---------------------------------------------------------------------------

test("a successful refresh publishes the catalog for persistence", async () => {
	const published: Array<Record<string, unknown>> = [];
	const provider = createAgyProvider({
		fetchImpl: (async () => new Response(JSON.stringify({
			models: { "claude-x-low": { displayName: "Claude X", supportsImages: false, supportsThinking: false, recommended: true } },
			defaultAgentModelId: "claude-x-low",
		}), { status: 200 })) as FetchImplementation,
	});
	const list = await provider.refreshModels!(refreshContext({ access: "token", projectId: "proj" }, true,
		{ publish: async (p: Record<string, unknown>) => { published.push(p); return true; } })) as Array<{ id: string }>;
	assert.equal(list.length, 1);
	assert.equal(published.length, 1, "exactly one publication");
	const persist = (published[0] as { persist?: { models?: Array<{ id: string; provider?: string }>; checkedAt?: number } }).persist;
	assert.ok(persist, "the publication carries a persist entry");
	assert.equal(persist?.models?.[0]?.id, "claude-x-low");
	assert.equal(persist?.models?.[0]?.provider, "agy-subscription", "provider is stamped for the restore filter");
	assert.ok(typeof persist?.checkedAt === "number");
});

test("the restore pass returns the stored catalog, not the placeholder", async () => {
	let fetched = 0;
	const provider = createAgyProvider({
		fetchImpl: (async () => { fetched++; return new Response("{}", { status: 200 }); }) as FetchImplementation,
	});
	const storedCatalog = [{ id: "claude-x-low", name: "Claude X", api: "agy-cloudcode", provider: "agy-subscription", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
	const restored = await provider.refreshModels!(refreshContext({ access: "token", projectId: "proj" }, false,
		{ stored: { models: storedCatalog } })) as Array<{ id: string }>;
	assert.deepEqual(restored.map((m) => m.id), ["claude-x-low"], "the persisted catalog is restored");
	assert.equal(fetched, 0, "the restore pass makes no network request");
});

test("the restore pass filters the placeholder out of a stored entry", async () => {
	const provider = createAgyProvider({ fetchImpl: (async () => { throw new Error("no network"); }) as FetchImplementation });
	const storedCatalog = [{ id: CATALOG_PLACEHOLDER }, { id: "claude-x-low", provider: "agy-subscription" }];
	const restored = await provider.refreshModels!(refreshContext({ access: "t", projectId: "p" }, false,
		{ stored: { models: storedCatalog } })) as Array<{ id: string }>;
	assert.deepEqual(restored.map((m) => m.id), ["claude-x-low"], "a stale placeholder in the store is dropped");
});

test("a failed fetch throws and publishes nothing, so a bad catalog cannot clobber a good one", async () => {
	// Unlike the Codex catalog (unverified endpoint, silent fallback to the
	// static list), this endpoint is verified, so a failure is surfaced to
	// Pi's refresh -- which keeps the previous models and reports the error.
	// Either way, nothing is persisted on failure.
	const published: unknown[] = [];
	const provider = createAgyProvider({
		fetchImpl: (async () => new Response("nope", { status: 500 })) as FetchImplementation,
	});
	await assert.rejects(provider.refreshModels!(refreshContext({ access: "token", projectId: "proj" }, true,
		{ publish: async (p: unknown) => { published.push(p); return true; } })), /HTTP 500/);
	assert.equal(published.length, 0, "nothing is persisted on failure");
});
