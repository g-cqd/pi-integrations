import assert from "node:assert/strict";
import { test } from "bun:test";
import { createAssistantMessageEventStream, normalizeContext, type RefreshModelsContext } from "@earendil-works/pi-ai/compat";
import { createCopilotProvider, API_ID } from "../../src/domains/copilot/provider.ts";

async function transport(response: Response | (() => Promise<Response>)) {
 let options: Parameters<NonNullable<ReturnType<typeof createCopilotProvider>["streamSimple"]>>[2];
 const config = createCopilotProvider({ streamSimple: (_model, _context, opts) => { options = opts; return createAssistantMessageEventStream(); } });
 await config.refreshModels!({ allowNetwork: false, signal: new AbortController().signal, stored: { models: [{ id: "test", name: "Test", provider: "copilot-vscode", baseUrl: "https://api.githubcopilot.com", api: "openai-completions", input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] }, publish: async p => { p.update?.(); return true; } } as RefreshModelsContext);
 const calls: unknown[] = [];
 config.streamSimple!({ id: "test", api: API_ID } as never, normalizeContext({ messages: [] }), {
  apiKey: config.oauth!.getApiKey({ access: "synthetic-token", refresh: "synthetic-grant", expires: 1, apiUrl: "https://api.githubcopilot.com", machineId: "machine", deviceId: "device" }),
  fetch: (async (...args: unknown[]) => { calls.push(args); return typeof response === "function" ? response() : response; }) as typeof fetch,
 });
 return { fetch: options!.fetch!, options: options!, calls };
}

for (const [status, hint] of [[401, "/login"], [403, "policy"], [429, "rate"], [500, "service"], [402, "billing"]] as const) {
 test(`HTTP ${status} gives a safe actionable error without forwarding sensitive headers`, async () => {
  const t = await transport(new Response("synthetic-secret", { status, headers: { "x-request-id": "synthetic-secret", "content-length": "999999", "retry-after": "5" } }));
  const r = await t.fetch("https://api.githubcopilot.com/chat/completions");
  assert.equal(r.status, status); assert.equal(r.headers.get("x-request-id"), null);
  assert.equal(r.headers.get("content-length"), null); assert.equal(r.headers.get("retry-after"), "5");
  const body = await r.text(); assert.ok(body.includes(hint)); assert.ok(!body.includes("synthetic-secret"));
  assert.equal(t.options.maxRetries, 0);
 });
}

test("throwing body cancellation cannot replace the HTTP error or leak its exception", async () => {
 const t = await transport(new Response(new ReadableStream({ cancel() { throw new Error("synthetic-secret"); } }), { status: 403 }));
 const r = await t.fetch("https://api.githubcopilot.com/chat/completions");
 assert.equal(r.status, 403); assert.ok(!(await r.text()).includes("synthetic-secret"));
});

test("network exceptions are sanitized and never automatically replayed", async () => {
 const t = await transport(async () => { throw new Error("synthetic-secret"); });
 await assert.rejects(t.fetch("https://api.githubcopilot.com/chat/completions"), /^Error: Copilot inference network request failed\.$/);
 assert.equal(t.calls.length, 1); assert.equal(t.options.maxRetries, 0);
});

test("a stalled error-body cancellation never blocks the actionable HTTP response", async () => {
 let cancelled = 0;
 const t = await transport(new Response(new ReadableStream({ cancel() { cancelled++; return new Promise<void>(() => {}); } }), { status: 429 }));
 // This deterministic microtask sentinel fails if transport awaits cancellation.
 const result = await Promise.race([
  t.fetch("https://api.githubcopilot.com/chat/completions"),
  Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => "blocked"),
 ]);
 assert.notEqual(result, "blocked"); assert.equal(cancelled, 1);
 assert.equal((result as Response).status, 429);
});
