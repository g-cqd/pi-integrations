import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { test } from "bun:test";
import { awaitAuthorizationInput, expiryAfter, jwtPayload, pollUntil, startLoopback } from "../../src/shared/index.ts";

// Local-only: servers bind 127.0.0.1 on an ephemeral port; nothing leaves the machine.

const PATH = "/auth/callback";
const STATE = "synthetic-state-123";

async function start(extra: Partial<Parameters<typeof startLoopback>[0]> = {}) {
	return startLoopback({ port: 0, path: PATH, state: STATE, ...extra });
}
const get = (server: { port: number }, query: string, path = PATH) =>
	fetch(`http://127.0.0.1:${server.port}${path}${query}`);

/** Raw request so a hostile Host header can be sent (fetch forbids overriding it). */
function rawGet(port: number, hostHeader: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ port, host: "127.0.0.1" }, () => {
			socket.write(`GET ${PATH}?code=synthetic-code&state=${STATE} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
		});
		let data = "";
		socket.on("data", (chunk) => { data += chunk.toString(); });
		socket.on("close", () => resolve(data));
		socket.on("error", reject);
	});
}

// ---------------------------------------------------------------------------
// Loopback server
// ---------------------------------------------------------------------------

test("a valid callback resolves with the code and serves a static success page", async () => {
	const server = await start();
	const response = await get(server, `?code=synthetic-code&state=${STATE}`);
	assert.equal(response.status, 200);
	assert.match(await response.text(), /Sign-in complete/);
	assert.equal(await server.result, "synthetic-code");
});

test("a wrong or missing state is rejected and does NOT settle the flow", async () => {
	const server = await start();
	for (const query of ["?code=c&state=wrong", "?code=c", "?state=" + STATE]) {
		assert.equal((await get(server, query)).status, 400);
	}
	const real = await get(server, `?code=real-code&state=${STATE}`);
	assert.equal(real.status, 200);
	assert.equal(await server.result, "real-code", "stray requests did not consume the login");
});

test("a provider error rejects with an allowlisted code only, and ignores an unauthenticated error", async () => {
	const server = await start();
	assert.equal((await get(server, "?error=access_denied")).status, 400, "an error without our state is ignored");
	const raced = Promise.race([server.result.then(() => "settled", () => "settled"), new Promise((r) => setTimeout(() => r("still-waiting"), 30))]);
	assert.equal(await raced, "still-waiting");
	await get(server, `?error=access_denied&state=${STATE}`);
	await assert.rejects(server.result, /access_denied/);

	const hostile = await start();
	await get(hostile, `?error=${encodeURIComponent("<script>alert(1)</script>")}&state=${STATE}`);
	await assert.rejects(hostile.result, (error: Error) => {
		assert.ok(!error.message.includes("<script>"));
		assert.match(error.message, /\(error\)/);
		return true;
	});
});

test("served pages never reflect query content", async () => {
	const server = await start();
	const response = await get(server, `?code=x&state=<img-src-onerror>`);
	const body = await response.text();
	assert.equal(response.status, 400);
	assert.ok(!body.includes("img-src-onerror"));
	server.close();
});

test("only GET on the exact path is served", async () => {
	const server = await start();
	assert.equal((await get(server, `?code=c&state=${STATE}`, "/other")).status, 404);
	assert.equal((await fetch(`http://127.0.0.1:${server.port}${PATH}?code=c&state=${STATE}`, { method: "POST" })).status, 404);
	server.close();
});

test("a foreign Host header is refused, which blocks DNS-rebinding callbacks", async () => {
	const server = await start();
	assert.match(await rawGet(server.port, "evil.example"), /^HTTP\/1\.1 404/);
	assert.match(await rawGet(server.port, `localhost:${server.port + 1}`), /^HTTP\/1\.1 404/, "right name, wrong port");
	assert.match(await rawGet(server.port, `localhost:${server.port}`), /^HTTP\/1\.1 200/);
	assert.equal(await server.result, "synthetic-code");
});

test("the first valid callback wins and a replay is refused", async () => {
	const server = await start();
	assert.equal((await get(server, `?code=first&state=${STATE}`)).status, 200);
	assert.equal(await server.result, "first");
	await assert.rejects(get(server, `?code=second&state=${STATE}`), "the server stopped accepting connections");
});

test("cancellation rejects the result and frees the port", async () => {
	const controller = new AbortController();
	const server = await start({ signal: controller.signal });
	const port = server.port;
	controller.abort();
	await assert.rejects(server.result, { name: "AbortError" });
	const again = await startLoopback({ port, path: PATH, state: STATE });
	assert.equal(again.port, port, "the port was released");
	again.close();
});

test("a pre-aborted signal never leaves a listening server behind", async () => {
	const controller = new AbortController();
	controller.abort();
	const server = await start({ signal: controller.signal });
	await assert.rejects(server.result, { name: "AbortError" });
});

test("binding a taken port rejects so the caller can fall back to pasting", async () => {
	const first = await start();
	await assert.rejects(startLoopback({ port: first.port, path: PATH, state: STATE }), (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE");
	first.close();
});

test("a custom code parameter is honored", async () => {
	const server = await start({ codeParam: "authorization_code" });
	await get(server, `?authorization_code=alt&state=${STATE}`);
	assert.equal(await server.result, "alt");
});

// ---------------------------------------------------------------------------
// awaitAuthorizationInput
// ---------------------------------------------------------------------------

test("the callback wins the race against a manual source that never answers", async () => {
	const server = await start();
	const pending = awaitAuthorizationInput({ loopback: server, manual: () => new Promise(() => {}) });
	await get(server, `?code=via-callback&state=${STATE}`);
	assert.deepEqual(await pending, { type: "callback", code: "via-callback" });
});

test("a manual paste wins when the callback never comes, and the caller closes the server", async () => {
	const server = await start();
	const input = await awaitAuthorizationInput({ loopback: server, manual: async () => "pasted-value" });
	assert.deepEqual(input, { type: "manual", input: "pasted-value" });
	server.close();
});

test("without a loopback only the manual source is used; with neither it fails clearly", async () => {
	assert.deepEqual(await awaitAuthorizationInput({ manual: async () => "only-manual" }), { type: "manual", input: "only-manual" });
	await assert.rejects(awaitAuthorizationInput({}), /No way to receive/);
});

// ---------------------------------------------------------------------------
// slow_down polling (RFC 8628 section 3.5)
// ---------------------------------------------------------------------------

test("slow_down lengthens the polling interval by five seconds each time", async () => {
	let time = 0, calls = 0;
	const sleeps: number[] = [];
	await pollUntil({
		deadline: 1e9, intervalMs: 1000, delayFirst: true, now: () => time,
		sleep: async (ms) => { sleeps.push(ms); time += ms; },
		poll: async () => {
			calls++;
			if (calls === 1) return { state: "pending", slowDown: true };
			if (calls === 2) return { state: "pending", slowDown: true };
			if (calls === 3) return { state: "pending" };
			return { state: "complete", value: true };
		},
	});
	assert.deepEqual(sleeps, [1000, 6000, 11000, 11000]);
});

// ---------------------------------------------------------------------------
// jwtPayload and expiryAfter
// ---------------------------------------------------------------------------

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "none" })}.${b64url(payload)}.signature`;

test("jwtPayload reads base64url claims, including characters that need url-safe decoding", () => {
	const claims = { "https://api.example.test/auth": { account: "acct_synthetic" }, note: "\u00e9\u00e8>>??" };
	assert.deepEqual(jwtPayload(jwt(claims)), claims);
});

for (const bad of ["", "not-a-jwt", "a.b", "a..c", `a.${Buffer.from("[1]").toString("base64url")}.c`, `a.${Buffer.from("not json").toString("base64url")}.c`, "a.%%%.c"]) {
	test(`jwtPayload returns null for malformed input: ${JSON.stringify(bad).slice(0, 30)}`, () => assert.equal(jwtPayload(bad), null));
}

test("expiryAfter reserves the smaller of five minutes or ten percent", () => {
	assert.equal(expiryAfter(1000, 28800), 1000 + 28_800_000 - 300_000);
	assert.equal(expiryAfter(0, 60), 60_000 - 6_000);
});

for (const bad of [0, -1, NaN, Infinity, "3600", undefined, Number.MAX_VALUE]) {
	test(`expiryAfter rejects an invalid lifetime: ${String(bad)}`, () => assert.throws(() => expiryAfter(0, bad), /Invalid token lifetime/));
}
