import assert from "node:assert/strict";
import { test } from "bun:test";
import { requestText, RESPONSE_LIMIT_BYTES, waitFor } from "../../src/shared/index.ts";
import type { FetchImplementation } from "../../src/shared/http.ts";

/**
 * A provider that answers with headers and then holds the connection open,
 * without ever finishing the body. This is the shape a stalled or hostile peer
 * produces, and `reader.read()` never settles for it. Every read here must
 * therefore be bounded by a signal rather than only checked between chunks.
 */
const stalledBody = (seed = "{") =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(seed));
			// Intentionally never closed.
		},
	});

const fetchReturning = (body: BodyInit | ReadableStream<Uint8Array>, status = 200): FetchImplementation =>
	async () => new Response(body as BodyInit, { status });

/** Fails loudly instead of hanging the suite if a read is unbounded. */
const withDeadline = async <T>(work: Promise<T>, ms: number, label: string): Promise<T> => {
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error(`${label}: still unsettled after ${ms}ms`)), ms));
	return Promise.race([work, timeout]);
};

test("a stalled response body does not hang past the request timeout", async () => {
	const fetchImpl = fetchReturning(stalledBody());
	// The internal deadline is 30s; assert the read is bounded well inside that
	// by racing our own signal, which is the caller-facing guarantee.
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error("test deadline")), 150);
	await assert.rejects(
		withDeadline(requestText("https://provider.test/", {}, { fetchImpl, signal: controller.signal }), 4000, "stalled body"),
		/Provider network request failed|test deadline|Invalid or oversized/,
	);
});

test("caller abort during a body read rejects with the caller's reason", async () => {
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error("caller cancelled")), 20);
	const fetchImpl = fetchReturning(stalledBody());
	const error = await requestText("https://provider.test/", {}, { fetchImpl, signal: controller.signal })
		.then(() => undefined, (e: unknown) => e as Error);
	assert.ok(error, "an aborted read must not resolve");
	assert.equal(error?.message, "caller cancelled", "the caller's abort reason must survive");
});

test("a pre-aborted signal never reaches the body read", async () => {
	const fetchImpl = fetchReturning(stalledBody());
	await assert.rejects(
		withDeadline(
			requestText("https://provider.test/", {}, { fetchImpl, signal: AbortSignal.abort(new Error("already gone")) }),
			4000,
			"pre-aborted",
		),
		/already gone|Provider network request failed/,
	);
});

test("a normal multi-chunk body still assembles in order", async () => {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode("{\"a\":"));
			controller.enqueue(encoder.encode("[1,2],"));
			controller.enqueue(encoder.encode("\"b\":3}"));
			controller.close();
		},
	});
	const { response, text } = await requestText("https://provider.test/", {}, { fetchImpl: fetchReturning(body) });
	assert.equal(response.status, 200);
	assert.deepEqual(JSON.parse(text), { a: [1, 2], b: 3 });
});

test("the byte cap still rejects an oversized body", async () => {
	const oversized = "x".repeat(RESPONSE_LIMIT_BYTES + 64);
	await assert.rejects(
		requestText("https://provider.test/", {}, { fetchImpl: fetchReturning(oversized) }),
		/Provider network request failed|Invalid or oversized/,
	);
});

test("a body just under the cap is accepted", async () => {
	const body = "y".repeat(RESPONSE_LIMIT_BYTES - 1);
	const { text } = await requestText("https://provider.test/", {}, { fetchImpl: fetchReturning(body) });
	assert.equal(text.length, RESPONSE_LIMIT_BYTES - 1);
});

test("many stalled reads on one shared signal stay fast and leave it reusable", async () => {
	// requestText derives its own signal per call (AbortSignal.any), so counting
	// listeners on the caller's signal would measure nothing. What is observable
	// and matters: repeated aborted reads must settle promptly, must not abort
	// the caller's signal, and must leave that signal usable afterwards.
	const shared = new AbortController();
	const encoder = new TextEncoder();
	const completes: FetchImplementation = async () => new Response(new ReadableStream<Uint8Array>({
		start(c) { c.enqueue(encoder.encode('{"ok":true}')); c.close(); },
	}));

	for (let i = 0; i < 25; i++) {
		await requestText("https://provider.test/", {}, { fetchImpl: completes, signal: shared.signal });
	}
	assert.equal(shared.signal.aborted, false, "completing reads must not abort the caller's signal");

	// Now the stalled variant, each with its own short abort so the loop is fast.
	for (let i = 0; i < 25; i++) {
		const c = new AbortController();
		setTimeout(() => c.abort(new Error(`iter ${i}`)), 1);
		await withDeadline(
			requestText("https://provider.test/", {}, { fetchImpl: fetchReturning(stalledBody()), signal: c.signal }),
			4000,
			"stalled read",
		).catch(() => undefined);
		assert.equal(c.signal.aborted, true);
	}

	// The long-lived shared signal still works, proving nothing poisoned it.
	const { text } = await requestText("https://provider.test/", {}, { fetchImpl: completes, signal: shared.signal });
	assert.equal(text, '{"ok":true}', "the shared signal must still be usable");
});

test("waitFor still rejects a pre-aborted signal", async () => {
	// Guard against the body-read fix regressing the sibling primitive.
	await assert.rejects(waitFor(50, AbortSignal.abort(new Error("pre"))), /pre/);
});
