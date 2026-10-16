import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	apiKeyCredentials, browserUrl, HttpStatusError, record, requestJson,
	safeBaseUrl, validSecret, waitFor, pollUntil, type HttpOptions,
} from "../../shared/index.ts";

export const PROVIDER_ID = "spettro";
export const CATALOG_PLACEHOLDER = "spettro-catalog-loading";

/**
 * Catalog entry kept visible until a live, non-empty catalog replaces it.
 * Pi publishes whatever refreshModels returns as the whole model list, so an
 * empty return would erase the provider's discoverability.
 */
const placeholderModel: ProviderModelConfig = {
	id: CATALOG_PLACEHOLDER, name: "Sign in / refresh Spettro model catalog",
	input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000, maxTokens: 8192, compat: { supportsDeveloperRole: false },
};
interface Dependencies extends HttpOptions {
	streamSimple: NonNullable<ProviderConfig["streamSimple"]>;
	env?: Record<string, string | undefined>;
	now?: () => number;
	sleep?: typeof waitFor;
}

export function createSpettroProvider(deps: Dependencies): ProviderConfig {
	const base = safeBaseUrl(deps.env?.SPETTRO_API_URL?.trim() || "https://api.spettro.app");
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? waitFor;
	const json = (path: string, init: RequestInit, signal?: AbortSignal) =>
		requestJson(base + path, init, { fetchImpl: deps.fetchImpl, signal });

	return {
		name: "Spettro Subscription",
		baseUrl: base + "/v1",
		api: "openai-completions",
		authHeader: true,
		models: [placeholderModel],
		oauth: {
			name: "Spettro Subscription", isSubscription: true,
			login: async (callbacks) => {
				callbacks.signal?.throwIfAborted();
				const sessionId = crypto.randomUUID();
				const deadline = now() + 10 * 60 * 1000;
				const signal = callbacks.signal
					? AbortSignal.any([callbacks.signal, AbortSignal.timeout(10 * 60 * 1000)])
					: AbortSignal.timeout(10 * 60 * 1000);
				const initiated = record(await json("/auth/initiate", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ session_id: sessionId }),
				}, signal));
				callbacks.onAuth({ url: browserUrl(initiated.browser_url), instructions: "Sign in to Spettro in your browser; Pi will poll this session." });
				const key = await pollUntil<string>({
					deadline, intervalMs: 2000, delayFirst: true, signal, now, sleep,
					onPending: () => callbacks.onProgress?.("Waiting for Spettro sign-in…"),
					poll: async () => {
						let raw: unknown;
						try { raw = await json("/auth/poll/" + encodeURIComponent(sessionId), {}, signal); }
						catch (error) {
							if (error instanceof HttpStatusError && error.status === 404) throw new Error("Spettro login session expired; restart /login.");
							throw error;
						}
						const result = record(raw);
						if (result.status === "complete") {
							if (!validSecret(result.api_key)) throw new Error("Spettro completed login without a valid API key.");
							return { state: "complete", value: result.api_key };
						}
						if (result.status === "expired") throw new Error("Spettro login session expired; restart /login.");
						if (result.status !== "pending") throw new Error("Invalid Spettro login state.");
						return { state: "pending" };
					},
				});
				// Legacy compatibility: duplicate device key, not a real refresh token.
				return { ...apiKeyCredentials(key, now()), refresh: key };
			},
			refreshToken: async (credentials, signal) => { signal?.throwIfAborted(); return credentials; },
			getApiKey: (credentials) => credentials.access,
		},
		refreshModels: async (context) => {
			if (!context.allowNetwork) return [placeholderModel];
			const credentials = context.credential;
			const key = credentials && ("access" in credentials ? credentials.access : credentials.key);
			if (!validSecret(key)) return [placeholderModel];
			const payload = record(await json("/v1/models", { headers: { Authorization: "Bearer " + key } }, context.signal));
			if (!Array.isArray(payload.data)) throw new Error("Invalid Spettro catalog response.");
			const models: ProviderModelConfig[] = [];
			const seen = new Set<string>();
			for (const value of payload.data) {
				if (!value || typeof value !== "object" || Array.isArray(value)) continue;
				const entry = value as Record<string, unknown>;
				if (typeof entry.id !== "string" || !entry.id.trim() || seen.has(entry.id)) continue;
				seen.add(entry.id);
				models.push({
					id: entry.id, name: entry.id, api: "openai-completions", baseUrl: base + "/v1",
					input: entry.vision === true ? ["text", "image"] : ["text"], reasoning: entry.reasoning === true,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: typeof entry.context_window === "number" && Number.isSafeInteger(entry.context_window) && entry.context_window > 0 ? entry.context_window : 128000,
					maxTokens: 8192, compat: { supportsDeveloperRole: false },
				});
			}
			return models.length > 0 ? models : [placeholderModel];
		},
		streamSimple: (model, context, options) => {
			if (model.id === CATALOG_PLACEHOLDER) throw new Error("Spettro catalog not loaded; sign in and refresh models.");
			return deps.streamSimple({ ...model, baseUrl: base + "/v1" }, context, options);
		},
	};
}
