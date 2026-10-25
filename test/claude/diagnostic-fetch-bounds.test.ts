import assert from "node:assert/strict";
import { test } from "bun:test";
import { diagnosticFetch, type DriftCapture } from "../../src/domains/claude/diagnostics.ts";

const head = `{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}`;

/** Sends `seed`, then (optionally) endless filler; counts the bytes a reader pulled. */
function openBody(seed: string, endless: boolean) {
	const state = { pulled: 0, cancelled: false };
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) { controller.enqueue(encoder.encode(seed)); state.pulled += seed.length; },
		pull(controller) {
			if (!endless) return new Promise(() => {}); // stalls: never settles
			const chunk = encoder.encode(" ".repeat(65536));
			state.pulled += chunk.length;
			controller.enqueue(chunk);
		},
		cancel() { state.cancelled = true; },
	});
	return { body, state };
}

const within = <T>(work: Promise<T>, ms: number) =>
	Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`unsettled after ${ms}ms`)), ms))]);

test("a rejected response whose body stalls is still returned, with what arrived summarized", async () => {
	const { body, state } = openBody(head, false);
	const capture: DriftCapture = {};
	const wrapped = diagnosticFetch(capture, async () => new Response(body, { status: 429 }));
	const response = await within(wrapped("https://api.test/v1/messages"), 5000);
	assert.equal(response.status, 429);
	assert.equal(capture.status, 429);
	assert.equal(capture.errorBody?.type, "rate_limit_error");
	assert.equal(state.cancelled, false, "the caller's own branch of the body is not ours to cancel");
});

test("a rejected response with an endless body is read only up to a fixed limit", async () => {
	const { body, state } = openBody(head, true);
	const capture: DriftCapture = {};
	const wrapped = diagnosticFetch(capture, async () => new Response(body, { status: 400 }));
	await within(wrapped("https://api.test/v1/messages"), 5000);
	assert.equal(capture.errorBody?.type, "rate_limit_error");
	assert.ok(state.pulled < 1 << 20, `read ${state.pulled} bytes of an endless body`);
});
