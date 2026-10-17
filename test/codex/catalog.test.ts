import assert from "node:assert/strict";
import { test } from "bun:test";
import { createCodexProvider } from "../../src/domains/codex/provider.ts";
import {
	CODEX_MODELS_PATH, parseCatalog, describeFailure, fetchCodexCatalog,
} from "../../src/domains/codex/catalog.ts";
import { mergeCatalog, staticModels, toModelConfig } from "../../src/domains/codex/models.ts";
import type { FetchImplementation } from "../../src/shared/http.ts";

/**
 * The Codex live catalog is inferred from strings in the `codex` CLI, not from
 * an observed response, so these tests are mostly about the FALLBACKS: the
 * contract is that no failure can leave a user with fewer models than Pi's
 * static catalog, and that an unverified endpoint cannot break the provider.
 */

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

/** A plausible catalog entry using the field names found in the CLI strings. */
const entry = (over: Record<string, unknown> = {}) => ({
	slug: "gpt-6.1-sol",
	display_name: "GPT-6.1 Sol",
	context_window: 500_000,
	max_output_tokens: 128_000,
	supported_reasoning_levels: ["minimal", "low", "medium", "high", "xhigh"],
	default_reasoning_level: "medium",
	visibility: "public",
	supported_in_api: true,
	...over,
});

const providerWith = (fetchImpl: FetchImplementation) => createCodexProvider({
	models: [], streamSimple: (() => undefined) as never, fetchImpl,
});

const refreshContext = (credential: unknown, allowNetwork = true, over: Record<string, unknown> = {}) => ({
	allowNetwork, credential, signal: new AbortController().signal,
	publish: async () => true,
	...over,
}) as never;

test("the endpoint matches the path observed in the CLI strings", () => {
	assert.equal(CODEX_MODELS_PATH, "/codex/models");
});

test("a catalog at the top level is parsed", () => {
	const models = parseCatalog({ models: [entry()] });
	assert.equal(models?.length, 1);
	assert.equal(models?.[0].slug, "gpt-6.1-sol");
	assert.equal(models?.[0].displayName, "GPT-6.1 Sol");
	assert.equal(models?.[0].contextWindow, 500_000);
	assert.equal(models?.[0].maxOutputTokens, 128_000);
	assert.deepEqual(models?.[0].supportedReasoningLevels, ["minimal", "low", "medium", "high", "xhigh"]);
	assert.equal(models?.[0].defaultReasoningLevel, "medium");
});

test("a bare array and a nested envelope are both accepted", () => {
	// The CLI's JSON shape is not pinned by its strings, so all three envelopes
	// must parse rather than being guessed at.
	assert.equal(parseCatalog([entry()])?.length, 1);
	assert.equal(parseCatalog({ models: [entry()] })?.length, 1);
	assert.equal(parseCatalog({ data: { models: [entry()] } })?.length, 1);
});

test("an unrecognized envelope is a failure, not an empty catalog", () => {
	// Crucially different from "[]": an empty list means the plan has no
	// models, which would make the caller drop the static catalog.
	assert.equal(parseCatalog({ unexpected: true }), undefined);
	assert.equal(parseCatalog(null), undefined);
	assert.equal(parseCatalog("nope"), undefined);
	assert.equal(parseCatalog(42), undefined);
	assert.deepEqual(parseCatalog({ models: [] }), [], "an explicit empty array IS an empty catalog");
});

test("duplicate slugs are dropped, per the CLI's own catalog rule", () => {
	const models = parseCatalog({ models: [entry(), entry({ display_name: "dupe" })] });
	assert.equal(models?.length, 1, "catalog must contain unique model slugs");
});

test("malformed entries are skipped without discarding valid ones", () => {
	const models = parseCatalog({ models: [
		entry(),
		entry({ slug: "" }),
		entry({ slug: "bad slug!" }),
		entry({ slug: "../etc/passwd" }),
		null,
		"string-entry",
		entry({ slug: "gpt-6-astra" }),
	] });
	assert.deepEqual(models?.map((m) => m.slug), ["gpt-6.1-sol", "gpt-6-astra"]);
});

test("nonsense limits are dropped rather than trusted", () => {
	const models = parseCatalog({ models: [entry({
		context_window: -1, max_output_tokens: 0, supported_reasoning_levels: ["ok", 42, "BAD LEVEL", ""],
	})] });
	assert.equal(models?.[0].contextWindow, undefined, "a negative context window is not a limit");
	assert.equal(models?.[0].maxOutputTokens, undefined);
	assert.deepEqual(models?.[0].supportedReasoningLevels, ["ok"], "only well-formed level names survive");
});

test("id is accepted as an alias for slug", () => {
	assert.equal(parseCatalog({ models: [{ id: "gpt-6-luna" }] })?.[0].slug, "gpt-6-luna");
});

test("a display name cannot smuggle control characters into the UI", () => {
	const models = parseCatalog({ models: [entry({ display_name: "  GPT\u0000X\u001b[31m  " })] });
	assert.ok(!/[\x00-\x1f\x7f]/.test(models?.[0].displayName ?? "x"), "control characters must be stripped");
});

test("failures are described without echoing a token", () => {
	const body = JSON.stringify({ error: { message: "denied for token ya29.leaked-value-1//2" } });
	const text = describeFailure("Codex model catalog", 403, body);
	assert.match(text, /HTTP 403/);
	assert.match(text, /static catalog/, "the user must learn the fallback happened");
	assert.ok(!text.includes("ya29.leaked-value"), "no token may appear in a failure message");
	assert.ok(!/GOCSPX-|sk-ant-/.test(text));
});

test("a 401 is reported as a credential problem, not a protocol change", () => {
	assert.match(describeFailure("Codex model catalog", 401, ""), /Run \/login/);
});

test("refreshModels returns the account's catalog when the endpoint answers", async () => {
	const provider = providerWith((async () => json({ models: [entry(), entry({ slug: "gpt-6-astra", display_name: "GPT-6 Astra" })] })) as FetchImplementation);
	const models = await provider.refreshModels?.(refreshContext({ access: "token-synthetic" }));
	assert.equal(models?.length, 2);
	assert.deepEqual(models?.map((m) => m.id).sort(), ["gpt-6-astra", "gpt-6.1-sol"]);
});

test("the server's context window replaces the static value", async () => {
	const provider = providerWith((async () => json({ models: [entry({ context_window: 123_456 })] })) as FetchImplementation);
	const models = await provider.refreshModels?.(refreshContext({ access: "token" }));
	assert.equal((models?.[0] as { contextWindow?: number }).contextWindow, 123_456);
});

test("a model the static catalog lacks is still offered", async () => {
	const provider = providerWith((async () => json({ models: [entry({ slug: "brand-new-model", display_name: "Brand New" })] })) as FetchImplementation);
	const models = await provider.refreshModels?.(refreshContext({ access: "token" }));
	assert.equal(models?.[0].id, "brand-new-model", "discovery must not hide a model the account offers");
});

test("a model the account no longer lists is dropped, not re-added", async () => {
	// The whole point of discovery: a static list would keep offering it.
	const provider = providerWith((async () => json({ models: [entry({ slug: "gpt-6-astra" })] })) as FetchImplementation);
	const models = await provider.refreshModels?.(refreshContext({ access: "token" }));
	assert.deepEqual(models?.map((m) => m.id), ["gpt-6-astra"]);
});

test("every failure falls back to the static catalog", async () => {
	const staticIds = staticModels().map((m) => m.id);
	assert.ok(staticIds.length > 0, "the fallback itself must be non-empty");
	const failures: Array<[string, FetchImplementation]> = [
		["404 (endpoint may not exist)", (async () => json({ error: "not found" }, 404)) as FetchImplementation],
		["403 (plan or identity refused)", (async () => json({ error: "forbidden" }, 403)) as FetchImplementation],
		["401", (async () => json({ error: "unauthorized" }, 401)) as FetchImplementation],
		["500", (async () => json({ error: "boom" }, 500)) as FetchImplementation],
		["429", (async () => json({ error: "slow down" }, 429)) as FetchImplementation],
		["invalid JSON", (async () => new Response("<html>not json</html>")) as FetchImplementation],
		["unrecognized envelope", (async () => json({ surprise: true })) as FetchImplementation],
		["empty catalog", (async () => json({ models: [] })) as FetchImplementation],
		["network failure", (async () => { throw new Error("ECONNRESET"); }) as FetchImplementation],
	];
	for (const [label, fetchImpl] of failures) {
		const provider = providerWith(fetchImpl);
		const models = await provider.refreshModels?.(refreshContext({ access: "token" }));
		assert.deepEqual(models?.map((m) => m.id), staticIds, `${label} must fall back to the full static catalog`);
	}
});

test("discovery never runs without network permission or a credential", async () => {
	let calls = 0;
	const counting: FetchImplementation = async () => { calls++; return json({ models: [entry()] }); };
	const provider = providerWith(counting);

	await provider.refreshModels?.(refreshContext({ access: "token" }, false));
	assert.equal(calls, 0, "allowNetwork: false must not reach the network");

	for (const credential of [undefined, {}, { access: "" }, { access: 123 }, { access: "has space" }]) {
		const before: number = calls;
		const models = await provider.refreshModels?.(refreshContext(credential));
		assert.equal(calls, before, `${JSON.stringify(credential)} must not reach the network`);
		assert.deepEqual(models?.map((m) => m.id), staticModels().map((m) => m.id));
	}
});

test("the catalog request carries the bearer token and refuses redirects", async () => {
	let seen: { url: string; init?: RequestInit } | undefined;
	const provider = providerWith((async (url: string, init?: RequestInit) => {
		seen = { url: String(url), init };
		return json({ models: [entry()] });
	}) as FetchImplementation);
	await provider.refreshModels?.(refreshContext({ access: "token-synthetic" }));
	assert.equal(seen?.url, "https://chatgpt.com/backend-api/codex/models");
	const headers = seen?.init?.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer token-synthetic");
	assert.equal(seen?.init?.redirect, "error", "a redirect on a credentialed call must not be followed");
});

test("an aborted refresh does not throw out of refreshModels", async () => {
	const controller = new AbortController();
	controller.abort();
	const provider = providerWith((async () => json({ models: [entry()] })) as FetchImplementation);
	const models = await provider.refreshModels?.(refreshContext({ access: "token" }, true, { signal: controller.signal }));
	assert.deepEqual(models?.map((m) => m.id), staticModels().map((m) => m.id), "an abort degrades to the fallback");
});

test("fetchCodexCatalog requires a usable token", async () => {
	for (const bad of ["", " ", "has space", 42 as unknown as string]) {
		await assert.rejects(fetchCodexCatalog(bad), /Run \/login/);
	}
});

test("mergeCatalog preserves server order and adds nothing", () => {
	const merged = mergeCatalog(
		[{ slug: "b", supportedReasoningLevels: [] }, { slug: "a", supportedReasoningLevels: [] }],
		staticModels(),
	);
	assert.deepEqual(merged.map((m) => m.id), ["b", "a"], "server order is preserved; nothing is appended");
});

test("only reasoning levels the server reported are advertised", () => {
	const config = toModelConfig(
		{ slug: "m", supportedReasoningLevels: ["low", "high"], defaultReasoningLevel: "low" },
		staticModels(),
	) as { thinkingLevelMap?: Record<string, string> };
	assert.deepEqual(Object.keys(config.thinkingLevelMap ?? {}).sort(), ["high", "low"],
		"a level the server did not report must not appear");
});
