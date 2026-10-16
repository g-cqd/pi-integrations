import assert from "node:assert/strict";
import { test } from "bun:test";
import { createSpettroProvider, CATALOG_PLACEHOLDER } from "../../src/domains/spettro/provider.ts";
import { sequenceFetch, virtualClock, loginCallbacks } from "../support/fixtures.ts";

function fixture(payloads: unknown[] = []) {
	const { calls, fetchImpl } = sequenceFetch(payloads);
	const clock = virtualClock();
	let streams = 0;
	const config = createSpettroProvider({
		env: {}, fetchImpl, ...clock,
		streamSimple: () => { streams++; throw new Error("synthetic-stream-sentinel"); },
	});
	const links: string[] = [];
	const callbacks = loginCallbacks({ onAuth: ({ url }) => { links.push(url); } });
	return { calls, config, callbacks, links, streams: () => streams };
}

const browser = { browser_url: "https://spettro.app/auth/cli?session=synthetic" };
const complete = { status: "complete", api_key: "synthetic-spettro-key" };

test("device login waits through pending and returns a key without refreshing it", async () => {
	const f = fixture([browser, { status: "pending" }, complete]);
	const credentials = await f.config.oauth!.login(f.callbacks);
	assert.equal(credentials.access, complete.api_key);
	assert.equal(credentials.refresh, complete.api_key);
	assert.deepEqual(f.links, [browser.browser_url]);
	const session = JSON.parse(String(f.calls[0].init.body)).session_id;
	assert.match(session, /^[a-f0-9-]{36}$/);
	assert.equal(f.calls[1].url, `https://api.spettro.app/auth/poll/${session}`);
	assert.equal(f.calls.length, 3);
	assert.equal(await f.config.oauth!.refreshToken(credentials, new AbortController().signal), credentials);
	assert.equal(f.calls.length, 3, "there is no device-key refresh endpoint");
});

for (const result of [{ status: "expired" }, { status: "unknown" }, { status: "complete" }, null]) {
	test(`malformed/expired device result is rejected: ${JSON.stringify(result)}`, async () => {
		const f = fixture([browser, result]);
		await assert.rejects(f.config.oauth!.login(f.callbacks));
		assert.equal(f.calls.length, 2);
	});
}

for (const url of ["javascript:alert(1)", "http://untrusted.invalid/login", "https://user:secret@spettro.app/"]) {
	test(`unsafe browser URL is never shown: ${new URL(url).protocol}`, async () => {
		const f = fixture([{ browser_url: url }]);
		await assert.rejects(f.config.oauth!.login(f.callbacks));
		assert.equal(f.links.length, 0);
	});
}

test("cancellation after the browser link prevents polling", async () => {
	const f = fixture([browser]);
	const controller = new AbortController();
	f.callbacks.signal = controller.signal;
	f.callbacks.onAuth = () => controller.abort();
	await assert.rejects(f.config.oauth!.login(f.callbacks), { name: "AbortError" });
	assert.equal(f.calls.length, 1);
});

test("device login has a finite total deadline without real timer sleeps", async () => {
	const f = fixture([browser, ...Array.from({ length: 300 }, () => ({ status: "pending" }))]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), /timed out/i);
	assert.ok(f.calls.length <= 301);
});

test("network errors do not echo response bodies or credentials", async () => {
	const f = fixture([new Error("synthetic-spettro-secret")]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), (error: Error) => {
		assert.ok(!error.message.includes("synthetic-spettro-secret"));
		return true;
	});
});

test("catalog refresh never wipes the discoverable catalog", async () => {
	const f = fixture();
	const signal = new AbortController().signal;
	const offline = await f.config.refreshModels!({ allowNetwork: false, signal } as never);
	assert.deepEqual(offline.map((m) => m.id), [CATALOG_PLACEHOLDER]);
	const signedOut = await f.config.refreshModels!({ allowNetwork: true, signal } as never);
	assert.deepEqual(signedOut.map((m) => m.id), [CATALOG_PLACEHOLDER]);
	assert.equal(f.calls.length, 0, "no network request without a valid credential");
});

test("catalog filters malformed/duplicate entries and keeps classic system-role compatibility", async () => {
	const f = fixture([{ data: [null, {}, { id: "one", vision: true, reasoning: true, context_window: 32000 }, { id: "one" }, { id: "two", context_window: -1, vision: "false" }] }]);
	const result = await f.config.refreshModels!({ allowNetwork: true, credential: { access: "synthetic-catalog-key" }, signal: new AbortController().signal } as never);
	assert.deepEqual(result.map(m => m.id), ["one", "two"]);
	assert.deepEqual(result[0].input, ["text", "image"]);
	assert.deepEqual(result[1].input, ["text"]);
	assert.ok(result[1].type === undefined || result[1].type === "chat");
	assert.ok(result[0].type === undefined || result[0].type === "chat");
	assert.equal(result[1].contextWindow, 128000);
	assert.deepEqual(result[0].compat, { supportsDeveloperRole: false });
	assert.equal(new Headers(f.calls[0].init.headers).get("authorization"), "Bearer synthetic-catalog-key");
});

for (const payload of [null, {}, { data: {} }]) {
	test(`invalid catalog envelope fails explicitly: ${JSON.stringify(payload)}`, async () => {
		const f = fixture([payload]);
		await assert.rejects(f.config.refreshModels!({ allowNetwork: true, credential: { access: "synthetic-key" }, signal: new AbortController().signal } as never), /invalid.*(catalog|response)/i);
	});
}

test("placeholder cannot accidentally be sent as an inference model", () => {
	const f = fixture();
	assert.throws(() => f.config.streamSimple!({ id: CATALOG_PLACEHOLDER } as never, { messages: [] } as never), /catalog/i);
	assert.equal(f.streams(), 0);
});

test("sign-in is the only credential path: no API-key environment configuration is declared", () => {
	const f = fixture();
	assert.equal(f.config.apiKey, undefined);
	assert.ok(f.config.oauth);
});
