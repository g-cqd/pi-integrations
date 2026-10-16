import assert from "node:assert/strict";
import { test } from "bun:test";
import { apiKeyCredentials, generatePKCE, trustedUrl, validSecret } from "../../src/shared/index.ts";

for (const value of [null, undefined, "", "key with space", "key\n", "key\u0000", "key\u007f", "k".repeat(16385)]) {
	test(`secret validator rejects malformed input (${typeof value}, ${String(value).length})`, () => assert.equal(validSecret(value), false));
}

test("API-key bookkeeping does not invent a refresh token or accept a malformed clock", () => {
	const credential = apiKeyCredentials("synthetic-key", 1000);
	assert.equal(credential.access, "synthetic-key");
	assert.equal(credential.refresh, "");
	assert.ok(credential.expires > 1000);
	for (const now of [NaN, Infinity, -1]) assert.throws(() => apiKeyCredentials("synthetic-key", now));
});

for (const url of ["https://example.test/api-other/poll", "https://evil.invalid/api/poll", "https://example.test/api/%2fother", "https://example.test/api/%5cother", "https://example.test/api/%2e%2e/other"]) {
	test(`trusted URL respects origin and path boundaries (${url})`, () => assert.throws(() => trustedUrl(url, "https://example.test/api")));
}

test("trusted URL accepts an exact origin including its canonical default HTTPS port", () => {
	assert.equal(trustedUrl("https://example.test:443/api/poll?session=synthetic", "https://example.test/api"), "https://example.test/api/poll?session=synthetic");
});

test("PKCE generation does not retain verifier state between domains", async () => {
	const results = await Promise.all(Array.from({ length: 16 }, () => generatePKCE()));
	assert.equal(new Set(results.map(r => r.verifier)).size, 16);
	assert.ok(results.every(r => /^[A-Za-z0-9_-]{43}$/.test(r.challenge)));
});
