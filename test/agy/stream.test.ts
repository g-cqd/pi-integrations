import assert from "node:assert/strict";
import { test } from "bun:test";
import { normalizeContext, Type } from "@earendil-works/pi-ai/compat";
import {
	API_ID, buildEnvelope, buildGeminiRequest, createAgyStreamSimple, decodeApiKey, encodeApiKey,
} from "../../src/domains/agy/stream.ts";
import { USER_AGENT } from "../../src/domains/agy/cloudcode.ts";

// Synthetic only: tokens, project ids, prompts and tool names are invented. No network.
// The conversion goes through Pi's REAL exported helpers; only fetch is stubbed.

const BASE = "https://cloudcode.example.test";
const TOKEN = "synthetic-access-token-ABC";
const PROJECT = "synthetic-project-123";
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const model = (over: Record<string, unknown> = {}) => ({
	id: "gemini-3.8-flash-low", name: "Synthetic", api: API_ID, provider: "agy-subscription", baseUrl: BASE,
	reasoning: true, input: ["text", "image"], cost: ZERO, contextWindow: 1_048_576, maxTokens: 65_536, ...over,
}) as never;
const context = (over: Record<string, unknown> = {}) => normalizeContext({
	systemPrompt: "Synthetic system prompt",
	messages: [{ role: "user", content: "synthetic question", timestamp: 0 }],
	...over,
} as never);
const apiKey = () => encodeApiKey(TOKEN, PROJECT);

const chunk = (parts: unknown[], extra: Record<string, unknown> = {}, wrap = true) => {
	const response = { candidates: [{ content: { role: "model", parts }, ...extra }], ...(wrap ? {} : {}) };
	return wrap ? { response, traceId: "trace-1" } : response;
};
const sse = (...chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
const okStream = (body: string) => () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

async function run(respond: (url: string, init: RequestInit) => Response | Promise<Response>, options: Record<string, unknown> = {}, ctx = context(), m = model()) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl = (async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return respond(String(url), init ?? {}); }) as never;
	let n = 0;
	const stream = createAgyStreamSimple({ baseUrl: BASE, fetchImpl, now: () => 1_800_000_000_000, newId: () => `id-${++n}` })(m, ctx, { apiKey: apiKey(), ...options } as never);
	const events: Array<Record<string, any>> = [];
	for await (const event of stream) events.push(event as never);
	const message = (await stream.result()) as Record<string, any>;
	return { calls, events, message, types: events.map((e) => e.type) };
}

// ---------------------------------------------------------------------------
// Credential packing
// ---------------------------------------------------------------------------

test("the project rides with the token through getApiKey's single string, and bad packing is refused", () => {
	assert.deepEqual(decodeApiKey(encodeApiKey(TOKEN, PROJECT)), { token: TOKEN, projectId: PROJECT });
	assert.throws(() => decodeApiKey(undefined), /No Antigravity access token/);
	assert.throws(() => decodeApiKey("not json"), /No Antigravity access token/);
	assert.throws(() => decodeApiKey(JSON.stringify({ token: "has space", projectId: PROJECT })), /No Antigravity access token/);
	assert.throws(() => decodeApiKey(JSON.stringify({ token: TOKEN })), /no Cloud Code project/);
	assert.throws(() => decodeApiKey(JSON.stringify({ token: TOKEN, projectId: "../x" })), /no Cloud Code project/);
});

// ---------------------------------------------------------------------------
// Request building (Pi's real helpers)
// ---------------------------------------------------------------------------

test("the request carries contents, the system prompt, thought parts for reasoning models, and the output limit", () => {
	const request = buildGeminiRequest(model(), context(), undefined) as any;
	assert.deepEqual(request.contents, [{ role: "user", parts: [{ text: "synthetic question" }] }]);
	assert.deepEqual(request.systemInstruction, { parts: [{ text: "Synthetic system prompt" }] });
	assert.deepEqual(request.generationConfig.thinkingConfig, { includeThoughts: true });
	assert.equal(request.generationConfig.maxOutputTokens, 65_536 - 0 > 0 ? request.generationConfig.maxOutputTokens : 0);
	assert.ok(request.generationConfig.maxOutputTokens > 0 && request.generationConfig.maxOutputTokens <= 65_536);
	assert.equal(request.tools, undefined);
	assert.equal(request.toolConfig, undefined);
});

test("a non-reasoning model gets no thinking config, and caller options are honored", () => {
	const request = buildGeminiRequest(model({ reasoning: false }), context(), { temperature: 0.25, maxTokens: 321 } as never) as any;
	assert.equal(request.generationConfig.thinkingConfig, undefined);
	assert.equal(request.generationConfig.temperature, 0.25);
	assert.equal(request.generationConfig.maxOutputTokens, 321);
});

test("an empty system prompt produces no systemInstruction", () => {
	const request = buildGeminiRequest(model(), context({ systemPrompt: "" }), undefined) as any;
	assert.equal(request.systemInstruction, undefined);
});

test("tools become functionDeclarations using the JSON-schema field the backend defines", () => {
	const tool = { name: "get_weather", description: "Get the weather", parameters: Type.Object({ city: Type.String() }) };
	const request = buildGeminiRequest(model(), context({ tools: [tool] }), undefined) as any;
	const declaration = request.tools[0].functionDeclarations[0];
	assert.equal(declaration.name, "get_weather");
	assert.equal(declaration.description, "Get the weather");
	assert.ok(declaration.parametersJsonSchema, "parameters_json_schema exists on the backend's FunctionDeclaration");
	assert.equal(declaration.parametersJsonSchema.properties.city.type, "string");
	assert.ok(request.toolConfig === undefined || request.toolConfig.functionCallingConfig, "a tool choice mode is optional");
});

test("a model that needs call ids (claude-, gpt-oss-) round-trips them through tool results", () => {
	const messages = [
		{ role: "user", content: "run it", timestamp: 0 },
		{ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "Paris" } }], api: API_ID, provider: "agy-subscription", model: "claude-sonnet-5-5-low", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 },
		{ role: "toolResult", toolCallId: "call_1", toolName: "get_weather", content: [{ type: "text", text: "sunny" }], isError: false, timestamp: 0 },
	];
	const request = buildGeminiRequest(model({ id: "claude-sonnet-5-5-low" }), context({ messages }), undefined) as any;
	const [, model_, result_] = request.contents;
	assert.equal(model_.parts[0].functionCall.id, "call_1");
	assert.equal(model_.parts[0].functionCall.name, "get_weather");
	assert.equal(result_.parts[0].functionResponse.id, "call_1");
	assert.equal(result_.parts[0].functionResponse.response.output, "sunny");
});

test("the envelope carries exactly the fields the backend defines, with the project and honest identity", () => {
	let n = 0;
	const envelope = buildEnvelope(model(), { contents: [] }, PROJECT, () => `id-${++n}`);
	assert.deepEqual(envelope, {
		project: PROJECT, requestId: "pi-id-1", model: "gemini-3.8-flash-low", userAgent: USER_AGENT,
		requestType: "agent", userPromptId: "id-2", request: { contents: [] },
	});
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test("a wrapped SSE stream becomes text events with usage and a stop reason, over the right request", async () => {
	const r = await run(okStream(sse(
		chunk([{ text: "Hel" }]),
		chunk([{ text: "lo" }], { finishReason: "STOP" }, true),
		{ response: { usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 107 }, responseId: "resp-9" } },
	)));
	assert.deepEqual(r.types, ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
	assert.deepEqual(r.events.filter((e) => e.type === "text_delta").map((e) => e.delta), ["Hel", "lo"]);
	assert.equal(r.message.content[0].text, "Hello");
	assert.equal(r.message.stopReason, "stop");
	assert.equal(r.message.responseId, "resp-9");
	assert.deepEqual({ input: r.message.usage.input, output: r.message.usage.output, cacheRead: r.message.usage.cacheRead, reasoning: r.message.usage.reasoning, total: r.message.usage.totalTokens },
		{ input: 70, output: 7, cacheRead: 30, reasoning: 2, total: 107 });

	assert.equal(r.calls.length, 1);
	assert.equal(r.calls[0].url, `${BASE}/v1internal:streamGenerateContent?alt=sse`);
	const headers = new Headers(r.calls[0].init.headers);
	assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
	assert.equal(headers.get("accept"), "text/event-stream");
	assert.equal(r.calls[0].init.redirect, "error");
	const body = JSON.parse(String(r.calls[0].init.body));
	assert.equal(body.project, PROJECT);
	assert.equal(body.model, "gemini-3.8-flash-low");
	assert.ok(body.request.contents && body.request.generationConfig);
	assert.ok(!JSON.stringify(body).includes(TOKEN), "the token never enters the body");
});

test("an unwrapped chunk is accepted too, and [DONE] and comments are ignored", async () => {
	const body = `: hi\n\ndata: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }] })}\n\ndata: [DONE]\n\n`;
	const r = await run(okStream(body));
	assert.equal(r.message.content[0].text, "x");
	assert.equal(r.message.stopReason, "stop");
});

test("thought parts become thinking blocks that close before text opens, keeping signatures", async () => {
	const r = await run(okStream(sse(
		chunk([{ text: "pondering", thought: true, thoughtSignature: "sig-A" }]),
		chunk([{ text: " more", thought: true }]),
		chunk([{ text: "answer", thoughtSignature: "sig-B" }], { finishReason: "STOP" }),
	)));
	assert.deepEqual(r.types, ["start", "thinking_start", "thinking_delta", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"]);
	assert.equal(r.message.content[0].thinking, "pondering more");
	assert.equal(r.message.content[0].thinkingSignature, "sig-A");
	assert.equal(r.message.content[1].text, "answer");
	assert.equal(r.message.content[1].textSignature, "sig-B");
});

test("a function call becomes a tool call and flips STOP to toolUse", async () => {
	const r = await run(okStream(sse(
		chunk([{ text: "calling" }]),
		chunk([{ functionCall: { id: "call_77", name: "get_weather", args: { city: "Paris" } }, thoughtSignature: "sig-T" }], { finishReason: "STOP" }),
	)));
	assert.deepEqual(r.types, ["start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
	assert.deepEqual(r.message.content[1], { type: "toolCall", id: "call_77", name: "get_weather", arguments: { city: "Paris" }, thoughtSignature: "sig-T" });
	assert.equal(r.message.stopReason, "toolUse");
});

test("missing and duplicate call ids get unique generated ones; non-object args become {}", async () => {
	const r = await run(okStream(sse(
		chunk([{ functionCall: { id: "dup", name: "a", args: { k: 1 } } }, { functionCall: { id: "dup", name: "b", args: "oops" } }, { functionCall: { name: "c" } }], { finishReason: "STOP" }),
	)));
	const calls = r.message.content.filter((b: any) => b.type === "toolCall");
	assert.equal(new Set(calls.map((c: any) => c.id)).size, 3);
	assert.equal(calls[0].id, "dup");
	assert.deepEqual(calls[1].arguments, {});
	assert.deepEqual(calls[2].arguments, {});
});

test("finish reasons map to Pi stop reasons, and a safety stop is an error", async () => {
	for (const [finish, expected] of [["STOP", "stop"], ["MAX_TOKENS", "length"]] as const) {
		const r = await run(okStream(sse(chunk([{ text: "x" }], { finishReason: finish }))));
		assert.equal(r.message.stopReason, expected, finish);
	}
	const blocked = await run(okStream(sse(chunk([{ text: "x" }], { finishReason: "SAFETY" }))));
	assert.equal(blocked.message.stopReason, "error");
	assert.match(blocked.message.errorMessage, /SAFETY/);
});

test("the caller's onPayload can replace the envelope, and onProviderStreamEvent sees each unwrapped chunk", async () => {
	const seen: unknown[] = [];
	const r = await run(okStream(sse(chunk([{ text: "x" }], { finishReason: "STOP" }))), {
		onPayload: async (payload: any) => ({ ...payload, requestType: "replaced-by-caller" }),
		onProviderStreamEvent: async (c: unknown) => { seen.push(c); },
	});
	assert.equal(JSON.parse(String(r.calls[0].init.body)).requestType, "replaced-by-caller");
	assert.equal(seen.length, 1);
	assert.ok((seen[0] as any).candidates, "the chunk is the unwrapped response, not the envelope");
});

// ---------------------------------------------------------------------------
// Failures (all credential-safe)
// ---------------------------------------------------------------------------

test("an HTTP rejection becomes a described error and never leaks the token", async () => {
	const r = await run(() => new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: `denied for ${TOKEN} ya29.leakme` } }), { status: 403, headers: { "x-cloudaicompanion-trace-id": "trace-xyz" } }));
	assert.deepEqual(r.types, ["error"]);
	assert.equal(r.message.stopReason, "error");
	for (const expected of [/HTTP 403/, /PERMISSION_DENIED/, /trace-xyz/, /not permitted/]) assert.match(r.message.errorMessage, expected);
	assert.ok(!r.message.errorMessage.includes("leakme"));
	assert.ok(!r.message.errorMessage.includes("ya29"));
});

test("a 429 carries the retry hint, and it is not retried automatically", async () => {
	const r = await run(() => new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }), { status: 429, headers: { "retry-after": "42" } }));
	assert.match(r.message.errorMessage, /HTTP 429/);
	assert.match(r.message.errorMessage, /retry-after: 42s/);
	assert.equal(r.calls.length, 1);
});

test("transport failures are sanitized, an invalid event is an error, and a stream error event is described", async () => {
	const net = await run(() => { throw new Error(`transport ${TOKEN}`); });
	assert.equal(net.message.errorMessage, "Antigravity network request failed.");
	const bad = await run(okStream("data: {not json\n\n"));
	assert.match(bad.message.errorMessage, /Invalid Antigravity stream event/);
	const inband = await run(okStream(sse({ error: { code: 500, status: "INTERNAL", message: "boom ya29.zzz" } })));
	assert.match(inband.message.errorMessage, /INTERNAL/);
	assert.ok(!inband.message.errorMessage.includes("zzz"));
});

test("a stream that ends without a finish reason, an empty body, and a blocked prompt are explicit errors", async () => {
	assert.match((await run(okStream(sse(chunk([{ text: "x" }]))))).message.errorMessage, /without a finish reason/);
	assert.match((await run(() => new Response(null, { status: 200 }))).message.errorMessage, /empty stream/);
	const blocked = await run(okStream(sse({ response: { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } } })));
	assert.match(blocked.message.errorMessage, /blocked by the provider \(PROHIBITED_CONTENT\)/);
	const weird = await run(okStream(sse({ response: { promptFeedback: { blockReason: "<script>" } } })));
	assert.ok(!/script/.test(weird.message.errorMessage ?? ""), "a hostile block reason is never echoed");
});

test("missing credentials fail before any request", async () => {
	const calls: unknown[] = [];
	const stream = createAgyStreamSimple({ baseUrl: BASE, fetchImpl: (async () => { calls.push(1); return new Response(""); }) as never })(model(), context(), {} as never);
	for await (const _ of stream) { /* drain */ }
	assert.match(((await stream.result()) as any).errorMessage, /No Antigravity access token/);
	assert.equal(calls.length, 0);
});

test("cancellation before the request sends nothing; cancellation mid-stream ends as aborted", async () => {
	const pre = new AbortController(); pre.abort();
	const a = await run(okStream(sse(chunk([{ text: "x" }]))), { signal: pre.signal });
	assert.equal(a.calls.length, 0);
	assert.equal(a.message.stopReason, "aborted");

	const mid = new AbortController();
	const body = new ReadableStream<Uint8Array>({
		start(c) { c.enqueue(new TextEncoder().encode(sse(chunk([{ text: "partial" }])))); },
		pull() { return new Promise(() => {}); },
		cancel() {},
	});
	const stream = createAgyStreamSimple({ baseUrl: BASE, fetchImpl: (async () => new Response(body, { status: 200 })) as never })(model(), context(), { apiKey: apiKey(), signal: mid.signal } as never);
	const types: string[] = [];
	for await (const event of stream) { types.push((event as any).type); if ((event as any).type === "text_delta") mid.abort(); }
	assert.equal(((await stream.result()) as any).stopReason, "aborted");
	assert.equal(types[types.length - 1], "error");
});
