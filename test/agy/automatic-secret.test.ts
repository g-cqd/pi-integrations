import assert from "node:assert/strict";
import { test } from "bun:test";
import { locateAgyBinary } from "../../src/domains/agy/client-secret.ts";
import { createAutomaticSecretResolver } from "../../src/domains/agy/secret-resolver.ts";

test("binary discovery prefers override, then PATH, then GUI-safe absolute paths", () => {
	assert.equal(locateAgyBinary({ AGY_BINARY: "/custom/agy" }, () => false), "/custom/agy");
	const files = new Set(["/custom/agy", "/opt/homebrew/bin/agy"]);
	assert.equal(locateAgyBinary({ PATH: "/custom" }, p => files.has(p)), "/custom/agy");
	assert.equal(locateAgyBinary({ PATH: "" }, p => files.has(p)), "/opt/homebrew/bin/agy");
	assert.equal(locateAgyBinary({ PATH: "/tarball" }, p => p === "/tarball/antigravity"), "/tarball/antigravity");
	assert.equal(locateAgyBinary({}, () => false), undefined);
});

test("discovery rejects decoys, caches accepted values in memory, and never writes files", async () => {
	let calls = 0, scans = 0;
	const resolve = createAutomaticSecretResolver({ env: {}, candidates: () => { scans++; return ["synthetic-decoy", "synthetic-valid"]; },
		fetchImpl: async (_url, init) => {
			calls++;
			const secret = new URLSearchParams(String(init?.body)).get("client_secret");
			assert.equal(init?.redirect, "error");
			// Google answers invalid_client with 401 and invalid_grant with 400
			// (verified live); the error code is the signal, not the status.
			return secret === "synthetic-valid"
				? Response.json({ error: "invalid_grant" }, { status: 400 })
				: Response.json({ error: "invalid_client" }, { status: 401 });
		} });
	assert.equal(await resolve(), "synthetic-valid");
	assert.equal(await resolve(), "synthetic-valid");
	assert.equal(calls, 2);
	assert.equal(scans, 1);
});

test("inconclusive responses stop discovery rather than guessing", async () => {
	let calls = 0;
	const resolve = createAutomaticSecretResolver({ env: {}, candidates: () => ["synthetic-a", "synthetic-b"],
		fetchImpl: async () => { calls++; return Response.json({ error: "invalid_grant" }, { status: 429 }); } });
	await assert.rejects(resolve(), /could not verify/);
	assert.equal(calls, 1);
});

test("a 401 invalid_client advances to the next candidate instead of aborting", async () => {
	// The exact live failure: Google returns invalid_client with 401, and the
	// first sliced candidate is a truncation of the real secret.
	const tried: string[] = [];
	const resolve = createAutomaticSecretResolver({
		env: {},
		candidates: () => ["synthetic-truncated", "synthetic-real"],
		fetchImpl: async (_url, init) => {
			const secret = new URLSearchParams(String(init?.body)).get("client_secret")!;
			tried.push(secret);
			return secret === "synthetic-real"
				? Response.json({ error: "invalid_grant" }, { status: 400 })
				: Response.json({ error: "invalid_client" }, { status: 401 });
		},
	});
	assert.equal(await resolve(), "synthetic-real");
	assert.deepEqual(tried, ["synthetic-truncated", "synthetic-real"]);
});

test("cancelled discovery never scans or makes a request", async () => {
	const resolve = createAutomaticSecretResolver({ env: {}, candidates: () => { throw new Error("must not scan"); } });
	await assert.rejects(resolve(AbortSignal.abort()), { name: "AbortError" });
});
