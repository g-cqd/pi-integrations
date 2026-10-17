import assert from "node:assert/strict";
import { test } from "bun:test";
import {
	DEFAULT_BASE_URL, PRODUCTION_BASE_URL, USER_AGENT, clientMetadata, describeFailure, fetchAvailableModels, loadCodeAssist,
	platformName, requestHeaders, resolveBaseUrl,
} from "../../src/domains/agy/cloudcode.ts";
import { sequenceFetch } from "../support/fixtures.ts";

// Synthetic only: tokens, project ids, and bodies are invented. No network.

const BASE = "https://cloudcode.example.test";
const TOKEN = "synthetic-access-token";
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(value), { status, headers });

test("the default host is the one the real CLI calls; production is selectable; unsafe overrides are refused", () => {
	assert.equal(DEFAULT_BASE_URL, "https://daily-cloudcode-pa.googleapis.com");
	assert.equal(PRODUCTION_BASE_URL, "https://cloudcode-pa.googleapis.com");
	assert.equal(resolveBaseUrl({}), DEFAULT_BASE_URL);
	assert.equal(resolveBaseUrl({ AGY_API_URL: "  https://cloudcode-pa.googleapis.com/  " }), PRODUCTION_BASE_URL);
	assert.equal(resolveBaseUrl({ AGY_API_URL: "" }), DEFAULT_BASE_URL);
	for (const bad of ["http://remote.example", "https://u:p@example.test", "https://example.test/?x=1", "file:///etc/passwd"]) {
		assert.throws(() => resolveBaseUrl({ AGY_API_URL: bad }), /Unsafe|Invalid/, bad);
	}
});

test("platform names map to the ClientMetadata enum, with a safe fallback", () => {
	assert.equal(platformName("darwin", "arm64"), "DARWIN_ARM64");
	assert.equal(platformName("darwin", "x64"), "DARWIN_AMD64");
	assert.equal(platformName("linux", "arm64"), "LINUX_ARM64");
	assert.equal(platformName("linux", "x64"), "LINUX_AMD64");
	assert.equal(platformName("win32", "x64"), "WINDOWS_AMD64");
	assert.equal(platformName("freebsd", "x64"), "PLATFORM_UNSPECIFIED");
	assert.equal(clientMetadata().ideType, "ANTIGRAVITY");
});

test("request headers carry the bearer token and an honest user agent", () => {
	const headers = requestHeaders(TOKEN);
	assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
	assert.equal(headers["User-Agent"], USER_AGENT);
	// The backend gates the consumer project on the UA naming the Antigravity
	// client (verified live: same token, project only with this prefix). Ours
	// leads with it and keeps this package's identity after.
	assert.match(USER_AGENT, /^antigravity-[0-9.]+ /);
	assert.match(USER_AGENT, /pi-integrations\//);
});

// ---------------------------------------------------------------------------
// describeFailure
// ---------------------------------------------------------------------------

test("a failure report has the status, a hint, Google's status code, a redacted message, and an id", () => {
	const text = describeFailure("Antigravity request", 403,
		{ "x-cloudaicompanion-trace-id": "trace-abc" },
		JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "No access for token ya29.synthetic-token-value" } }));
	for (const expected of [/Antigravity request failed: HTTP 403\./, /not permitted/, /google status: PERMISSION_DENIED/, /No access for token \[redacted-token\]/, /x-cloudaicompanion-trace-id: trace-abc/]) {
		assert.match(text, expected);
	}
	assert.ok(!text.includes("synthetic-token-value"));
});

test("every known status has a hint and 5xx is called a server error", () => {
	for (const status of [400, 401, 403, 404, 429]) assert.match(describeFailure("x", status, {}, ""), new RegExp(`HTTP ${status}\\.\\n.+`));
	assert.match(describeFailure("x", 503, {}, ""), /server error/);
	assert.ok(!/\n/.test(describeFailure("x", 418, {}, "")), "unknown statuses add nothing speculative");
});

test("secrets of every known shape are redacted and control characters flattened", () => {
	const message = "a ya29.AAA-bbb b 1//0gCCC c GOCSPX-ddd_eee d sk-ant-oat01-fff\u0007\nline";
	const text = describeFailure("x", 400, {}, JSON.stringify({ error: { message } }));
	assert.equal((text.match(/\[redacted-token\]/g) ?? []).length, 4);
	for (const leaked of ["AAA-bbb", "0gCCC", "ddd_eee", "oat01-fff", "\u0007"]) assert.ok(!text.includes(leaked));
});

test("hostile fields are dropped: non-allowlisted status, non-numeric retry-after, long messages, non-JSON bodies", () => {
	const text = describeFailure("x", 429, { "retry-after": "<script>" },
		JSON.stringify({ error: { status: "not allowed!", message: "m".repeat(1000) } }));
	assert.ok(!/google status/.test(text));
	assert.ok(!/retry-after/.test(text));
	assert.ok(text.length < 700);
	assert.ok(!describeFailure("x", 400, {}, "<html>synthetic-secret-page</html>").includes("synthetic-secret-page"));
	assert.match(describeFailure("x", 429, { "retry-after": "30" }, ""), /retry-after: 30s/);
});

test("a Headers object works the same as a plain record", () => {
	const headers = new Headers({ "x-goog-request-id": "req-1", "retry-after": "5" });
	const text = describeFailure("x", 429, headers, "");
	assert.match(text, /x-goog-request-id: req-1/);
	assert.match(text, /retry-after: 5s/);
});

// ---------------------------------------------------------------------------
// loadCodeAssist
// ---------------------------------------------------------------------------

test("account lookup posts the client metadata and returns the project and tier", async () => {
	const f = sequenceFetch([{ cloudaicompanionProject: "synthetic-project-123", currentTier: { id: "standard-tier", name: "Standard" } }]);
	const account = await loadCodeAssist(TOKEN, { baseUrl: BASE, fetchImpl: f.fetchImpl });
	assert.deepEqual(account, { projectId: "synthetic-project-123", tierId: "standard-tier", tierName: "Standard" });
	assert.equal(f.calls[0].url, `${BASE}/v1internal:loadCodeAssist`);
	assert.equal(new Headers(f.calls[0].init.headers).get("authorization"), `Bearer ${TOKEN}`);
	const body = JSON.parse(String(f.calls[0].init.body));
	assert.equal(body.metadata.ideType, "ANTIGRAVITY");
	assert.equal(body.mode, "FULL_ELIGIBILITY_CHECK");
	assert.ok(!JSON.stringify(body).includes(TOKEN), "the token travels only in the header");
});

test("a project object, and a paid tier when there is no current tier, are understood", async () => {
	const object = sequenceFetch([{ cloudaicompanionProject: { id: "synthetic-project-9" }, paidTier: { id: "paid", name: "Pro" } }]);
	assert.deepEqual(await loadCodeAssist(TOKEN, { baseUrl: BASE, fetchImpl: object.fetchImpl }), { projectId: "synthetic-project-9", tierId: "paid", tierName: "Pro" });
});

test("no project means onboarding is needed: a clear error with only allowlisted reasons", async () => {
	const f = sequenceFetch([{ currentTier: { id: "free-tier", name: "Free" }, ineligibleTiers: [
		{ reasonCode: "UNSUPPORTED_LOCATION", reasonMessage: "synthetic-detail" }, { reasonCode: "lowercase-bad", reasonMessage: "x" }, null, { reasonCode: 5 }] }]);
	await assert.rejects(loadCodeAssist(TOKEN, { baseUrl: BASE, fetchImpl: f.fetchImpl }), (e: Error) => {
		assert.match(e.message, /no Antigravity Cloud Code project \(tier: Free\)/);
		assert.match(e.message, /Ineligible: UNSUPPORTED_LOCATION\./);
		assert.match(e.message, /Finish onboarding once in the `agy` CLI/);
		assert.ok(!e.message.includes("synthetic-detail") && !e.message.includes("lowercase-bad"));
		return true;
	});
});

test("a hostile project id is refused, and HTTP failures carry the credential-safe report", async () => {
	for (const bad of ["has space", "../../x", "a/b", "-leading-dash", "", 42, "x".repeat(200)]) {
		await assert.rejects(loadCodeAssist(TOKEN, { baseUrl: BASE, fetchImpl: sequenceFetch([{ cloudaicompanionProject: bad }]).fetchImpl }), /no Antigravity Cloud Code project/);
	}
	const denied = sequenceFetch([json({ error: { status: "PERMISSION_DENIED", message: `token ${TOKEN}` } }, 403)]);
	await assert.rejects(loadCodeAssist(TOKEN, { baseUrl: BASE, fetchImpl: denied.fetchImpl }), (e: Error) => /HTTP 403/.test(e.message) && /PERMISSION_DENIED/.test(e.message));
	await assert.rejects(loadCodeAssist(TOKEN, { baseUrl: BASE, fetchImpl: sequenceFetch([new Response("not json")]).fetchImpl }), /invalid response/);
});

// ---------------------------------------------------------------------------
// fetchAvailableModels
// ---------------------------------------------------------------------------

const details = (over: Record<string, unknown> = {}) => ({
	displayName: "Synthetic Model", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, ...over,
});
const catalog = (over: Record<string, unknown> = {}) => ({
	models: { "m-low": details({ displayName: "M (Low)" }), "m-high": details({ displayName: "M (High)", supportsImages: false }), "tab-model": details({ displayName: "Tab", isInternal: true }), "off": details({ disabled: true }) },
	defaultAgentModelId: "m-high",
	agentModelSorts: [{ displayName: "Recommended", groups: [{ displayName: "g", modelIds: ["m-high", "m-low", "off", "missing", "bad id!"] }] }],
	...over,
});

test("the catalog follows the server's agent groups, in order, skipping disabled, missing, and malformed ids", async () => {
	const f = sequenceFetch([catalog()]);
	const result = await fetchAvailableModels(TOKEN, { baseUrl: BASE, projectId: "synthetic-project", fetchImpl: f.fetchImpl });
	assert.deepEqual(result.models.map((m) => m.id), ["m-high", "m-low"]);
	assert.equal(result.defaultModelId, "m-high");
	assert.deepEqual(result.models[0], { id: "m-high", displayName: "M (High)", supportsImages: false, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, recommended: false, preview: false });
	assert.equal(f.calls[0].url, `${BASE}/v1internal:fetchAvailableModels`);
	assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { project: "synthetic-project" });
});

test("without agent groups every enabled, non-internal model is listed", async () => {
	const f = sequenceFetch([catalog({ agentModelSorts: undefined })]);
	assert.deepEqual((await fetchAvailableModels(TOKEN, { baseUrl: BASE, projectId: "p", fetchImpl: f.fetchImpl })).models.map((m) => m.id), ["m-low", "m-high"]);
});

test("limits are taken as reported and never invented", async () => {
	const f = sequenceFetch([catalog({ models: { a: details({ maxTokens: -1, maxOutputTokens: 1.5 }), b: details({ maxTokens: "big", maxOutputTokens: 0 }), c: { displayName: "  " } }, agentModelSorts: undefined })]);
	const result = await fetchAvailableModels(TOKEN, { baseUrl: BASE, projectId: "p", fetchImpl: f.fetchImpl });
	for (const model of result.models) { assert.equal(model.maxTokens, undefined); assert.equal(model.maxOutputTokens, undefined); }
	assert.equal(result.models.find((m) => m.id === "c")!.displayName, "c", "a blank name falls back to the id");
});

test("a malformed catalog envelope fails explicitly, and HTTP failures are described", async () => {
	for (const bad of [null, {}, { models: [] }, { models: "x" }]) {
		await assert.rejects(fetchAvailableModels(TOKEN, { baseUrl: BASE, projectId: "p", fetchImpl: sequenceFetch([bad]).fetchImpl }), /Invalid (Antigravity model list|provider response)/);
	}
	await assert.rejects(fetchAvailableModels(TOKEN, { baseUrl: BASE, projectId: "p", fetchImpl: sequenceFetch([json({ error: { status: "UNAUTHENTICATED" } }, 401)]).fetchImpl }), /HTTP 401[\s\S]*UNAUTHENTICATED/);
});
