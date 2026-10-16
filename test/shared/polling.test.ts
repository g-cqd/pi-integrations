import assert from "node:assert/strict";
import { test } from "bun:test";
import { pollUntil } from "../../src/shared/polling.ts";

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
