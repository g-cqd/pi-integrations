/**
 * Protocol-drift diagnostics for the Claude subscription domain.
 *
 * Subscription inference through api.anthropic.com with an OAuth access token
 * is gated by a prompt-content classifier whose contract is undocumented and
 * can change without notice (see gate.ts and docs/domains/claude.md). When
 * the backend rejects a request, the failure Pi shows is only the SDK's
 * one-line error. This module replaces it with a single rich, credential-safe
 * report: HTTP status, request id, quota-utilization headers, a redacted
 * summary of the provider's error body, and a structural fingerprint of the
 * gated request (counts and booleans only, never content).
 *
 * Seams (verified against the installed Anthropic SDK and pi-ai):
 *   - The SDK throws APIError for every non-2xx response BEFORE pi-ai's
 *     onResponse hook runs, so onResponse never sees a rejection. Capture
 *     therefore happens in the fetch wrapper, which does see the response.
 *   - pi-ai turns the thrown error into a terminal `error` stream event whose
 *     message is shared with `result()`. Enrichment happens as that event
 *     passes through withDriftDiagnostics, before any consumer reads it.
 *
 * Safety posture (deliberate, documented exception): login and transport
 * helpers never echo provider bodies. This runtime diagnostic includes a
 * heavily redacted, truncated error summary because telling a classifier
 * rejection ("out of extra usage") from a genuine invalid request is the
 * whole point of drift debugging. Tokens, prompt content, tool names, and
 * full bodies never appear; no "sk-ant" substring is ever emitted.
 */
import { appendAssistantMessageDiagnostic, createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { CANONICAL_SYSTEM_LINE } from "./canonical.ts";
import { quotaExplanation } from "./quota.ts";

/** HTTP statuses observed in gate-rejection or subscription-auth failures. */
const DRIFT_STATUSES = new Set([400, 401, 403, 429]);
const BODY_READ_LIMIT = 4096;
/** The longest the diagnostic waits for a rejected body; the caller's own read is unaffected. */
const BODY_READ_TIMEOUT_MS = 2000;
const ORIGINAL_ERROR_LIMIT = 300;
export const DRIFT_DIAGNOSTIC_TYPE = "claude_subscription_protocol_drift";

/** Provider error-body summary; allowlisted type and truncated message only. */
export interface ErrorBodySummary {
	type?: string;
	message?: string;
}

/** Structural fingerprint of a (gated) request payload. No content values. */
export interface GateFingerprint {
	model?: string;
	messageCount: number;
	toolCount: number;
	maxTokens?: number;
	systemBlockCount: number;
	systemIsString: boolean;
	systemCanonicalMatch: boolean;
	systemRoleMessages: number;
}

/** Facts recorded by the fetch wrapper for the most recent rejected response. */
export interface DriftCapture {
	status?: number;
	/** Only request-id and anthropic-ratelimit-* headers are ever retained. */
	headers?: Record<string, string>;
	errorBody?: ErrorBodySummary;
}

/** Structured facts carried by a ProtocolDriftError. */
export interface DriftDetails {
	status: number;
	requestId?: string;
	quotaHeaders: Record<string, string>;
	errorBody?: ErrorBodySummary;
	fingerprint?: GateFingerprint;
}

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]+/g;

function redact(text: string): string {
	return text.replace(SECRET_RE, "[redacted-token]");
}

function truncate(text: string, max: number): string {
	const clean = redact(text.replace(/[\x00-\x1f\x7f]/g, " ").trim());
	return clean.length <= max ? clean : clean.slice(0, max) + "…";
}

/**
 * Summarize a provider error body (already text, at most a few KB). Accepts
 * Anthropic's envelope {"type":"error","error":{"type","message"}} or a bare
 * {"type","message"}; non-JSON degrades to a truncated redacted snippet.
 */
export function summarizeErrorBody(text: string): ErrorBodySummary | undefined {
	const ALLOWED_TYPE = /^[a-z_]{1,64}$/;
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { return { message: truncate(text, 160) }; }
	if (!parsed || typeof parsed !== "object") return undefined;
	const envelope = parsed as Record<string, unknown>;
	const error = envelope.error && typeof envelope.error === "object" ? envelope.error as Record<string, unknown> : envelope;
	const type = typeof error.type === "string" ? error.type : undefined;
	const message = typeof error.message === "string" ? error.message : undefined;
	return {
		...(type && ALLOWED_TYPE.test(type) ? { type } : {}),
		...(message ? { message: truncate(message, 160) } : {}),
	};
}

/** Structural fingerprint of a gated payload: counts and booleans, no content. */
export function gateFingerprint(payload: unknown): GateFingerprint {
	if (!payload || typeof payload !== "object") {
		return { messageCount: 0, toolCount: 0, systemBlockCount: 0, systemIsString: false, systemCanonicalMatch: false, systemRoleMessages: 0 };
	}
	const p = payload as Record<string, unknown>;
	const system = p.system;
	const systemBlocks = Array.isArray(system) ? system : undefined;
	const canonicalMatch = systemBlocks?.length === 1 &&
		typeof systemBlocks[0] === "object" && systemBlocks[0] !== null &&
		(systemBlocks[0] as { text?: unknown }).text === CANONICAL_SYSTEM_LINE;
	const messages = Array.isArray(p.messages) ? p.messages : [];
	let systemRole = 0;
	for (const m of messages) {
		if (m && typeof m === "object" && (m as { role?: unknown }).role === "system") systemRole++;
	}
	return {
		...(typeof p.model === "string" ? { model: p.model } : {}),
		messageCount: messages.length,
		toolCount: Array.isArray(p.tools) ? p.tools.length : 0,
		...(typeof p.max_tokens === "number" ? { maxTokens: p.max_tokens } : {}),
		systemBlockCount: systemBlocks?.length ?? (system === undefined ? 0 : 1),
		systemIsString: typeof system === "string",
		systemCanonicalMatch: canonicalMatch ?? false,
		systemRoleMessages: systemRole,
	};
}

/**
 * Up to BODY_READ_LIMIT bytes of a (cloned) rejected body, as text. Stops at the limit, at the end, or after
 * BODY_READ_TIMEOUT_MS, so a stalled or endless body can neither hang the request nor grow memory. Cancelling
 * the clone is not awaited: on a tee'd stream the cancel settles only when both branches have cancelled.
 */
async function readBoundedBody(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), BODY_READ_TIMEOUT_MS); });
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < BODY_READ_LIMIT) {
			const next = await Promise.race([reader.read(), deadline]);
			if (next === "timeout" || next.done) break;
			chunks.push(next.value);
			total += next.value.length;
		}
	} finally {
		clearTimeout(timer);
		reader.cancel().catch(() => { /* best-effort: only our branch is released */ });
	}
	const bytes = new Uint8Array(Math.min(total, BODY_READ_LIMIT));
	let offset = 0;
	for (const chunk of chunks) {
		const room = bytes.length - offset;
		if (room <= 0) break;
		bytes.set(chunk.length > room ? chunk.subarray(0, room) : chunk, offset);
		offset += Math.min(chunk.length, room);
	}
	return new TextDecoder().decode(bytes);
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function diagnosticHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, name) => {
		if (/^(request-id|x-request-id|anthropic-ratelimit)/i.test(name)) out[name.toLowerCase()] = value;
	});
	return out;
}

/**
 * Wrap a fetch implementation so rejected responses (400/401/403/429) are
 * recorded into `capture` (status, diagnostic headers, summarized body read
 * from a clone). The original response is returned untouched, so the SDK
 * still reads and reports it normally. The capture is reset on every call so
 * a stale rejection can never be attributed to a later, different failure.
 */
export function diagnosticFetch(capture: DriftCapture, fetchImpl?: FetchLike): typeof globalThis.fetch {
	const base: FetchLike = fetchImpl ?? globalThis.fetch;
	const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		delete capture.status;
		delete capture.headers;
		delete capture.errorBody;
		const response = await base(input, init);
		if (DRIFT_STATUSES.has(response.status)) {
			capture.status = response.status;
			capture.headers = diagnosticHeaders(response.headers);
			try {
				const summary = summarizeErrorBody(await readBoundedBody(response.clone()));
				if (summary) capture.errorBody = summary;
			} catch { /* best-effort: the original response is unaffected */ }
		}
		return response;
	};
	const preconnect = (base as { preconnect?: unknown }).preconnect;
	if (typeof preconnect === "function") (wrapped as { preconnect?: unknown }).preconnect = preconnect;
	return wrapped as typeof globalThis.fetch;
}

/** Build details from a capture; undefined when no rejection was recorded. */
export function driftDetailsFromCapture(capture: DriftCapture, fingerprint?: GateFingerprint): DriftDetails | undefined {
	if (capture.status === undefined) return undefined;
	const headers = capture.headers ?? {};
	const quotaHeaders: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (name.startsWith("anthropic-ratelimit")) quotaHeaders[name] = truncate(value, 80);
	}
	const requestId = headers["request-id"] ?? headers["x-request-id"];
	return {
		status: capture.status,
		...(requestId ? { requestId: truncate(requestId, 80) } : {}),
		quotaHeaders,
		...(capture.errorBody ? { errorBody: capture.errorBody } : {}),
		...(fingerprint ? { fingerprint } : {}),
	};
}

/** Only these statuses match the observed classifier-rejection signatures. */
function isDriftLike(status: number): boolean {
	return status === 400 || status === 429;
}

function interpretation(status: number): string {
	switch (status) {
		case 400: return "HTTP 400 on subscription OAuth inference is the observed prompt-classifier rejection signature (\"You're out of extra usage\"), but can also be a genuine invalid request; compare the provider error type below.";
		case 401: return "HTTP 401 means the access token is invalid, expired, or revoked. Run /login again or let Pi refresh it. This is an authentication failure, not gate drift.";
		case 403: return "HTTP 403 usually means a scope/permission or org-level restriction (for example extra usage disabled for the account). This is a permission failure, not necessarily gate drift.";
		case 429: return "HTTP 429 is either real rate limiting (check the quota headers below) or the observed generic-first-block rejection signature.";
		default: return `Unexpected status ${status}.`;
	}
}

const DRIFT_CHECKLIST = [
	"The canonical identity line may have changed; the first system block must equal it exactly:",
	`    ${CANONICAL_SYSTEM_LINE}`,
	"The classifier rules may have changed: prompt content that used to pass inside user messages may now be rejected.",
	"The header/beta contract may have changed; client-identity headers come from Pi's bundled Anthropic implementation when the key is a subscription OAuth access token.",
	"Billing attribution may now be required: requests without valid Claude Code attribution may be routed to account \"extra usage\" billing.",
	"Re-bisect one variable at a time; see the gate section of docs/domains/claude.md for the method.",
].join("\n");

function formatDrift(details: DriftDetails): string {
	const quotaReason = quotaExplanation(details.status, details.quotaHeaders);
	const driftLike = !quotaReason && isDriftLike(details.status);
	const lines: string[] = [];
	if (quotaReason) {
		lines.push(quotaReason);
		if (details.requestId) lines.push(`request-id: ${details.requestId}`);
		return lines.join("\n");
	}
	lines.push(driftLike
		? `Claude subscription request rejected (possible protocol drift): HTTP ${details.status}.`
		: `Claude subscription request rejected: HTTP ${details.status}.`);
	lines.push(interpretation(details.status));
	if (details.requestId) lines.push(`request-id: ${details.requestId}`);
	const quota = Object.entries(details.quotaHeaders);
	if (quota.length) {
		lines.push("quota headers:");
		for (const [name, value] of quota) lines.push(`    ${name}: ${value}`);
	} else if (isDriftLike(details.status)) {
		lines.push("quota headers: none present (their absence is a signal: genuine rate limits usually carry them).");
	}
	if (details.errorBody) {
		lines.push(`provider error type: ${details.errorBody.type ?? "(unparsed)"}`);
		if (details.errorBody.message) lines.push(`provider error message (truncated): ${details.errorBody.message}`);
	} else {
		lines.push("provider error body: not captured (unreadable or empty).");
	}
	const fp = details.fingerprint;
	if (fp) {
		lines.push("gated request fingerprint (structure only, no content):");
		lines.push(`    model: ${fp.model ?? "(unknown)"}`);
		lines.push(`    messages: ${fp.messageCount}, tools: ${fp.toolCount}, max_tokens: ${fp.maxTokens ?? "(unset)"}`);
		lines.push(`    system param: ${fp.systemIsString ? "string" : `${fp.systemBlockCount} block(s)`}, canonical match: ${fp.systemCanonicalMatch ? "yes" : "NO (the gate did not produce the canonical single block)"}`);
		lines.push(`    system-role messages remaining: ${fp.systemRoleMessages}${fp.systemRoleMessages > 0 ? " (the gate should have absorbed all of them)" : ""}`);
	}
	if (isDriftLike(details.status)) {
		lines.push("drift checklist:");
		lines.push(DRIFT_CHECKLIST);
	}
	return lines.join("\n");
}

/** Rich, credential-safe protocol-drift failure report. */
export class ProtocolDriftError extends Error {
	constructor(public readonly details: DriftDetails) {
		super(formatDrift(details));
		this.name = "ProtocolDriftError";
	}

	/** Machine-readable form for AssistantMessage.diagnostics (JSON-safe, no undefined). */
	toDiagnostic() {
		const d = this.details;
		const details: Record<string, unknown> = {
			status: d.status,
			classification: quotaExplanation(d.status, d.quotaHeaders) ? "usage_limit" : "unclassified_rejection",
			quotaHeaders: d.quotaHeaders,
			...(d.requestId ? { requestId: d.requestId } : {}),
			...(d.errorBody ? { errorBody: { ...d.errorBody } } : {}),
			...(d.fingerprint ? { fingerprint: { ...d.fingerprint } } : {}),
		};
		return {
			type: DRIFT_DIAGNOSTIC_TYPE,
			timestamp: Date.now(),
			error: { name: this.name, message: this.message },
			details: details as never,
		};
	}
}

/**
 * Replace a failed message's error text with the rich report and attach the
 * structured diagnostic. The SDK's original text is kept (redacted, truncated)
 * as a trailing line so nothing it said is lost.
 */
function enrichFailedMessage(
	message: { stopReason?: string; errorMessage?: string; diagnostics?: never[] },
	details: DriftDetails,
): void {
	const drift = new ProtocolDriftError(details);
	const original = message.errorMessage;
	message.errorMessage = original
		? `${drift.message}\noriginal error (redacted, truncated): ${truncate(original, ORIGINAL_ERROR_LIMIT)}`
		: drift.message;
	appendAssistantMessageDiagnostic(message as never, drift.toDiagnostic() as never);
}

/**
 * Forward every event of `inner` unchanged except the terminal `error` event
 * of a failed (not aborted) request, whose message is enriched first, so
 * consumers of both the event stream and result() see the rich report.
 * pi-ai event streams report failures as events and never throw while being
 * iterated, so the pump needs no error channel of its own.
 */
export function withDriftDiagnostics(
	inner: AsyncIterable<unknown>,
	capture: DriftCapture,
	getFingerprint: () => GateFingerprint | undefined,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of inner as AsyncIterable<{ type: string; reason?: string; error?: { stopReason?: string; errorMessage?: string } }>) {
				if (event.type === "error" && event.error && event.error.stopReason === "error") {
					const details = driftDetailsFromCapture(capture, getFingerprint());
					if (details) enrichFailedMessage(event.error as never, details);
				}
				out.push(event as never);
			}
		} finally {
			out.end();
		}
	})();
	return out;
}
