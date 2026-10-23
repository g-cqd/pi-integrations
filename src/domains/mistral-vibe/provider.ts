/**
 * Browser sign-in protocol observed in Mistral's public Vibe source.
 * PKCE process -> browser approval -> poll -> API-key exchange, not OAuth refresh.
 */
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { generatePKCE } from "../../shared/pkce.ts";
import {
	apiKeyCredentials, trustedUrl, HttpStatusError, record, requestJson, validSecret, waitFor, pollUntil, type HttpOptions,
} from "../../shared/index.ts";

export const PROVIDER_ID = "mistral-vibe";

const API_BASE = "https://api.mistral.ai";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * The models Mistral's Vibe plan meters against the subscription. Large 4 and
 * Medium 3.5 are re-hosted from Pi's bundled Mistral catalog; the Z.ai GLM
 * models are declared inline because Pi's catalog does not carry them
 * (specs from `GET /v1/model-catalog?surface=vibe-code`).
 */
export const CATALOG_MODEL_IDS = ["mistral-large-4", "mistral-medium-latest"] as const;

const GLM_THINKING_LEVEL_MAP: NonNullable<Model<"mistral-conversations">["thinkingLevelMap"]> = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
};

export const VIBE_ONLY_MODELS: ProviderModelConfig[] = [
	{
		id: "zai-glm-5-3",
		name: "GLM 5.3",
		api: "mistral-conversations",
		baseUrl: API_BASE,
		reasoning: true,
		thinkingLevelMap: GLM_THINKING_LEVEL_MAP,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	},
	{
		id: "zai-glm-5-3-flash",
		name: "GLM 5.3 Flash",
		api: "mistral-conversations",
		baseUrl: API_BASE,
		reasoning: true,
		thinkingLevelMap: GLM_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	},
];

/**
 * Build the Vibe plan's model list from Pi's bundled Mistral catalog plus the
 * inline GLM entries. Catalog entries keep their metadata but drop
 * pay-as-you-go pricing: Vibe usage is metered against the subscription, not
 * per-token API credits. Throws if a catalog model is missing or ambiguous,
 * rather than offering something else.
 */
export function selectVibeModels<T extends { id: string }>(models: readonly T[]): (T | ProviderModelConfig)[] {
	const fromCatalog = CATALOG_MODEL_IDS.map((id) => {
		const matches = models.filter((model) => model.id === id);
		if (matches.length !== 1) {
			throw new Error(`Pi's Mistral catalog has no unique "${id}" entry (found ${matches.length}); update Pi or this domain.`);
		}
		return { ...matches[0], cost: ZERO_COST };
	});
	return [...fromCatalog, ...VIBE_ONLY_MODELS];
}
const CONSOLE = "https://console.mistral.ai";
const AUTH_API = CONSOLE + "/api";

interface Dependencies extends HttpOptions {
	models: NonNullable<ProviderConfig["models"]>;
	streamSimple: NonNullable<ProviderConfig["streamSimple"]>;
	now?: () => number;
	sleep?: typeof waitFor;
}

export function createMistralVibeProvider(deps: Dependencies): ProviderConfig {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? waitFor;
	const json = (url: string, init: RequestInit, signal?: AbortSignal) =>
		requestJson(url, init, { fetchImpl: deps.fetchImpl, signal });
	return {
		name: "Mistral Vibe (experimental)",
		baseUrl: API_BASE,
		api: "mistral-conversations",
		models: deps.models,
		streamSimple: deps.streamSimple,
		oauth: {
			// Pi uses its OAuth UI/storage compatibility layer for this browser flow.
			// The service returns an API key, not OAuth access/refresh tokens.
			name: "Mistral Vibe (experimental)",
			login: async (callbacks) => {
				callbacks.signal?.throwIfAborted();
				const { verifier, challenge } = await generatePKCE();
				callbacks.signal?.throwIfAborted();
				const total = AbortSignal.timeout(10 * 60 * 1000);
				const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, total]) : total;
				const startTime = now();
				const started = record(await json(AUTH_API + "/vibe/sign-in", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256" }),
				}, signal));
				if (typeof started.process_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(started.process_id)) throw new Error("Invalid Vibe sign-in process.");
				const signInUrl = trustedUrl(started.sign_in_url, CONSOLE);
				const pollUrl = trustedUrl(started.poll_url, AUTH_API);
				const expiry = typeof started.expires_at === "string" ? Date.parse(started.expires_at) : NaN;
				if (!Number.isFinite(expiry) || expiry <= now()) throw new Error("Invalid or expired Vibe sign-in process.");
				const deadline = Math.min(expiry, startTime + 10 * 60 * 1000);
				callbacks.onAuth({ url: signInUrl, instructions: "Sign in to Mistral in your browser. Pi will poll and exchange the approved process for an API key." });
				const exchangeToken = await pollUntil<string>({
					deadline, intervalMs: 3000, signal, now, sleep,
					onPending: () => callbacks.onProgress?.("Waiting for Mistral browser sign-in…"),
					poll: async () => {
						let raw: unknown;
						try { raw = await json(pollUrl, {}, signal); }
						catch (error) {
							if (error instanceof HttpStatusError && error.status === 410) throw new Error("Vibe browser sign-in expired; restart /login.");
							throw error;
						}
						const polled = record(raw);
						if (polled.status === "completed") {
							if (!validSecret(polled.exchange_token)) throw new Error("Vibe sign-in returned no valid exchange token.");
							return { state: "complete", value: polled.exchange_token };
						}
						if (polled.status === "denied") throw new Error("Vibe browser sign-in was denied.");
						if (polled.status === "expired") throw new Error("Vibe browser sign-in expired.");
						if (polled.status !== "pending") throw new Error("Vibe browser sign-in failed or returned an unknown state.");
						return { state: "pending" };
					},
				});
				signal.throwIfAborted();
				const exchanged = record(await json(AUTH_API + "/vibe/sign-in/" + encodeURIComponent(started.process_id) + "/exchange", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ exchange_token: exchangeToken, code_verifier: verifier }),
				}, signal));
				if (!validSecret(exchanged.api_key)) throw new Error("Vibe exchange returned no valid API key.");
				return apiKeyCredentials(exchanged.api_key, now());
			},
			refreshToken: async (credentials, signal) => { signal?.throwIfAborted(); return credentials; },
			getApiKey: (credentials) => credentials.access,
		},
	};
}
