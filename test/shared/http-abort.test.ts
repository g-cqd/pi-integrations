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

// ---------------------------------------------------------------------------
// Concurrency
//
// Every other test here is single-request. These run overlapping reads to catch
// two failure modes that only appear under concurrency: a shared reader/buffer
// leaking between calls, and one call's abort tearing down another's.
// ---------------------------------------------------------------------------

test("concurrent reads do not interleave their bodies", async () => {
	const encoder = new TextEncoder();
	const makeStream = (id: string, chunks: number) => new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < chunks; i++) controller.enqueue(encoder.encode(`${id}:${i} `));
			controller.close();
		},
	});
	const requests = Array.from({ length: 25 }, (_, n) =>
		requestText(`https://provider.test/${n}`, {}, { fetchImpl: (async () => new Response(makeStream(`id${n}`, 4))) as FetchImplementation })
			.then(({ text }) => text));

	const results = await withDeadline(Promise.all(requests), 5000, "concurrent reads");
	for (let n = 0; n < 25; n++) {
		const expected = Array.from({ length: 4 }, (_, i) => `id${n}:${i} `).join("");
		assert.equal(results[n], expected, `request ${n} received another request's body`);
	}
});

test("aborting one concurrent read does not disturb the others", async () => {
	const encoder = new TextEncoder();
	// The healthy body closes, so it settles on its own. A stream left open is
	// not a healthy neighbour: it correctly waits for the 30s cap.
	const open = (tag: string) => new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(tag));
			// Intentionally not closed: the abort is what ends this read.
		},
	});
	const closes = (tag: string) => new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(tag));
			controller.close();
		},
	});

	// Three requests share one signal and all complete normally.
	const shared = new AbortController();
	const completes = [1, 2, 3].map((n) => requestText("https://provider.test/", {},
		{ fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(`ok${n}`)); c.close(); } }))) as FetchImplementation, signal: shared.signal })
		.then(({ text }) => text));
	assert.deepEqual(await withDeadline(Promise.all(completes), 5000, "shared-signal completes"), ["ok1", "ok2", "ok3"]);
	assert.equal(shared.signal.aborted, false, "completing reads must not abort the shared signal");

	// Now abort a stalled read while a healthy one runs beside it.
	const controller = new AbortController();
	const healthy = requestText("https://provider.test/", {},
		{ fetchImpl: (async () => new Response(closes("healthy"))) as FetchImplementation });
	setTimeout(() => controller.abort(new Error("only this one")), 10);
	const aborted = requestText("https://provider.test/", {},
		{ fetchImpl: (async () => new Response(open("stalled"))) as FetchImplementation, signal: controller.signal });

	const settled = await withDeadline(Promise.allSettled([healthy, aborted]), 5000, "mixed concurrency");
	assert.equal(settled[0].status, "fulfilled", "the healthy read must still succeed");
	assert.equal((settled[0] as PromiseFulfilledResult<{ text: string }>).value.text, "healthy");
	assert.equal(settled[1].status, "rejected", "the aborted read must reject");
	assert.match(String((settled[1] as PromiseRejectedResult).reason), /only this one/);
});

test("many concurrent stalled reads all settle rather than accumulating", async () => {
	const settledCount = await withDeadline(Promise.allSettled(
		Array.from({ length: 20 }, (_, n) => {
			const c = new AbortController();
			setTimeout(() => c.abort(new Error(`abort ${n}`)), 5);
			return requestText("https://provider.test/", {}, { fetchImpl: fetchReturning(stalledBody()), signal: c.signal });
		}),
	), 8000, "20 concurrent stalled reads");
	assert.equal(settledCount.length, 20);
	assert.ok(settledCount.every((s) => s.status === "rejected"), "every aborted read must reject, none may hang or resolve");
});
