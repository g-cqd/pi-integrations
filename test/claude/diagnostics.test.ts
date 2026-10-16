import assert from "node:assert/strict";
import { test } from "bun:test";
import {
	anthropicMessagesApi, createAssistantMessageEventStream, getModels, normalizeContext,
} from "@earendil-works/pi-ai/compat";
import { CANONICAL_SYSTEM_LINE, applyClaudeCodeSystemGate, subscriptionGateStreamSimple } from "../../src/domains/claude/gate.ts";
import {
	DRIFT_DIAGNOSTIC_TYPE, ProtocolDriftError, diagnosticFetch, driftDetailsFromCapture,
	gateFingerprint, summarizeErrorBody, withDriftDiagnostics, type DriftCapture,
} from "../../src/domains/claude/diagnostics.ts";

// Synthetic values only. Error bodies mirror Anthropic's documented envelope.

const GATED = applyClaudeCodeSystemGate({
	model: "claude-opus-5-5",
	system: [{ type: "text", text: "You are pi, a coding agent." }],
	messages: [{ role: "user", content: "hi" }],
	max_tokens: 1024,
	tools: [{ name: "synthetic_tool" }],
});

const rejection = (type: string, message: string) =>
	JSON.stringify({ type: "error", error: { type, message } });

// ---------------------------------------------------------------------------
// summarizeErrorBody
// ---------------------------------------------------------------------------

test("summarizes the standard Anthropic error envelope", () => {
	assert.deepEqual(
		summarizeErrorBody(rejection("invalid_request_error", "synthetic short message")),
		{ type: "invalid_request_error", message: "synthetic short message" },
	);
});

test("redacts token-shaped substrings and never emits an sk-ant prefix", () => {
	const summary = summarizeErrorBody(rejection("invalid_grant", "token sk-ant-oat01-synthetic-token-value is invalid"));
	const text = JSON.stringify(summary);
	assert.ok(!text.includes("synthetic-token-value"));
	assert.ok(!text.includes("sk-ant"));
	assert.ok(text.includes("[redacted-token]"));
	assert.ok(!JSON.stringify(summarizeErrorBody("Bearer sk-ant-oat01-abc123def456 rejected")).includes("abc123def456"));
});

test("truncates long provider messages", () => {
	const message = summarizeErrorBody(rejection("invalid_request_error", "x".repeat(500)))?.message ?? "";
	assert.ok(message.length <= 161);
	assert.ok(message.endsWith("…"));
});

test("degrades gracefully for non-JSON bodies, odd shapes, and non-allowlisted types", () => {
	assert.equal(summarizeErrorBody("plain text failure")?.message, "plain text failure");
	assert.equal(summarizeErrorBody(JSON.stringify(42)), undefined);
	assert.equal(summarizeErrorBody(rejection("Not A Real Type!!", "m"))?.type, undefined);
});

// ---------------------------------------------------------------------------
// gateFingerprint: structure only
// ---------------------------------------------------------------------------

test("fingerprint records structure without content", () => {
	const fp = gateFingerprint(GATED);
	assert.deepEqual(fp, {
		model: "claude-opus-5-5", messageCount: 1, toolCount: 1, maxTokens: 1024,
		systemBlockCount: 1, systemIsString: false, systemCanonicalMatch: true, systemRoleMessages: 0,
	});
	assert.ok(!JSON.stringify(fp).includes("coding agent"));
	assert.ok(!JSON.stringify(fp).includes("synthetic_tool"));
});

test("fingerprint flags un-gated and degenerate payloads", () => {
	const unGated = gateFingerprint({ model: "m", system: "You are pi.", messages: [{ role: "system", content: "note" }] });
	assert.equal(unGated.systemCanonicalMatch, false);
	assert.equal(unGated.systemIsString, true);
	assert.equal(unGated.systemRoleMessages, 1);
	assert.deepEqual(gateFingerprint(undefined), {
		messageCount: 0, toolCount: 0, systemBlockCount: 0,
		systemIsString: false, systemCanonicalMatch: false, systemRoleMessages: 0,
	});
});

// ---------------------------------------------------------------------------
// diagnosticFetch: capture at the layer that actually sees rejections
// ---------------------------------------------------------------------------

test("fetch wrapper records status, diagnostic headers only, and a body summary; response stays readable", async () => {
	const capture: DriftCapture = {};
	const body = rejection("invalid_request_error", "synthetic body detail");
	const wrapped = diagnosticFetch(capture, async () => new Response(body, {
		status: 400,
		headers: {
			"request-id": "req_synthetic_1",
			"anthropic-ratelimit-unified-5h-utilization": "0.09",
			"set-cookie": "synthetic-session=secret",
			"content-type": "application/json",
		},
	}));
	const response = await wrapped("https://api.anthropic.test/v1/messages", { method: "POST" });
	assert.equal(response.status, 400);
	assert.equal(capture.status, 400);
	assert.deepEqual(capture.headers, {
		"request-id": "req_synthetic_1",
		"anthropic-ratelimit-unified-5h-utilization": "0.09",
	});
	assert.equal(capture.errorBody?.message, "synthetic body detail");
	assert.equal(await response.text(), body, "the SDK can still read the original body");
});

test("fetch wrapper resets the capture on every call so a stale rejection is never reused", async () => {
	const capture: DriftCapture = {};
	let status = 400;
	const wrapped = diagnosticFetch(capture, async () => new Response(rejection("invalid_request_error", "m"), { status }));
	await wrapped("https://api.anthropic.test/v1/messages");
	assert.equal(capture.status, 400);
	status = 200;
	await wrapped("https://api.anthropic.test/v1/messages");
	assert.equal(capture.status, undefined);
	assert.equal(capture.errorBody, undefined);
	status = 500;
	await wrapped("https://api.anthropic.test/v1/messages");
	assert.equal(capture.status, undefined, "5xx is not a drift signature");
});

test("fetch wrapper propagates transport failures and preserves preconnect", async () => {
	const base = Object.assign(async () => { throw new Error("synthetic-transport"); }, { preconnect: () => {} }) as never;
	const wrapped = diagnosticFetch({}, base);
	await assert.rejects(wrapped("https://api.anthropic.test/v1/messages"), /synthetic-transport/);
	assert.equal(typeof (wrapped as { preconnect?: unknown }).preconnect, "function");
});

// ---------------------------------------------------------------------------
// ProtocolDriftError: the report itself
// ---------------------------------------------------------------------------

test("report carries everything needed to debug a 400 and nothing sensitive", () => {
	const details = driftDetailsFromCapture({
		status: 400,
		headers: {
			"request-id": "req_synthetic_123",
			"anthropic-ratelimit-unified-5h-utilization": "0.09",
			"anthropic-ratelimit-unified-7d-reset": "1790000000",
		},
		errorBody: { type: "invalid_request_error", message: "You're out of extra usage." },
	}, gateFingerprint(GATED))!;
	const error = new ProtocolDriftError(details);
	assert.equal(error.name, "ProtocolDriftError");
	for (const expected of [
		/HTTP 400/, /req_synthetic_123/, /anthropic-ratelimit-unified-5h-utilization: 0\.09/,
		/anthropic-ratelimit-unified-7d-reset: 1790000000/, /invalid_request_error/, /out of extra usage/,
		/model: claude-opus-5-5/, /messages: 1, tools: 1, max_tokens: 1024/, /canonical match: yes/, /drift checklist/,
	]) assert.match(error.message, expected);
	assert.ok(error.message.includes(CANONICAL_SYSTEM_LINE), "the canonical line to compare against is printed");
	for (const forbidden of ["sk-ant", "coding agent", "synthetic_tool"]) {
		assert.ok(!error.message.includes(forbidden), `must not contain ${forbidden}`);
	}
});

test("each status carries its own interpretation, and absent signals are reported", () => {
	const text = (status: number) => new ProtocolDriftError(driftDetailsFromCapture({ status })!).message;
	assert.match(text(401), /invalid, expired, or revoked/);
	assert.match(text(403), /scope\/permission|org-level/);
	assert.match(text(429), /rate limiting/);
	assert.match(text(400), /quota headers: none present/);
	assert.match(text(400), /provider error body: not captured/);
	assert.equal(driftDetailsFromCapture({}), undefined);
});

test("the fingerprint section flags a gate that failed to canonicalize", () => {
	const fp = gateFingerprint({ model: "m", system: "raw harness prompt", messages: [{ role: "system", content: "x" }] });
	const message = new ProtocolDriftError(driftDetailsFromCapture({ status: 400 }, fp)!).message;
	assert.match(message, /canonical match: NO/);
	assert.match(message, /system-role messages remaining: 1/);
	assert.ok(!message.includes("raw harness prompt"));
});

// ---------------------------------------------------------------------------
// withDriftDiagnostics: pump semantics on a synthetic stream
// ---------------------------------------------------------------------------

function failedMessage(stopReason: "error" | "aborted", errorMessage: string) {
	return { role: "assistant", content: [], stopReason, errorMessage, timestamp: 0 };
}

test("only a failed (not aborted) terminal error event is enriched; result() agrees", async () => {
	for (const [stopReason, enriched] of [["error", true], ["aborted", false]] as const) {
		const inner = createAssistantMessageEventStream();
		const message = failedMessage(stopReason, "400 original sdk text");
		inner.push({ type: "error", reason: stopReason, error: message } as never);
		inner.end();
		const out = withDriftDiagnostics(inner, { status: 400, headers: { "request-id": "req_x" } }, () => undefined);
		const events: Array<{ type: string; error?: { errorMessage?: string; diagnostics?: Array<{ type: string }> } }> = [];
		for await (const event of out) events.push(event as never);
		const result = (await out.result()) as { errorMessage?: string; diagnostics?: Array<{ type: string }> };
		assert.equal(events.length, 1);
		assert.equal(events[0].error, result, "stream and result() share one message");
		assert.equal(result.errorMessage?.includes("possible protocol drift"), enriched);
		assert.equal(result.diagnostics?.some((d) => d.type === DRIFT_DIAGNOSTIC_TYPE) ?? false, enriched);
		if (enriched) assert.match(result.errorMessage!, /original error \(redacted, truncated\): 400 original sdk text/);
	}
});

test("no capture means no enrichment, and non-error events pass through untouched", async () => {
	const inner = createAssistantMessageEventStream();
	const start = { type: "start", partial: { role: "assistant", content: [] } };
	inner.push(start as never);
	inner.push({ type: "error", reason: "error", error: failedMessage("error", "network down") } as never);
	inner.end();
	const out = withDriftDiagnostics(inner, {}, () => undefined);
	const types: string[] = [];
	for await (const event of out) types.push(event.type);
	assert.deepEqual(types, ["start", "error"]);
	assert.equal(((await out.result()) as { errorMessage?: string }).errorMessage, "network down");
});

// ---------------------------------------------------------------------------
// End to end through the REAL pi-ai Anthropic implementation. These are the
// tests that prove the seams: the SDK throws on 4xx before onResponse runs.
// ---------------------------------------------------------------------------

const model = getModels("anthropic")[0];
const context = () => normalizeContext({
	systemPrompt: "Synthetic harness system prompt",
	messages: [{ role: "user", content: "synthetic user prompt", timestamp: 0 }],
});

function runThroughGate(respond: (init: RequestInit | undefined) => Response, extra: Record<string, unknown> = {}) {
	const requests: RequestInit[] = [];
	const fetchStub = (async (_url: unknown, init?: RequestInit) => {
		requests.push(init ?? {});
		return respond(init);
	}) as never;
	const wrapped = subscriptionGateStreamSimple((m, c, o) =>
		anthropicMessagesApi().streamSimple(m as never, c, o));
	const stream = wrapped(model, context(), {
		apiKey: "sk-ant-oat01-synthetic-key", fetch: fetchStub, maxRetries: 0, ...extra,
	} as never);
	return { stream, requests };
}

test("e2e: a real 400 classifier rejection becomes the rich report, with the gated request on the wire", async () => {
	const { stream, requests } = runThroughGate(() => new Response(
		rejection("invalid_request_error", "You're out of extra usage."),
		{ status: 400, headers: { "request-id": "req_e2e_400", "anthropic-ratelimit-unified-5h-utilization": "0.13", "content-type": "application/json" } },
	));
	const terminal: { type: string; error?: never }[] = [];
	for await (const event of stream) terminal.push(event as never);
	const last = terminal[terminal.length - 1];
	assert.equal(last.type, "error");
	const result = (await stream.result()) as { stopReason: string; errorMessage: string; diagnostics?: Array<{ type: string; details?: { status?: number; requestId?: string } }> };
	assert.equal(result.stopReason, "error");
	for (const expected of [
		/possible protocol drift/, /HTTP 400/, /req_e2e_400/, /anthropic-ratelimit-unified-5h-utilization: 0\.13/,
		/invalid_request_error/, /out of extra usage/, /canonical match: yes/, /original error \(redacted, truncated\)/,
	]) assert.match(result.errorMessage, expected);
	for (const forbidden of ["sk-ant", "synthetic harness system prompt", "synthetic user prompt"]) {
		assert.ok(!result.errorMessage.toLowerCase().includes(forbidden), `must not contain ${forbidden}`);
	}
	const diagnostic = result.diagnostics?.find((d) => d.type === DRIFT_DIAGNOSTIC_TYPE);
	assert.equal(diagnostic?.details?.status, 400);
	assert.equal(diagnostic?.details?.requestId, "req_e2e_400");

	// The same request proves the gate itself ran on the wire:
	assert.equal(requests.length, 1);
	const sent = JSON.parse(String(requests[0].body)) as { system: Array<{ text: string }>; messages: Array<{ content: unknown }> };
	assert.deepEqual(sent.system.map((b) => b.text), [CANONICAL_SYSTEM_LINE]);
	assert.ok(JSON.stringify(sent.messages).includes("Synthetic harness system prompt"), "harness prompt relocated into user content");
});

test("e2e: a 429 with no quota headers is reported as such", async () => {
	const { stream } = runThroughGate(() => new Response(rejection("rate_limit_error", "Rate limited."), { status: 429 }));
	for await (const _event of stream) { /* drain */ }
	const result = (await stream.result()) as { errorMessage: string };
	assert.match(result.errorMessage, /HTTP 429/);
	assert.match(result.errorMessage, /quota headers: none present/);
	assert.match(result.errorMessage, /rate_limit_error/);
});

test("e2e: a non-drift failure (HTTP 500) keeps the SDK's own error untouched", async () => {
	const { stream } = runThroughGate(() => new Response(rejection("api_error", "Internal server error"), { status: 500 }));
	for await (const _event of stream) { /* drain */ }
	const result = (await stream.result()) as { stopReason: string; errorMessage: string; diagnostics?: unknown[] };
	assert.equal(result.stopReason, "error");
	assert.ok(!result.errorMessage.includes("possible protocol drift"));
	assert.equal(result.diagnostics, undefined);
});

test("e2e: the happy path streams through the wrapper unchanged", async () => {
	const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	const body = [
		sse("message_start", { type: "message_start", message: { id: "msg_synthetic", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 3, output_tokens: 0 } } }),
		sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic reply" } }),
		sse("content_block_stop", { type: "content_block_stop", index: 0 }),
		sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
		sse("message_stop", { type: "message_stop" }),
	].join("");
	const { stream } = runThroughGate(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
	const types: string[] = [];
	for await (const event of stream) types.push(event.type);
	assert.equal(types[0], "start");
	assert.equal(types[types.length - 1], "done");
	const result = (await stream.result()) as { stopReason: string; content: Array<{ type: string; text?: string }>; diagnostics?: unknown[] };
	assert.equal(result.stopReason, "stop");
	assert.equal(result.content.find((b) => b.type === "text")?.text, "synthetic reply");
	assert.equal(result.diagnostics, undefined);
});

test("e2e: the caller's own fetch and onResponse are preserved underneath the diagnostics", async () => {
	let callerOnResponse = 0;
	const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	const body = [
		sse("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }),
		sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
		sse("message_stop", { type: "message_stop" }),
	].join("");
	const { stream, requests } = runThroughGate(
		() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
		{ onResponse: () => { callerOnResponse++; } },
	);
	for await (const _event of stream) { /* drain */ }
	assert.equal(requests.length, 1, "the caller's fetch served the request");
	assert.equal(callerOnResponse, 1, "the caller's onResponse still runs on success");
});

test("only 400 and 429 are framed as possible drift; auth failures get a plain report without the checklist", () => {
	const text = (status: number) => new ProtocolDriftError(driftDetailsFromCapture({ status })!).message;
	for (const status of [400, 429]) {
		assert.match(text(status), /possible protocol drift/);
		assert.match(text(status), /drift checklist/);
	}
	for (const status of [401, 403]) {
		assert.ok(!/possible protocol drift/.test(text(status)), `HTTP ${status} must not be framed as drift`);
		assert.ok(!/drift checklist/.test(text(status)), `HTTP ${status} must not print the drift checklist`);
		assert.match(text(status), new RegExp(`rejected: HTTP ${status}`));
		assert.match(text(status), /not (necessarily )?gate drift/);
	}
});

test("the missing-quota-headers hint appears for drift-like statuses only", () => {
	const text = (status: number) => new ProtocolDriftError(driftDetailsFromCapture({ status })!).message;
	assert.match(text(429), /quota headers: none present/);
	assert.ok(!/quota headers/.test(text(401)), "a 401 has no quota semantics, so say nothing");
});
