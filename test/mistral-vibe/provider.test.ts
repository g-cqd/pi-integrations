import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import { createMistralVibeProvider, MODEL_ID, selectMistralLarge4 } from "../../src/domains/mistral-vibe/provider.ts";
import { sequenceFetch, virtualClock, loginCallbacks } from "../support/fixtures.ts";

function fixture(payloads: unknown[]) {
	const { calls, fetchImpl } = sequenceFetch(payloads);
	const clock = virtualClock(Date.parse("2030-01-01T00:00:00Z"));
	const links: string[] = [];
	const config = createMistralVibeProvider({
		models: [], streamSimple: () => { throw new Error("Do not infer during login"); },
		fetchImpl, ...clock,
	});
	const callbacks = loginCallbacks({ onAuth: ({ url }) => { links.push(url); } });
	return { config, calls, callbacks, links };
}

const process = {
	process_id: "synthetic-process", sign_in_url: "https://console.mistral.ai/vibe/sign-in?process=synthetic",
	poll_url: "https://console.mistral.ai/api/vibe/sign-in/synthetic-process",
	expires_at: "2030-01-01T00:01:00Z",
};
const complete = { status: "completed", exchange_token: "synthetic-exchange-token" };

test("full Vibe browser login binds process creation to a PKCE exchange and returns an API key", async () => {
	const f = fixture([process, { status: "pending" }, complete, { api_key: "synthetic-mistral-key" }]);
	const credentials = await f.config.oauth!.login(f.callbacks);
	assert.equal(credentials.access, "synthetic-mistral-key");
	assert.equal(credentials.refresh, "", "there is no OAuth refresh token in this protocol");
	assert.deepEqual(f.links, [process.sign_in_url]);
	assert.equal(f.calls[0].url, "https://console.mistral.ai/api/vibe/sign-in");
	assert.equal(f.calls[3].url, "https://console.mistral.ai/api/vibe/sign-in/synthetic-process/exchange");
	const start = JSON.parse(String(f.calls[0].init.body));
	const exchange = JSON.parse(String(f.calls[3].init.body));
	assert.equal(start.code_challenge_method, "S256");
	assert.equal(start.code_challenge, createHash("sha256").update(exchange.code_verifier).digest("base64url"));
	assert.equal(exchange.exchange_token, complete.exchange_token);
	assert.equal(await f.config.oauth!.refreshToken(credentials, new AbortController().signal), credentials);
	assert.equal(f.calls.length, 4, "no fabricated refresh request");
});

for (const patch of [
	{ poll_url: "https://untrusted.invalid/steal" },
	{ poll_url: "https://console.mistral.ai/outside-api" },
	{ poll_url: "https://user:password@console.mistral.ai/api/poll" },
	{ sign_in_url: "https://untrusted.invalid/login" },
	{ process_id: "../other-process" },
	{ expires_at: "not-a-date" },
	{ expires_at: "2029-12-31T23:00:00Z" },
]) {
	test(`invalid Vibe process metadata fails before browser/poll: ${Object.keys(patch)[0]} ${JSON.stringify(patch)}`, async () => {
		const f = fixture([{ ...process, ...patch }]);
		await assert.rejects(f.config.oauth!.login(f.callbacks));
		assert.equal(f.calls.length, 1);
		assert.equal(f.links.length, 0);
	});
}

for (const status of ["denied", "expired", "error", "unknown"]) {
	test(`Vibe terminal state ${status} does not exchange credentials`, async () => {
		const f = fixture([process, { status, message: "synthetic-sensitive-server-message" }]);
		await assert.rejects(f.config.oauth!.login(f.callbacks), (error: Error) => {
			assert.ok(!error.message.includes("synthetic-sensitive-server-message"));
			return true;
		});
		assert.equal(f.calls.length, 2);
	});
}

test("completed state without an exchange token is rejected", async () => {
	const f = fixture([process, { status: "completed" }]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), /exchange/i);
	assert.equal(f.calls.length, 2);
});

for (const key of [undefined, "", "key with whitespace"]) {
	test(`exchange rejects malformed API key: ${String(key)}`, async () => {
		const f = fixture([process, complete, { api_key: key }]);
		await assert.rejects(f.config.oauth!.login(f.callbacks), /key/i);
		assert.equal(f.calls.length, 3);
	});
}

test("uncertain exchange failure is sanitized and not retried", async () => {
	const f = fixture([process, complete, new Error("synthetic-exchange-token")]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), (error: Error) => !error.message.includes("synthetic-exchange-token"));
	assert.equal(f.calls.length, 3);
});

test("Vibe login deadline is tested without real sleeps", async () => {
	const f = fixture([process, ...Array.from({ length: 25 }, () => ({ status: "pending" }))]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), /timed out/i);
	assert.ok(f.calls.length <= 22);
});

test("Vibe login cancellation prevents any credential exchange", async () => {
	const f = fixture([process]);
	const controller = new AbortController();
	f.callbacks.signal = controller.signal;
	f.callbacks.onAuth = () => controller.abort();
	await assert.rejects(f.config.oauth!.login(f.callbacks), { name: "AbortError" });
	assert.equal(f.calls.length, 1);
});

test("Mistral domain has no Keychain or first-party identity override", () => {
	const f = fixture([]);
	assert.equal(f.config.headers, undefined);
	assert.equal(f.calls.length, 0);
	assert.equal(f.config.oauth!.isSubscription, undefined, "browser sign-in is not proof of subscription billing");
});

test("the domain offers exactly Mistral Large 4", () => {
	assert.equal(MODEL_ID, "mistral-large-4");
	const catalog = [{ id: "mistral-small-2603" }, { id: "mistral-large-4", extra: 1 }, { id: "codestral-2508" }];
	assert.deepEqual(selectMistralLarge4(catalog), [{ id: "mistral-large-4", extra: 1 }]);
});

test("a catalog without a unique Large 4 fails loudly instead of offering another model", () => {
	assert.throws(() => selectMistralLarge4([{ id: "mistral-small-2603" }]), /no unique "mistral-large-4"/);
	assert.throws(() => selectMistralLarge4([]), /found 0/);
	assert.throws(() => selectMistralLarge4([{ id: "mistral-large-4" }, { id: "mistral-large-4" }]), /found 2/);
});

test("Vibe sign-in is the only credential path: no API-key configuration is declared", () => {
	const f = fixture([]);
	assert.equal(f.config.apiKey, undefined);
	assert.ok(f.config.oauth);
});

// ---------------------------------------------------------------------------
// Transport-level poll failures
//
// The terminal states above are all reported in the poll body. These are the
// paths where the request itself fails, which the domain maps to its own
// guidance rather than surfacing a raw transport error.
// ---------------------------------------------------------------------------

test("an HTTP 410 from the poll endpoint is reported as an expired sign-in", async () => {
	const f = fixture([process, new Response("gone", { status: 410 })]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), /expired/i);
	assert.equal(f.calls.length, 2, "no exchange is attempted after an expired process");
});

test("a non-410 poll failure propagates without being relabelled", async () => {
	// 410 is the only status with domain meaning; anything else must not be
	// dressed up as "expired", or a transient outage looks like a dead login.
	const f = fixture([process, new Response("boom", { status: 500 })]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), (error: Error) => {
		assert.ok(!/expired/i.test(error.message), `a 500 must not be reported as expired: ${error.message}`);
		return true;
	});
	assert.equal(f.calls.length, 2);
});

test("a completed poll with no exchange token fails before the exchange", async () => {
	const f = fixture([process, { status: "completed" }]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), /exchange token/i);
	assert.equal(f.calls.length, 2, "no exchange request without a token to exchange");
});

test("an exchange that returns no API key fails", async () => {
	const f = fixture([process, complete, {}]);
	await assert.rejects(f.config.oauth!.login(f.callbacks), /no valid API key/i);
});
