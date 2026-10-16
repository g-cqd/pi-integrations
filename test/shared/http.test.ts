import assert from "node:assert/strict";
import { test } from "bun:test";
import { requestJson, safeBaseUrl, waitFor, type FetchImplementation } from "../../src/shared/index.ts";

for (const status of [400, 401, 403, 404, 410, 429, 500]) {
	test(`HTTP ${status} preserves status but not secret response content`, async () => {
		let calls = 0;
		await assert.rejects(requestJson("https://example.test", {}, { fetchImpl: async () => { calls++; return new Response("synthetic-private-token", { status }); } }), (error: Error) => {
			assert.match(error.message, new RegExp(String(status)));
			assert.ok(!error.message.includes("synthetic-private-token"));
			return true;
		});
		assert.equal(calls, 1);
	});
}

test("JSON transport refuses redirects and supplies a bounded signal", async () => {
	const fetchImpl: FetchImplementation = async (_url, init) => {
		assert.equal(init?.redirect, "error");
		assert.ok(init?.signal instanceof AbortSignal);
		return Response.json({ ok: true });
	};
	assert.deepEqual(await requestJson("https://example.test", {}, { fetchImpl }), { ok: true });
});

test("pre-aborted transport does not call fetch", async () => {
	const controller = new AbortController(); controller.abort();
	let calls = 0;
	await assert.rejects(requestJson("https://example.test", {}, { signal: controller.signal, fetchImpl: async () => { calls++; return Response.json({}); } }), { name: "AbortError" });
	assert.equal(calls, 0);
});

for (const body of ["not-json synthetic-private-token", "x".repeat(1024 * 1024 + 1)]) {
	test(`malformed/oversized JSON response is rejected (${body.length} bytes)`, async () => {
		await assert.rejects(requestJson("https://example.test", {}, { fetchImpl: async () => new Response(body) }), (error: Error) => !error.message.includes("synthetic-private-token"));
	});
}

for (const url of ["http://remote.invalid", "https://name:secret@example.test", "https://example.test/?secret=value", "file:///etc/passwd"]) {
	test(`unsafe configured API base is rejected (${new URL(url).protocol})`, () => assert.throws(() => safeBaseUrl(url)));
}

test("API base normalization preserves HTTPS paths and explicit loopback development", () => {
	assert.equal(safeBaseUrl("https://example.test/api/"), "https://example.test/api");
	assert.equal(safeBaseUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
});

test("cancelled polling delay rejects immediately", async () => {
	const controller = new AbortController(); controller.abort();
	await assert.rejects(waitFor(2000, controller.signal), { name: "AbortError" });
});
