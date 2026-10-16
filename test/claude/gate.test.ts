import assert from "node:assert/strict";
import { test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	CANONICAL_SYSTEM_LINE,
	applyClaudeCodeSystemGate,
	chainedSystemGate,
	subscriptionGateStreamSimple,
} from "../../src/domains/claude/gate.ts";

// All prompt content here is synthetic. The classifier behavior these tests
// encode was established by live bisection (2026-10-16): the canonical line
// must be the only system block; third-party prompts pass in user messages.

const SDK = CANONICAL_SYSTEM_LINE;

/** Local view of an Anthropic Messages request payload (synthetic fixtures). */
type GatePayload = { model: string; system?: unknown; messages: Array<{ role: string; content: unknown }> };

test("moves system blocks into the first user message and keeps only the canonical line", () => {
	const payload = {
		model: "x",
		system: [{ type: "text", text: "You are pi, a coding agent." }, { type: "text", text: "rules…" }],
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	};
	const out = applyClaudeCodeSystemGate(payload);
	assert.deepEqual(out.system, [{ type: "text", text: SDK }]);
	assert.equal(out.messages.length, 1);
	assert.equal(out.messages[0].role, "user");
	const blocks = out.messages[0].content;
	assert.equal(blocks.length, 3);
	assert.equal(blocks[0].text, "You are pi, a coding agent.");
	assert.equal(blocks[1].text, "rules…");
	assert.equal(blocks[2].text, "hi");
});

test("converts string system to a moved block", () => {
	const payload: GatePayload = { model: "x", system: "You are pi, a coding agent.", messages: [{ role: "user", content: "hi" }] };
	const out = applyClaudeCodeSystemGate(payload);
	assert.deepEqual(out.system, [{ type: "text", text: SDK }]);
	const blocks = out.messages[0].content as Array<{ text?: string }>;
	assert.equal(blocks[0].text, "You are pi, a coding agent.");
	assert.equal(blocks[1], "hi");
});

test("adds the canonical line when system is missing", () => {
	const payload: GatePayload = { model: "x", messages: [{ role: "user", content: "hi" }] };
	const out = applyClaudeCodeSystemGate(payload);
	assert.deepEqual(out.system, [{ type: "text", text: SDK }]);
	assert.equal(out.messages[0].content, "hi");
});

test("idempotent: system already canonical-only is left unchanged (blocks not re-moved)", () => {
	const payload = { model: "x", system: [{ type: "text", text: SDK }], messages: [{ role: "user", content: "hi" }] };
	const out = applyClaudeCodeSystemGate(payload);
	assert.deepEqual(out, payload);
});

test("preserves cache_control on moved blocks", () => {
	const payload = {
		model: "x",
		system: [{ type: "text", text: "You are pi.", cache_control: { type: "ephemeral" } }],
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	};
	const out = applyClaudeCodeSystemGate(payload);
	const blocks = out.messages[0].content as Array<Record<string, unknown>>;
	assert.equal((blocks[0].cache_control as { type?: string } | undefined)?.type, "ephemeral");
});

test("inserts a user message when messages are empty", () => {
	const payload: GatePayload = { model: "x", system: [{ type: "text", text: "You are pi." }], messages: [] };
	const out = applyClaudeCodeSystemGate(payload);
	assert.deepEqual(out.system, [{ type: "text", text: SDK }]);
	assert.equal(out.messages.length, 1);
	assert.equal(out.messages[0].role, "user");
	const blocks = out.messages[0].content as Array<{ text?: string }>;
	assert.equal(blocks[0].text, "You are pi.");
});

test("does not mutate the input payload", () => {
	const payload = { model: "x", system: [{ type: "text", text: "original" }], messages: [{ role: "user", content: "hi" }] };
	applyClaudeCodeSystemGate(payload);
	assert.equal(payload.system.length, 1);
	assert.equal(payload.messages[0].content, "hi");
});

test("tolerates non-object payloads", () => {
	assert.equal(applyClaudeCodeSystemGate(undefined), undefined);
	assert.equal(applyClaudeCodeSystemGate("string"), "string");
});

test("inserts a leading user message when the first message is not user (fail-safe)", () => {
	const payload: GatePayload = { model: "x", system: [{ type: "text", text: "prompt" }], messages: [{ role: "assistant", content: "hi" }] };
	const out = applyClaudeCodeSystemGate(payload);
	assert.deepEqual(out.system, [{ type: "text", text: SDK }]);
	assert.equal(out.messages.length, 2);
	assert.equal(out.messages[0].role, "user");
	const blocks = out.messages[0].content as Array<{ text?: string }>;
	assert.equal(blocks[0].text, "prompt");
	assert.equal(out.messages[1].role, "assistant");
});

// ---------------------------------------------------------------------------
// tool_result ordering: Anthropic requires tool_result blocks to lead a user
// message; moved/absorbed blocks must be inserted AFTER them.
// ---------------------------------------------------------------------------

test("moves system blocks after leading tool_result blocks in the first user message", () => {
	const payload = {
		model: "x",
		system: [{ type: "text", text: "harness prompt" }],
		messages: [
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "toolu_1", content: "result" },
					{ type: "text", text: "original user text" },
				],
			},
		],
	} as GatePayload;
	const out = applyClaudeCodeSystemGate(payload) as GatePayload;
	const blocks = (out.messages[0] as { content: Array<Record<string, string>> }).content;
	assert.equal(blocks[0].type, "tool_result");
	assert.equal(blocks[1].text, "harness prompt");
	assert.equal(blocks[2].text, "original user text");
});

test("absorbs a system-role message after leading tool_result blocks without breaking order", () => {
	const payload = {
		model: "x",
		system: [{ type: "text", text: SDK }],
		messages: [
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result" }] },
			{ role: "system", content: [{ type: "text", text: "mid-turn note" }] },
			{ role: "user", content: [{ type: "text", text: "hi" }] },
		],
	} as GatePayload;
	const out = applyClaudeCodeSystemGate(payload) as GatePayload;
	const roles = (out.messages as Array<{ role: string }>).map((m) => m.role);
	assert.deepEqual(roles, ["user", "user"]);
	const second = (out.messages as Array<{ content: Array<Record<string, string>> }>)[1];
	assert.equal(second.content[0].text, "mid-turn note");
	assert.equal(second.content[1].text, "hi");
	const first = (out.messages as Array<{ content: Array<Record<string, string>> }>)[0];
	assert.equal(first.content[0].type, "tool_result");
});

// ---------------------------------------------------------------------------
// Mid-conversation system-role messages: a system-role message anywhere in
// messages trips the classifier; user-message content never does. The gate
// must absorb them into adjacent user messages.
// ---------------------------------------------------------------------------

test("absorbs a mid-conversation system-role message into the next user message", () => {
	const payload = {
		model: "x",
		system: [{ type: "text", text: SDK }],
		messages: [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
			{ role: "system", content: [{ type: "text", text: "Updated instructions." }] },
			{ role: "user", content: "Reply: ok" },
		],
	} as GatePayload;
	const out = applyClaudeCodeSystemGate(payload) as GatePayload;
	assert.deepEqual(out.system, [{ type: "text", text: SDK }]);
	assert.deepEqual(out.messages.map((m: { role: string }) => m.role), ["user", "assistant", "user"]);
	const last = out.messages[2] as { content: Array<{ text?: string }> };
	assert.equal(last.content[0].text, "Updated instructions.");
	assert.equal(last.content[1], "Reply: ok");
});

test("absorbs a leading system-role message into the following user message", () => {
	const payload = {
		model: "x",
		messages: [
			{ role: "system", content: [{ type: "text", text: "Harness prompt." }] },
			{ role: "user", content: "hi" },
		],
	} as GatePayload;
	const out = applyClaudeCodeSystemGate(payload) as GatePayload;
	assert.equal((out.messages as Array<{ role: string }>)[0].role, "user");
	const first = (out.messages as Array<{ content: Array<{ text?: string }> }>)[0];
	assert.equal(first.content[0].text, "Harness prompt.");
});

test("folds a trailing system-role message into the previous user message", () => {
	const payload = {
		model: "x",
		system: [{ type: "text", text: SDK }],
		messages: [
			{ role: "user", content: "hi" },
			{ role: "system", content: [{ type: "text", text: "Final note." }] },
		],
	} as GatePayload;
	const out = applyClaudeCodeSystemGate(payload) as GatePayload;
	assert.equal(out.messages.length, 1);
	const first = out.messages[0] as { content: Array<{ text?: string }> };
	assert.equal(first.content[0], "hi");
	assert.equal(first.content[1].text, "Final note.");
});

test("absorbs consecutive system-role messages in order", () => {
	const payload = {
		model: "x",
		system: [{ type: "text", text: SDK }],
		messages: [
			{ role: "system", content: [{ type: "text", text: "One." }] },
			{ role: "system", content: [{ type: "text", text: "Two." }] },
			{ role: "user", content: "hi" },
		],
	} as GatePayload;
	const out = applyClaudeCodeSystemGate(payload) as GatePayload;
	const first = (out.messages as Array<{ content: Array<{ text?: string }> }>)[0];
	assert.equal(first.content.map((b: { text?: string }) => b.text ?? b).join("|"), "One.|Two.|hi");
});

test("gate is idempotent after absorption (no system-role messages remain)", () => {
	const payload = {
		model: "x",
		system: [{ type: "text", text: "pi prompt" }],
		messages: [
			{ role: "user", content: "hi" },
			{ role: "system", content: [{ type: "text", text: "note" }] },
			{ role: "user", content: "ok" },
		],
	} as GatePayload;
	const once = applyClaudeCodeSystemGate(payload) as GatePayload;
	const twice = applyClaudeCodeSystemGate(once) as GatePayload;
	assert.deepEqual(twice, once);
});

test("handles string-content system-role messages", () => {
	const payload = {
		model: "x",
		system: [{ type: "text", text: SDK }],
		messages: [
			{ role: "user", content: "hi" },
			{ role: "system", content: "note text" },
			{ role: "user", content: "ok" },
		],
	} as GatePayload;
	const out = applyClaudeCodeSystemGate(payload) as GatePayload;
	const second = (out.messages as Array<{ content: Array<{ text?: string }> }>)[1];
	assert.equal(second.content[0].text, "note text");
});

// ---------------------------------------------------------------------------
// chainedSystemGate: the gate must survive Pi's own onPayload hooks
// ---------------------------------------------------------------------------

test("chainedSystemGate runs the gate when the inner hook returns undefined", async () => {
	const gate = chainedSystemGate(() => undefined);
	const payload = { model: "x", system: [{ type: "text", text: "pi prompt" }], messages: [{ role: "user", content: "hi" }] };
	const out = await gate(payload, "m");
	const o = out as { system: Array<{ text?: string }> };
	assert.equal(o.system[0].text, SDK);
});

test("chainedSystemGate applies the gate to the inner hook's replacement payload", async () => {
	const gate = chainedSystemGate(() => ({ model: "y", system: [{ type: "text", text: "replaced prompt" }], messages: [{ role: "user", content: "hi" }] }));
	const out = (await gate({ model: "x", messages: [] }, "m")) as { model: string; system: Array<{ text?: string }> };
	assert.equal(out.model, "y");
	assert.equal(out.system[0].text, SDK);
});

test("chainedSystemGate works with no inner hook and never returns undefined", async () => {
	const gate = chainedSystemGate(undefined);
	const out = await gate({ model: "x", system: [{ type: "text", text: "p" }], messages: [{ role: "user", content: "hi" }] }, "m");
	const o = out as { system: Array<{ text?: string }> };
	assert.notEqual(o, undefined);
	assert.equal(o.system.length, 1);
	assert.equal(o.system[0].text, SDK);
});

// ---------------------------------------------------------------------------
// subscriptionGateStreamSimple: the runtime seam. The caller's hook runs
// first, its replacement payload is gated, other options pass through, and
// the original event stream is delegated unchanged.
// ---------------------------------------------------------------------------

/** A real, already-completed stream whose terminal message is `message`. */
function completedStream(message: Record<string, unknown> = { role: "assistant", content: [], stopReason: "stop", timestamp: 0 }) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message } as never);
	stream.push({ type: "done", reason: "stop", message } as never);
	stream.end();
	return stream;
}

test("stream wrapper chains the caller's onPayload with the gate and passes other options through", async () => {
	let received: Record<string, unknown> | undefined;
	const inner: NonNullable<ProviderConfig["streamSimple"]> = (_model, _context, options) => {
		received = options as Record<string, unknown>;
		return completedStream();
	};
	const wrapped = subscriptionGateStreamSimple(inner);
	const callerHook = () => ({ model: "replaced-by-caller", messages: [{ role: "user", content: "hi" }] });
	const signal = new AbortController().signal;
	wrapped({ id: "synthetic-model" } as never, { messages: [] } as never, {
		signal, apiKey: "synthetic-key", onPayload: callerHook as never,
	} as never);
	assert.equal(received!.signal, signal, "caller options pass through by identity");
	assert.equal(received!.apiKey, "synthetic-key");
	const chained = received!.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;
	const gated = (await chained({ model: "x", system: [{ type: "text", text: "pi prompt" }], messages: [] }, "m")) as {
		model: string;
		system: Array<{ text?: string }>;
	};
	assert.equal(gated.model, "replaced-by-caller", "the caller's hook ran first");
	assert.equal(gated.system[0].text, SDK, "its replacement payload is still gated");
});

test("stream wrapper forwards the inner events and the same final message unchanged", async () => {
	const message = { role: "assistant", content: [{ type: "text", text: "synthetic" }], stopReason: "stop", timestamp: 0 };
	const wrapped = subscriptionGateStreamSimple(() => completedStream(message));
	const out = wrapped({ id: "synthetic-model" } as never, { messages: [] } as never);
	const types: string[] = [];
	for await (const event of out) types.push(event.type);
	assert.deepEqual(types, ["start", "done"]);
	assert.equal(await out.result(), message, "no copy: the shared message object is forwarded as-is");
});

test("stream wrapper gates even when the caller supplies no options at all", async () => {
	let received: Record<string, unknown> | undefined;
	const wrapped = subscriptionGateStreamSimple((_model, _context, options) => {
		received = options as Record<string, unknown>;
		return completedStream();
	});
	wrapped({ id: "synthetic-model" } as never, { messages: [] } as never);
	const chained = received!.onPayload as (payload: unknown) => Promise<unknown>;
	const gated = (await chained({ model: "x", system: [{ type: "text", text: "pi prompt" }], messages: [] })) as {
		system: Array<{ text?: string }>;
	};
	assert.equal(gated.system[0].text, SDK);
});

test("a custom gate is honored for testing without touching the real classifier rules", async () => {
	let received: Record<string, unknown> | undefined;
	const wrapped = subscriptionGateStreamSimple((_model, _context, options) => {
		received = options as Record<string, unknown>;
		return completedStream();
	}, (payload) => ({ gated: payload }));
	wrapped({ id: "m" } as never, { messages: [] } as never, {});
	const gated = (await (received!.onPayload as (p: unknown) => Promise<unknown>)({ original: true })) as { gated: { original: boolean } };
	assert.equal(gated.gated.original, true);
});
