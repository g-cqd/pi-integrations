import assert from "node:assert/strict";
import { spyOn, test } from "bun:test";
import {
	parseAuthorizationCode,
	refreshCredentials,
	revokeCredentials,
	toCredentials,
	type TokenResponse,
	type FetchImplementation,
} from "../../src/domains/claude/oauth.ts";

// Synthetic credentials only. No capture files, stored credentials, or network.
const token: TokenResponse = {
	token_type: "Bearer",
	access_token: "synthetic-access-secret",
	refresh_token: "synthetic-refresh-secret",
	expires_in: 28800,
	scope: "user:profile",
};
const code = "synthetic_authorization_code_123";
const state = "expected_state_123";
const callback = "https://platform.claude.com/oauth/code/callback";

function mockResponse(status: number, text: string) {
	const calls: RequestInit[] = [];
	const fetchImpl = (async (_url: unknown, init: RequestInit) => {
		calls.push(init);
		return new Response(text, { status });
	}) as FetchImplementation;
	return { calls, fetchImpl };
}

test("callback parsing retains state instead of silently discarding it", () => {
	assert.deepEqual(parseAuthorizationCode(`${callback}?code=${code}&state=${state}`), { code, state });
});

test("expected state is required and must match for every accepted input form", () => {
	for (const input of [
		`${code}#wrong_state`, code,
		`${callback}?code=${code}&state=wrong_state`,
		`${callback}?code=${code}`,
	]) {
		assert.equal(parseAuthorizationCode(input, state), null);
	}
	assert.deepEqual(parseAuthorizationCode(`${code}#${state}`, state), { code, state });
	assert.deepEqual(parseAuthorizationCode(`${callback}?code=${code}&state=${state}`, state), { code, state });
});

test("callback parsing rejects foreign origins, duplicate parameters and ambiguous prose", () => {
	for (const input of [
		`https://untrusted.invalid/?code=${code}&state=${state}`,
		`http://platform.claude.com/oauth/code/callback?code=${code}&state=${state}`,
		`${callback}?code=${code}&code=other_code&state=${state}`,
		`${callback}?code=${code}&state=${state}&state=other_state`,
		`${callback}?code=${code}&state=${state}#code=other_code`,
		`arbitrary text code=${code}&state=${state}`,
		`first ${code}#${state} then ${code}#different_state`,
	]) {
		assert.equal(parseAuthorizationCode(input), null);
	}
});

for (const [field, value] of [
	["access_token", ""], ["refresh_token", ""], ["token_type", "Basic"],
	["expires_in", undefined], ["expires_in", 0], ["expires_in", -1],
	["expires_in", Infinity], ["expires_in", NaN], ["expires_in", "28800"],
	["expires_in", Number.MAX_VALUE], ["scope", {}],
	["refresh_token_expires_in", -1],
] as const) {
	test(`credential mapping rejects invalid ${field} (${String(value)})`, () => {
		assert.throws(() => toCredentials({ ...token, [field]: value } as TokenResponse), /invalid.*response/i);
	});
}

test("short positive TTL does not produce already-expired credentials", () => {
	const before = Date.now();
	const credentials = toCredentials({ ...token, expires_in: 60 });
	assert.ok(credentials.expires > before);
	assert.ok(credentials.expires <= Date.now() + 60000);
});

test("untrusted error response bodies are not echoed to users or logs", async () => {
	for (const body of [
		JSON.stringify({ error: { token: token.refresh_token, description: "user@example.test" } }),
		JSON.stringify({ error: token.access_token }),
		`<html>${token.refresh_token}</html>`,
	]) {
		const mock = mockResponse(400, body);
		await assert.rejects(refreshCredentials({ refresh: token.refresh_token }, mock), (error: Error) => {
			assert.match(error.message, /400/);
			assert.ok(!error.message.includes("synthetic-"));
			assert.ok(!error.message.includes("user@example.test"));
			return true;
		});
	}
});

test("malformed success responses do not expose the raw body", async () => {
	const mock = mockResponse(200, token.access_token);
	await assert.rejects(refreshCredentials({ refresh: token.refresh_token }, mock), (error: Error) => {
		assert.match(error.message, /invalid.*response/i);
		assert.ok(!error.message.includes(token.access_token));
		return true;
	});
});

test("both credential endpoints refuse redirects and use a bounded request signal", async () => {
	const mock = mockResponse(200, JSON.stringify(token));
	await refreshCredentials({ refresh: token.refresh_token }, mock);
	await revokeCredentials(token.refresh_token, mock);
	assert.equal(mock.calls.length, 2);
	for (const call of mock.calls) {
		assert.equal(call.redirect, "error");
		assert.ok(call.signal instanceof AbortSignal);
	}
});

test("pre-cancelled requests never invoke fetch", async () => {
	const controller = new AbortController();
	controller.abort();
	const mock = mockResponse(200, JSON.stringify(token));
	await assert.rejects(refreshCredentials({ refresh: token.refresh_token }, { ...mock, signal: controller.signal }), { name: "AbortError" });
	assert.equal(mock.calls.length, 0);
});

test("in-flight cancellation reaches fetch without issuing retries", async () => {
	const controller = new AbortController();
	let calls = 0;
	const fetchImpl = (async (_url: unknown, init: RequestInit) => {
		calls++;
		const signal = init.signal!;
		return await new Promise<Response>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			controller.abort();
		});
	}) as FetchImplementation;
	await assert.rejects(refreshCredentials({ refresh: token.refresh_token }, { fetchImpl, signal: controller.signal }), { name: "AbortError" });
	assert.equal(calls, 1);
});

test("timeout aborts the credential request without retrying or exposing its body", async () => {
	const deadline = new AbortController();
	const timeoutMock = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds: number) => {
		assert.equal(milliseconds, 30000);
		return deadline.signal;
	});
	let calls = 0;
	const fetchImpl = (async (_url: unknown, init: RequestInit) => {
		calls++;
		return await new Promise<Response>((_resolve, reject) => {
			init.signal!.addEventListener("abort", () => reject(new Error(token.refresh_token)), { once: true });
			deadline.abort(new DOMException("Request timed out", "TimeoutError"));
		});
	}) as FetchImplementation;
	try {
		await assert.rejects(refreshCredentials({ refresh: token.refresh_token }, { fetchImpl }), (error: Error) => {
			assert.match(error.message, /timed out/);
			assert.ok(!error.message.includes(token.refresh_token));
			return true;
		});
		assert.equal(calls, 1);
	} finally {
		timeoutMock.mockRestore();
	}
});

test("malformed successful JSON is rejected at the network boundary", async () => {
	const mock = mockResponse(200, JSON.stringify({ ...token, expires_in: null }));
	await assert.rejects(refreshCredentials({ refresh: token.refresh_token }, mock), /invalid.*response/i);
	assert.equal(mock.calls.length, 1);
});

test("transport failures do not echo tokens and do not retry single-use grants", async () => {
	let calls = 0;
	const fetchImpl = (async () => {
		calls++;
		throw new Error(`transport debug: ${token.refresh_token}`);
	}) as FetchImplementation;
	await assert.rejects(refreshCredentials({ refresh: token.refresh_token }, { fetchImpl }), (error: Error) => {
		assert.ok(!error.message.includes(token.refresh_token));
		assert.match(error.message, /network|request|transport/i);
		return true;
	});
	assert.equal(calls, 1);
});
