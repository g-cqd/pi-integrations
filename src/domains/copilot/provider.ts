import type { AnyModel } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { parseQuotaHeaders, type CopilotQuota } from "./usage.ts";
import { inferenceError, safeErrorHeaders } from "./errors.ts";
import { requestJson, validSecret } from "../../shared/index.ts";
import { API_ID, CATALOG_PLACEHOLDER, parseCatalog, placeholderModel, type ChatModelConfig } from "./catalog.ts";
import { exchangeCopilotToken, installationIdentity, loginCopilot, packCredential, unpackCredential, type Dependencies } from "./oauth.ts";
import { clientHeaders, copilotApiUrl, DEFAULT_API_URL } from "./protocol.ts";

export { API_ID, CATALOG_PLACEHOLDER };
export const PROVIDER_ID = "copilot-vscode";
export const DISPLAY_NAME = "Copilot — VS Code-style (experimental)";
interface ProviderDependencies extends Dependencies {
 onQuota?: (quota: CopilotQuota | undefined) => void;
 refreshPrices?: (signal?: AbortSignal) => Promise<void>;
 streamSimple: NonNullable<ProviderConfig["streamSimple"]> }

export function createCopilotProvider(deps: ProviderDependencies): ProviderConfig {
	const sessionId = crypto.randomUUID();
	const notifyQuota = (quota: CopilotQuota | undefined) => { try { deps.onQuota?.(quota); } catch {} };
	let nativeModels = new Map<string, ChatModelConfig>();
	// Pi dispatches extension streamers by API ID, not provider ID. Persist
	// native protocols, but expose only our custom API to prevent bypassing auth.
	const expose = (models: ChatModelConfig[]) => models.map(model => ({ ...model, api: API_ID }));
	const update = (models: ChatModelConfig[]) => { nativeModels = new Map(models.map(model => [model.id, model])); };
	return {
		name: DISPLAY_NAME, baseUrl: DEFAULT_API_URL, api: API_ID, models: [placeholderModel],
		oauth: {
			name: DISPLAY_NAME, isSubscription: true,
			login: callbacks => { notifyQuota(undefined); return loginCopilot(callbacks, deps); },
			refreshToken: (credential, signal) => exchangeCopilotToken(credential.refresh, installationIdentity(credential), { ...deps, signal }),
			getApiKey: packCredential,
		},
		refreshModels: async context => {
			if (!context.allowNetwork) {
				const stored = context.stored?.models;
				const restored = stored?.filter((m): m is AnyModel & ChatModelConfig =>
					(m.type === undefined || m.type === "chat") && Array.isArray(m.input) && m.id !== CATALOG_PLACEHOLDER &&
					["openai-completions", "openai-responses", "anthropic-messages"].includes(m.api));
				await context.publish({ update: () => update(restored ?? []) });
				return restored?.length ? expose(restored) : [placeholderModel];
			}
			const credential = context.credential;
			if (!credential || !("access" in credential) || !validSecret(credential.access)) return [placeholderModel];
			const apiUrl = copilotApiUrl(credential.apiUrl);
			const payload = await requestJson(`${apiUrl}/models`, {
				headers: { ...clientHeaders(installationIdentity(credential), sessionId), Accept: "application/json", Authorization: `Bearer ${credential.access}` },
			}, { fetchImpl: deps.fetchImpl, signal: context.signal });
			await deps.refreshPrices?.(context.signal);
			const models = parseCatalog(payload, apiUrl);
			// Persist the empty list too: a revoked catalog must not resurrect stale models.
			await context.publish({ persist: { models: models.map(model => ({ ...model, provider: PROVIDER_ID })) as AnyModel[], checkedAt: (deps.now ?? Date.now)() }, update: () => update(models) });
			return models.length ? expose(models) : [placeholderModel];
		},
		streamSimple: (model, context, options) => {
			if (model.id === CATALOG_PLACEHOLDER) throw new Error("Copilot catalog not loaded; sign in and refresh models.");
			options?.signal?.throwIfAborted();
			const credential = unpackCredential(options?.apiKey);
			const native = nativeModels.get(model.id);
			if (!native) throw new Error("Copilot model not in the account catalog; refresh models.");
			const path = native.api === "openai-completions" ? "/chat/completions"
				: native.api === "openai-responses" ? "/responses"
				: native.api === "anthropic-messages" ? "/v1/messages" : undefined;
			if (!path) throw new Error("Unsupported Copilot model protocol.");
			const headers = new Headers(options?.headers as HeadersInit);
			for (const [name, value] of Object.entries(clientHeaders(credential, options?.sessionId ?? sessionId))) headers.set(name, value);
			const last = context.messages.findLast(message => message.role !== "system");
			headers.set("X-Initiator", last?.role === "user" ? "user" : "agent");
			headers.set("OpenAI-Intent", "conversation-agent");
			const vision = context.messages.some(message => (message.role === "user" || message.role === "toolResult") &&
				Array.isArray(message.content) && message.content.some(part => part.type === "image"));
			if (vision) headers.set("Copilot-Vision-Request", "true");
			else headers.delete("Copilot-Vision-Request");
			headers.set("Authorization", `Bearer ${credential.token}`);
			headers.delete("x-api-key");
			const fetchImpl = options?.fetch ?? deps.fetchImpl ?? fetch;
			// Keep SDK defaults, callbacks and SSE conversion, but pin every outgoing
			// request to the credential endpoint; never follow redirects with tokens.
			const guardedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (url.origin !== credential.apiUrl || url.pathname !== path || url.username || url.password) throw new Error("Untrusted Copilot inference endpoint.");
				const outgoing = new Headers(input instanceof Request ? input.headers : undefined);
				new Headers(init?.headers).forEach((value, name) => outgoing.set(name, value));
				headers.forEach((value, name) => outgoing.set(name, value));
				outgoing.delete("x-api-key");
				outgoing.set("X-Request-Id", crypto.randomUUID());
				let response: Response;
				try { response = await fetchImpl(input, { ...init, headers: outgoing, redirect: "error" }); }
				catch { options?.signal?.throwIfAborted(); throw new Error("Copilot inference network request failed."); }
				// Observers must never interrupt streaming or turn a successful request
				// into a retry. Header absence invalidates the old balance.
				notifyQuota(parseQuotaHeaders(response.headers, (deps.now ?? Date.now)()));
				if (response.ok) return response;
				// Do not await cancellation: custom stream cancellation may reject or hang.
				void response.body?.cancel().catch(() => {});
				// SDK errors may include response bodies. Do not expose provider echoes.
				return new Response(JSON.stringify({ error: { message: inferenceError(response.status) } }), { status: response.status, headers: safeErrorHeaders(response.headers) });
			}) as typeof fetch;
			return deps.streamSimple({ ...model, api: native.api!, baseUrl: credential.apiUrl }, context, {
				...options, headers: Object.fromEntries(headers), fetch: guardedFetch, maxRetries: 0,
				apiKey: native.api === "anthropic-messages" ? undefined : credential.token,
			});
		},
	};
}
