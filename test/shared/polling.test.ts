import assert from "node:assert/strict";
import { test } from "bun:test";
import { pollUntil, waitFor } from "../../src/shared/polling.ts";

test("polling returns completion after pending using an injected clock", async () => {
	let time = 0, calls = 0;
	const result = await pollUntil({ deadline: 100, intervalMs: 10, now: () => time, sleep: async (ms) => { time += ms; }, poll: async () => ++calls === 3 ? { state: "complete", value: "done" } : { state: "pending" } });
	assert.equal(result, "done"); assert.equal(calls, 3); assert.equal(time, 20);
});

test("polling stops at deadline without one last outbound request", async () => {
	let time = 0, calls = 0;
	await assert.rejects(pollUntil({ deadline: 20, intervalMs: 10, now: () => time, sleep: async (ms) => { time += ms; }, poll: async () => { calls++; return { state: "pending" }; } }), /timed out/i);
	assert.equal(calls, 2);
});

test("delayed-first-poll policy is reusable without changing terminal semantics", async () => {
	let time = 0;
	await pollUntil({ deadline: 100, intervalMs: 10, delayFirst: true, now: () => time, sleep: async (ms) => { time += ms; }, poll: async () => { assert.equal(time, 10); return { state: "complete", value: true }; } });
});

test("a result arriving after deadline cannot complete authentication", async () => {
	let time = 0;
	await assert.rejects(pollUntil({ deadline: 10, intervalMs: 1, now: () => time, poll: async () => { time = 11; return { state: "complete", value: "late-secret" }; } }), /timed out/i);
});

test("cancellation during a poll prevents a completed result from being accepted", async () => {
	const controller = new AbortController();
	await assert.rejects(pollUntil({ deadline: 100, intervalMs: 1, now: () => 0, signal: controller.signal, poll: async () => { controller.abort(); return { state: "complete", value: true }; } }), { name: "AbortError" });
});

test("pre-aborted polling never calls the poll operation", async () => {
	const controller = new AbortController(); controller.abort();
	let calls = 0;
	await assert.rejects(pollUntil({ deadline: 100, intervalMs: 1, now: () => 0, signal: controller.signal, poll: async () => { calls++; return { state: "pending" }; } }), { name: "AbortError" });
	assert.equal(calls, 0);
});

test("terminal poll failures are not retried by the shared orchestrator", async () => {
	let calls = 0;
	await assert.rejects(pollUntil({ deadline: 100, intervalMs: 1, now: () => 0, poll: async () => { calls++; throw new Error("terminal-domain-error"); } }), /terminal-domain-error/);
	assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Timing edges
//
// The tests above all inject a clock and a sleep. These cover the paths that
// only a real timer reaches: waitFor's own timer, the deadline clamp on the
// sleep length, onPending, and invalid arguments. Each was probed directly
// before being written, so none is speculative dead code.
// ---------------------------------------------------------------------------

test("the sleep is clamped to the remaining time, never overshooting the deadline", async () => {
	// An interval longer than the whole window must not sleep past the deadline:
	// a login would otherwise sit idle for the full interval before reporting
	// a timeout it could have reported immediately.
	let time = 0;
	const sleeps: number[] = [];
	await assert.rejects(pollUntil({
		deadline: 500, intervalMs: 3000, delayFirst: true, now: () => time,
		sleep: async (ms) => { sleeps.push(ms); time += ms; },
		poll: async () => ({ state: "pending" }),
	}), /timed out/i);
	assert.deepEqual(sleeps, [500], "the first sleep is the remaining time, not the interval");
	assert.equal(time, 500, "the clock lands exactly on the deadline");
});

test("onPending fires once per non-terminal poll", async () => {
	let pending = 0;
	const seen: number[] = [];
	await pollUntil({
		deadline: 100, intervalMs: 1, now: () => 0, sleep: async () => {},
		onPending: () => { pending++; seen.push(pending); },
		poll: async () => (pending < 2 ? { state: "pending" } : { state: "complete", value: "ok" }),
	});
	assert.equal(pending, 2, "exactly the pending polls, not the completing one");
	assert.deepEqual(seen, [1, 2]);
});

test("onPending is optional", async () => {
	// Omitting the callback must not throw; the Codex and Mistral flows rely on it.
	assert.equal(await pollUntil({ deadline: 10, intervalMs: 1, now: () => 0, poll: async () => ({ state: "complete", value: "v" }) }), "v");
});

test("a non-finite or non-positive deadline or interval is refused before polling", async () => {
	for (const opts of [
		{ deadline: Infinity, intervalMs: 1 }, { deadline: NaN, intervalMs: 1 },
		{ deadline: 100, intervalMs: 0 }, { deadline: 100, intervalMs: -5 },
		{ deadline: 100, intervalMs: NaN },
	]) {
		let calls = 0;
		await assert.rejects(pollUntil({
			...opts, now: () => 0, sleep: async () => {}, poll: async () => { calls++; return { state: "pending" }; },
		}), /Invalid polling deadline or interval/);
		assert.equal(calls, 0, `${JSON.stringify(opts)} must be refused before any request`);
	}
});

test("waitFor resolves after the requested delay with a real timer", async () => {
	const started = Date.now();
	await waitFor(25);
	const elapsed = Date.now() - started;
	// Loose bounds: this proves the timer actually fires rather than resolving early.
	assert.ok(elapsed >= 20, `waitFor returned after ${elapsed}ms, too early`);
});

test("waitFor rejects when the signal aborts mid-wait", async () => {
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error("cancelled mid-wait")), 15);
	const started = Date.now();
	await assert.rejects(waitFor(5000, controller.signal), /cancelled mid-wait/);
	assert.ok(Date.now() - started < 1000, "an abort must not wait out the full delay");
});

test("waitFor rejects immediately on an already-aborted signal", async () => {
	await assert.rejects(waitFor(5000, AbortSignal.abort(new Error("pre-aborted"))), /pre-aborted/);
});

test("waitFor without a signal simply resolves", async () => {
	await waitFor(5);
});
