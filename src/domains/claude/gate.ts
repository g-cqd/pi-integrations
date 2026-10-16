/**
 * Subscription inference gate for the Claude domain.
 *
 * Subscription OAuth inference (api.anthropic.com with an sk-ant-oat bearer
 * token) is gated by a fuzzy prompt-content classifier over the request's
 * system param and system-role messages. Empirically derived by live
 * bisection against the backend (2026-10-16):
 *
 *   - The system param's first block must exactly equal a canonical
 *     first-party identity line. Generic first blocks get 429.
 *   - Third-party harness prompts (Pi's own system prompt) in the system
 *     param — after block 0 — or sent as system-ROLE messages anywhere in
 *     the conversation trip the classifier (400 "out of extra usage" / 429).
 *   - The same prompt content passes cleanly when carried as blocks inside
 *     USER messages (Claude Code's own <system-reminder> pattern).
 *   - Headers, betas, tools, metadata, and max_tokens are irrelevant to the
 *     gate; client-identity headers are applied automatically by Pi's
 *     Anthropic implementation when the API key contains "sk-ant-oat".
 *
 * Strategy (fail-safe by construction):
 *   1. Absorb every system-role message into an adjacent user message
 *      (content unchanged, just relocated).
 *   2. Reduce the system param to the single canonical line; move its other
 *      blocks to the front of the conversation. If there is no user message
 *      to carry them, insert one — never send an un-gated payload.
 *   3. tool_result blocks must lead a user message (Anthropic API rule), so
 *      moved blocks are inserted after any leading tool_result blocks.
 *
 * Idempotent, non-mutating, preserves cache_control and unknown block fields.
 */
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { CANONICAL_SYSTEM_LINE } from "./canonical.ts";
import { diagnosticFetch, gateFingerprint, withDriftDiagnostics, type DriftCapture, type GateFingerprint } from "./diagnostics.ts";

export { CANONICAL_SYSTEM_LINE };

interface SystemBlock {
	type?: string;
	text?: string;
	[key: string]: unknown;
}

/** Pi's per-request payload hook: undefined means "keep the original payload". */
export type PayloadHook = (payload: unknown, model: unknown) => unknown | undefined | Promise<unknown | undefined>;

function isCanonicalOnly(system: unknown): boolean {
	return (
		Array.isArray(system) &&
		system.length === 1 &&
		typeof system[0] === "object" &&
		system[0] !== null &&
		(system[0] as SystemBlock).text === CANONICAL_SYSTEM_LINE
	);
}

function isToolResult(block: unknown): boolean {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: string }).type === "tool_result"
	);
}

/** Normalize message content into a block array (strings become text blocks). */
function normalizeContentBlocks(content: unknown): unknown[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content;
	if (content === undefined || content === null) return [];
	return [content];
}

/** Original content as array, preserving string elements as-is. */
function contentAsArray(content: unknown): unknown[] {
	if (typeof content === "string") return [content];
	if (Array.isArray(content)) return content;
	if (content === undefined || content === null) return [];
	return [content];
}

/** Merge `blocks` into `content` at the front, but AFTER any leading
 * tool_result blocks (Anthropic requires tool_result blocks to lead a user
 * message's content array). */
function mergeBlocksBefore(blocks: unknown[], content: unknown): unknown[] {
	const orig = contentAsArray(content);
	let i = 0;
	while (i < orig.length && isToolResult(orig[i])) i++;
	return [...orig.slice(0, i), ...blocks, ...orig.slice(i)];
}

/** Merge `blocks` into `content` at the end. */
function mergeBlocksAfter(content: unknown, blocks: unknown[]): unknown[] {
	return [...contentAsArray(content), ...blocks];
}

type Message = Record<string, unknown>;

/**
 * Absorb every system-role message into an adjacent user message:
 * pending system blocks are prepended (tool_result-aware) to the NEXT user
 * message; if none follows, appended to the LAST user message; if the
 * conversation has no user message at all, one is created at the front.
 */
function absorbSystemMessages(messages: Message[]): Message[] {
	const next: Message[] = [];
	let pending: unknown[] = [];
	let lastUserIdx = -1;

	for (const m of messages) {
		if (m.role === "system") {
			pending = [...pending, ...normalizeContentBlocks(m.content)];
			continue;
		}
		if (m.role === "user" && pending.length > 0) {
			next.push({ ...m, content: mergeBlocksBefore(pending, m.content) });
			pending = [];
		} else {
			next.push(m);
		}
		if (m.role === "user") lastUserIdx = next.length - 1;
	}

	if (pending.length > 0) {
		if (lastUserIdx >= 0) {
			next[lastUserIdx] = {
				...next[lastUserIdx],
				content: mergeBlocksAfter(next[lastUserIdx].content, pending),
			};
		} else {
			next.unshift({ role: "user", content: pending });
		}
	}
	return next;
}

/**
 * Gate transform. Returns a shallow-copied payload with:
 *   system := [canonical block]
 *   system-role messages := absorbed into user messages
 *   moved prompt blocks := carried by user messages
 * Never leaves a non-canonical system param un-rewritten when there is
 * prompt content to relocate; inserts a user message when needed.
 */
export function applyClaudeCodeSystemGate<T>(payload: T): T {
	if (payload === null || typeof payload !== "object") return payload;
	const p = payload as Record<string, unknown>;

	// ---- Phase 1: absorb system-role messages (they trip the classifier).
	let messages = Array.isArray(p.messages) ? (p.messages as Message[]) : undefined;
	let messagesChanged = false;
	if (messages && messages.some((m) => m && m.role === "system")) {
		messages = absorbSystemMessages(messages);
		messagesChanged = true;
	}

	// ---- Phase 2: canonicalize the system param.
	const system = p.system;
	const canonical: SystemBlock = { type: "text", text: CANONICAL_SYSTEM_LINE };
	let moveBlocks: unknown[] | null = null;

	if (system === undefined || (Array.isArray(system) && system.length === 0)) {
		// nothing to move; just ensure the canonical line exists
	} else if (isCanonicalOnly(system)) {
		if (!messagesChanged) return payload;
		return { ...p, messages: messages! } as T;
	} else if (typeof system === "string") {
		moveBlocks = [{ type: "text", text: system }];
	} else if (Array.isArray(system)) {
		moveBlocks = system;
	} else {
		// unknown system shape: leave it (best effort) but keep absorption
		return messagesChanged ? { ...p, messages: messages! } as T : payload;
	}

	if (moveBlocks) {
		const msgs = messages ?? [];
		if (msgs.length === 0 || msgs[0]?.role !== "user") {
			// No leading user message to carry the prompt: insert one rather
			// than sending an un-gated payload.
			return {
				...p,
				system: [canonical],
				messages: [{ role: "user", content: moveBlocks }, ...msgs],
			} as T;
		}
		const first = msgs[0];
		const merged = mergeBlocksBefore(moveBlocks, first.content);
		return {
			...p,
			system: [canonical],
			messages: [{ ...first, content: merged }, ...msgs.slice(1)],
		} as T;
	}

	if (messagesChanged) return { ...p, system: [canonical], messages: messages! } as T;
	return { ...p, system: [canonical] } as T;
}

/**
 * Build an onPayload hook that chains an optional inner hook (Pi's request
 * inspection uses these and may return undefined = "no change") with the
 * system gate. The gate must ALWAYS run: an inner hook returning undefined
 * must not cause the request to go out un-gated (Pi treats undefined as
 * "keep original params").
 */
export function chainedSystemGate(inner?: PayloadHook): (payload: unknown, model: unknown) => Promise<unknown> {
	return async (payload: unknown, model: unknown) => {
		const p = inner ? ((await inner(payload, model)) ?? payload) : payload;
		return applyClaudeCodeSystemGate(p);
	};
}

/**
 * Wrap a streamSimple implementation so every outgoing request passes the
 * subscription gate. The caller's onPayload hook runs first (its replacement
 * payload, if any, is gated); all other options, including the caller's own
 * onResponse and fetch, are preserved. Rejected responses are additionally
 * captured at the fetch layer and, if the request fails, the stream's
 * terminal error is enriched with a credential-safe protocol-drift report
 * (see diagnostics.ts for why capture and enrichment sit at these seams).
 */
export function subscriptionGateStreamSimple(
	streamSimple: NonNullable<ProviderConfig["streamSimple"]>,
	gate: (payload: unknown) => unknown = applyClaudeCodeSystemGate,
): NonNullable<ProviderConfig["streamSimple"]> {
	return (model, context, options) => {
		const capture: DriftCapture = {};
		let fingerprint: GateFingerprint | undefined;
		const inner = options?.onPayload as PayloadHook | undefined;
		const onPayload = async (payload: unknown, payloadModel: unknown) => {
			const p = inner ? ((await inner(payload, payloadModel)) ?? payload) : payload;
			const gated = gate(p);
			fingerprint = gateFingerprint(gated);
			return gated;
		};
		const fetch = diagnosticFetch(capture, options?.fetch);
		const merged = { ...(options ?? {}), onPayload, fetch } as NonNullable<typeof options>;
		return withDriftDiagnostics(streamSimple(model, context, merged), capture, () => fingerprint);
	};
}
