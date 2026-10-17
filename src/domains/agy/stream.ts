/**
 * Inference for the Antigravity subscription over `cloudcode-pa`.
 *
 * Pi's built-in Google adapter cannot be used: it drives the @google/genai SDK
 * and rejects a custom fetch. So this builds the standard Gemini request with
 * Pi's own exported conversion helpers, wraps it in the v1internal envelope
 * (project, requestId, model, userAgent, requestType, request), streams
 * `:streamGenerateContent?alt=sse`, unwraps each `response`, and assembles Pi
 * events with the same semantics as the built-in adapter (text/thinking blocks,
 * tool calls with thought signatures, usage, stop reasons).
 *
 * The envelope field names come from descriptors embedded in the `agy` binary.
 * The client identity is verified for account/project discovery (the backend
 * gates on the User-Agent, which cloudcode.ts sets to the Antigravity client);
 * which optional fields the backend requires here remains unverified, and
 * rejections are described with a credential-safe report (see describeFailure).
 */
import {
	calculateCost, createAssistantMessageEventStream,
	type Model, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import {
	convertMessages, convertTools, isThinkingPart, mapStopReasonString, resolveGoogleFunctionCallingMode,
	retainThoughtSignature, supportsGoogleStrictToolSampling,
} from "@earendil-works/pi-ai/api/google-shared";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { iterateSse, validSecret, type FetchImplementation } from "../../shared/index.ts";
import { describeFailure, PROJECT_ID_RE, requestHeaders, USER_AGENT } from "./cloudcode.ts";

export const API_ID = "agy-cloudcode";
const HEADER_TIMEOUT_MS = 120_000;
const ERROR_BODY_LIMIT = 64 * 1024;
const BLOCK_REASON_RE = /^[A-Z_]{3,64}$/;

/** What getApiKey encodes: Pi passes only a string to the streamer, so the project rides along. */
export function encodeApiKey(token: string, projectId: string): string {
	return JSON.stringify({ token, projectId });
}

export function decodeApiKey(value: string | undefined): { token: string; projectId: string } {
	let parsed: unknown;
	try { parsed = value ? JSON.parse(value) : undefined; } catch { /* fall through */ }
	const p = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
	if (!p || !validSecret(p.token)) throw new Error("No Antigravity access token. Run /login.");
	if (typeof p.projectId !== "string" || !PROJECT_ID_RE.test(p.projectId)) {
		throw new Error("This Antigravity sign-in has no Cloud Code project. Run /login again.");
	}
	return { token: p.token, projectId: p.projectId };
}

type Json = Record<string, unknown>;

/** The inner, standard Gemini request. Mirrors the built-in adapter's parameter building. */
export function buildGeminiRequest(model: Model<never>, context: TranscriptContext, options: SimpleStreamOptions | undefined): Json {
	const normalized = collapseSystemMessages(context);
	const base = buildBaseOptions(model as never, normalized as never, options as never, undefined);
	const contents = convertMessages(model as never, normalized as never);
	const initialSystem = getInitialSystemMessage(normalized.messages as never);
	const tools = getCurrentTools(normalized.messages as never);

	const generationConfig: Json = {};
	if (base.temperature !== undefined) generationConfig.temperature = base.temperature;
	if (base.maxTokens !== undefined) generationConfig.maxOutputTokens = base.maxTokens;
	// The reasoning variant is chosen by the model id (for example "-high"), so only ask for thought parts.
	if (model.reasoning) generationConfig.thinkingConfig = { includeThoughts: true };

	const request: Json = { contents };
	const systemText = initialSystem ? getSystemMessageText(initialSystem as never) : "";
	if (systemText) request.systemInstruction = { parts: [{ text: sanitizeSurrogates(systemText) }] };
	if (tools.length > 0) {
		const strict = supportsGoogleStrictToolSampling(model.id);
		request.tools = convertTools(tools as never, false, strict);
		const mode = resolveGoogleFunctionCallingMode(tools as never, (options as { toolChoice?: string } | undefined)?.toolChoice, strict);
		if (mode !== undefined) request.toolConfig = { functionCallingConfig: { mode } };
	}
	if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
	return request;
}

export function buildEnvelope(model: Model<never>, request: Json, projectId: string, newId: () => string): Json {
	return {
		project: projectId,
		requestId: `pi-${newId()}`,
		model: model.id,
		userAgent: USER_AGENT,
		requestType: "agent",
		userPromptId: newId(),
		request,
	};
}

let toolCallCounter = 0;

interface Deps { baseUrl: string; fetchImpl?: FetchImplementation; now?: () => number; newId?: () => string }

/**
 * Read at most `limit` bytes of an error body, for a diagnostic message.
 *
 * The read is raced against `signal`: a provider can return a status and then
 * hold the connection open without sending the body, and `reader.read()` never
 * settles for a stream that is open but idle. Without this a stalled error
 * response would hang the caller with no way to recover.
 */
async function readBounded(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
	try {
		const reader = response.body?.getReader();
		if (!reader) return "";
		const chunks: Uint8Array[] = []; let size = 0;
		let onAbort: (() => void) | undefined;
		try {
			while (size < limit) {
				if (signal?.aborted) return "";
				const abortRace = new Promise<never>((_, reject) => {
					const listener = () => reject(signal?.reason ?? new Error("aborted"));
					onAbort = listener;
					if (signal?.aborted) listener();
					else signal?.addEventListener("abort", listener, { once: true });
				});
				const step = signal ? await Promise.race([reader.read(), abortRace]) : await reader.read();
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				if (step.done) break;
				chunks.push(step.value); size += step.value.byteLength;
			}
		} finally {
			if (onAbort && signal) signal.removeEventListener("abort", onAbort);
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		const bytes = new Uint8Array(size); let offset = 0;
		for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
		return new TextDecoder().decode(bytes).slice(0, limit);
	} catch { return ""; }
}

export function createAgyStreamSimple(deps: Deps): NonNullable<ProviderConfig["streamSimple"]> {
	const now = deps.now ?? Date.now;
	const newId = deps.newId ?? (() => crypto.randomUUID());
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const output: Json & { content: Array<Json>; usage: Json; stopReason: string } = {
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending", timestamp: now(),
		};
		const push = (event: unknown) => stream.push(event as never);
		(async () => {
			let cleanup: (() => void) | undefined;
			try {
				options?.signal?.throwIfAborted();
				const { token, projectId } = decodeApiKey(options?.apiKey);
				const request = buildGeminiRequest(model as never, context, options);
				let envelope: unknown = buildEnvelope(model as never, request, projectId, newId);
				const replaced = await options?.onPayload?.(envelope, model);
				if (replaced !== undefined) envelope = replaced;

				// Bound only the wait for response headers; the stream itself runs until done or aborted.
				const controller = new AbortController();
				const link = () => controller.abort(options?.signal?.reason);
				options?.signal?.addEventListener("abort", link, { once: true });
				cleanup = () => options?.signal?.removeEventListener("abort", link);
				const timer = setTimeout(() => controller.abort(new Error("Antigravity did not respond in time.")), HEADER_TIMEOUT_MS);
				let response: Response;
				try {
					response = await (deps.fetchImpl ?? fetch)(`${deps.baseUrl}/v1internal:streamGenerateContent?alt=sse`, {
						method: "POST",
						headers: { ...requestHeaders(token), Accept: "text/event-stream" },
						body: JSON.stringify(envelope), redirect: "error", signal: controller.signal,
					});
				} catch (error) {
					options?.signal?.throwIfAborted();
					if (controller.signal.aborted) throw new Error("Antigravity did not respond in time.");
					throw new Error("Antigravity network request failed.");
				} finally { clearTimeout(timer); }
				if (!response.ok) {
					throw new Error(describeFailure("Antigravity request", response.status, response.headers,
						await readBounded(response, ERROR_BODY_LIMIT, options?.signal)));
				}
				if (!response.body) throw new Error("Antigravity returned an empty stream.");
				push({ type: "start", partial: output });

				let current: ({ type: "text"; text: string; textSignature?: string } | { type: "thinking"; thinking: string; thinkingSignature?: string }) | null = null;
				const blocks = output.content;
				const index = () => blocks.length - 1;
				const closeCurrent = () => {
					if (!current) return;
					if (current.type === "text") push({ type: "text_end", contentIndex: index(), content: current.text, partial: output });
					else push({ type: "thinking_end", contentIndex: index(), content: current.thinking, partial: output });
					current = null;
				};

				for await (const sse of iterateSse(response.body, options?.signal)) {
					if (sse.data === "[DONE]") continue;
					let json: Json;
					try { json = JSON.parse(sse.data) as Json; } catch { throw new Error("Invalid Antigravity stream event."); }
					if (json.error && typeof json.error === "object") {
						throw new Error(describeFailure("Antigravity stream", 500, {}, JSON.stringify({ error: json.error })));
					}
					const chunk = (json.response && typeof json.response === "object" ? json.response : json) as Json;
					await options?.onProviderStreamEvent?.(chunk, model);
					if (typeof chunk.responseId === "string") output.responseId ||= chunk.responseId;

					const feedback = chunk.promptFeedback as { blockReason?: unknown } | undefined;
					if (typeof feedback?.blockReason === "string" && BLOCK_REASON_RE.test(feedback.blockReason) && feedback.blockReason !== "BLOCKED_REASON_UNSPECIFIED") {
						output.rawStopReason = feedback.blockReason;
						throw new Error(`The request was blocked by the provider (${feedback.blockReason}).`);
					}

					const candidate = (Array.isArray(chunk.candidates) ? chunk.candidates[0] : undefined) as Json | undefined;
					const parts = ((candidate?.content as Json | undefined)?.parts ?? []) as Array<Json>;
					for (const part of Array.isArray(parts) ? parts : []) {
						if (typeof part.text === "string") {
							const thinking = isThinkingPart(part as never);
							if (!current || (thinking && current.type !== "thinking") || (!thinking && current.type !== "text")) {
								closeCurrent();
								if (thinking) {
									current = { type: "thinking", thinking: "" };
									blocks.push(current);
									push({ type: "thinking_start", contentIndex: index(), partial: output });
								} else {
									current = { type: "text", text: "" };
									blocks.push(current);
									push({ type: "text_start", contentIndex: index(), partial: output });
								}
							}
							const signature = typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
							if (current.type === "thinking") {
								current.thinking += part.text;
								current.thinkingSignature = retainThoughtSignature(current.thinkingSignature, signature);
								push({ type: "thinking_delta", contentIndex: index(), delta: part.text, partial: output });
							} else {
								current.text += part.text;
								current.textSignature = retainThoughtSignature(current.textSignature, signature);
								push({ type: "text_delta", contentIndex: index(), delta: part.text, partial: output });
							}
						}
						const call = part.functionCall as { id?: unknown; name?: unknown; args?: unknown } | undefined;
						if (call && typeof call === "object") {
							closeCurrent();
							const provided = typeof call.id === "string" && call.id ? call.id : undefined;
							const duplicate = provided !== undefined && blocks.some((b) => b.type === "toolCall" && b.id === provided);
							const name = typeof call.name === "string" ? call.name : "";
							const id = provided && !duplicate ? provided : `${name}_${now()}_${++toolCallCounter}`;
							const toolCall = {
								type: "toolCall", id, name,
								arguments: call.args && typeof call.args === "object" ? call.args : {},
								...(typeof part.thoughtSignature === "string" && part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
							};
							blocks.push(toolCall);
							push({ type: "toolcall_start", contentIndex: index(), partial: output });
							push({ type: "toolcall_delta", contentIndex: index(), delta: JSON.stringify(toolCall.arguments), partial: output });
							push({ type: "toolcall_end", contentIndex: index(), toolCall, partial: output });
						}
					}
					if (typeof candidate?.finishReason === "string") {
						output.rawStopReason = candidate.finishReason;
						output.stopReason = mapStopReasonString(candidate.finishReason);
						if (blocks.some((b) => b.type === "toolCall") && output.stopReason === "stop") output.stopReason = "toolUse";
					}
					const usage = chunk.usageMetadata as Json | undefined;
					if (usage && typeof usage === "object") {
						const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
						output.usage = {
							input: n(usage.promptTokenCount) - n(usage.cachedContentTokenCount),
							output: n(usage.candidatesTokenCount) + n(usage.thoughtsTokenCount),
							cacheRead: n(usage.cachedContentTokenCount), cacheWrite: 0, reasoning: n(usage.thoughtsTokenCount),
							totalTokens: n(usage.totalTokenCount),
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						};
						calculateCost(model as never, output.usage as never);
					}
				}
				closeCurrent();
				options?.signal?.throwIfAborted();
				if (output.stopReason === "pending") throw new Error("The Antigravity stream ended without a finish reason.");
				if (output.stopReason === "aborted" || output.stopReason === "error") {
					throw new Error(output.rawStopReason ? `Provider stopped with: ${String(output.rawStopReason)}` : "An unknown error occurred");
				}
				push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
			} catch (error) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : "Antigravity request failed.";
				push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			} finally {
				cleanup?.();
			}
		})();
		return stream;
	};
}
